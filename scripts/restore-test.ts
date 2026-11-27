#!/usr/bin/env bun
// The restore test for the daily D1 backup (.github/workflows/backup.yml).
//
// Usage: bun scripts/restore-test.ts [<key>]
//        bun scripts/restore-test.ts prepare <dump.sql> <out.sql>
//
// Takes the newest dump in the R2 bucket `pixelslash-backups` (or the key given), imports it into a new
// scratch D1 database, `pixelslash-restore-test`, and checks that every table holds as many rows as the
// dump has INSERTs for it. The scratch database is deleted at the end, pass or fail. It prints table
// names and counts only, never a row. Exits 0 when every check matches, 1 otherwise.
//
// `prepare` writes a downloaded, gunzipped dump in the order D1 can import (see importable below),
// for a real restore into a new database; it needs no credentials.
//
// A row too long for one D1 statement goes in as several (restore-dump.ts, splitRow); for each column
// that happened in, it also checks the column's total length against the dump's.
//
// It never touches the production database: wrangler runs in an empty temp dir with no config, so the
// only database it can name is the scratch one.
//
// Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_R2_TOKEN (reads the bucket) and CLOUDFLARE_D1_TOKEN (creates,
// imports into, queries and deletes the scratch database), the same names as the workflow's secrets.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { dumpCounts, importable, splitColumns } from "./restore-dump";

const BUCKET = "pixelslash-backups";
const PREFIX = "d1/pixelslash/";
const SCRATCH = "pixelslash-restore-test";

/** One number the restored database must match: a table's rows, or a split column's length. */
interface Check {
  label: string;
  sql: string;
  want: number;
}

const quote = (id: string): string => `"${id.replaceAll('"', '""')}"`;

/** The checks for a dump: every table's row count, then every split column's total length. */
export function checks(sql: string): Check[] {
  const rows = [...dumpCounts(sql)].map(([table, want]) => ({
    label: table,
    sql: `SELECT count(*) FROM ${quote(table)}`,
    want,
  }));
  const lengths = splitColumns(sql).map(({ table, col, length }) => ({
    label: `${table}.${col} length`,
    sql: `SELECT coalesce(sum(length(${quote(col)})), 0) FROM ${quote(table)}`,
    want: length,
  }));
  return [...rows, ...lengths];
}

/** The newest dump: keys carry the UTC time they were taken, so the greatest key is the latest. */
export function latestKey(keys: string[]): string | undefined {
  return keys
    .filter((k) => k.startsWith(PREFIX) && k.endsWith(".sql.gz"))
    .toSorted()
    .at(-1);
}

/**
 * One query for every check, as one row with a column per check (`c0`, `c1`, ... in the order
 * given). Scalar subqueries, not a UNION ALL: D1 refuses a compound SELECT with more than a few terms.
 */
export function countQuery(queries: string[]): string {
  return `SELECT ${queries.map((q, i) => `(${q}) AS c${i}`).join(", ")}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The numbers `wrangler d1 execute --json` printed for countQuery, in the order of its checks. */
export function parseCounts(out: string, n: number): (number | undefined)[] {
  const parsed: unknown = JSON.parse(out);
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
  const results: unknown = isRecord(first) ? first["results"] : undefined;
  const row: unknown = Array.isArray(results) ? results[0] : undefined;
  return Array.from({ length: n }, (_, i) => {
    const v = isRecord(row) ? row[`c${i}`] : undefined;
    return typeof v === "number" ? v : undefined;
  });
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** One page of the bucket's listing: its keys and the cursor of the next page ("" for none). */
function listPage(body: unknown): { keys: string[]; cursor: string } {
  const result: unknown = isRecord(body) ? body["result"] : undefined;
  if (!Array.isArray(result)) throw new Error(`listing ${BUCKET} returned no result`);
  const items: unknown[] = result;
  const keys = items.flatMap((o) =>
    isRecord(o) && typeof o["key"] === "string" ? [o["key"]] : [],
  );
  const info: unknown = isRecord(body) ? body["result_info"] : undefined;
  const more =
    isRecord(info) && info["is_truncated"] === true && typeof info["cursor"] === "string";
  return { keys, cursor: more && isRecord(info) ? String(info["cursor"]) : "" };
}

async function listKeys(account: string, token: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "";
  do {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${BUCKET}/objects`,
    );
    url.searchParams.set("prefix", PREFIX);
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`listing ${BUCKET} failed: HTTP ${res.status}`);
    const page = listPage(await res.json());
    keys.push(...page.keys);
    cursor = page.cursor;
  } while (cursor);
  return keys;
}

// apps/web's own wrangler, the version the workflow and the deploy run.
const WRANGLER = fileURLToPath(new URL("../apps/web/node_modules/.bin/wrangler", import.meta.url));

async function wrangler(cwd: string, token: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([WRANGLER, ...args], {
    cwd,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, WRANGLER_SEND_METRICS: "false" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // The exit code only: wrangler's output can quote the statement that failed, a row of the dump.
  if (code !== 0)
    throw new Error(`wrangler ${args.slice(0, 2).join(" ")} failed with exit ${code}`);
  return out;
}

/** Prints each check's dump and restored numbers; returns how many differ. */
function report(list: Check[], restored: (number | undefined)[]): number {
  let bad = 0;
  const width = Math.max(...list.map((c) => c.label.length));
  console.log(`${"table".padEnd(width)}  ${"dump".padStart(8)}  restored`);
  for (const [i, { label, want }] of list.entries()) {
    const got = restored[i];
    if (got !== want) bad++;
    const mark = got === want ? "" : "  MISMATCH";
    console.log(
      `${label.padEnd(width)}  ${String(want).padStart(8)}  ${String(got ?? "missing").padStart(8)}${mark}`,
    );
  }
  console.log(bad ? `FAIL: ${bad} check(s) differ` : `PASS: all ${list.length} checks match`);
  return bad;
}

interface Creds {
  account: string;
  r2: string;
  d1: string;
}

/** Downloads the dump into `dir`, writes it importable as dump.sql, and returns its checks. */
async function fetchDump(dir: string, creds: Creds, key: string): Promise<Check[]> {
  const gz = join(dir, "dump.sql.gz");
  await wrangler(dir, creds.r2, [
    "r2",
    "object",
    "get",
    `${BUCKET}/${key}`,
    "--file",
    gz,
    "--remote",
  ]);
  const sql = gunzipSync(await Bun.file(gz).bytes()).toString("utf8");
  await Bun.write(join(dir, "dump.sql"), importable(sql));
  const counts = dumpCounts(sql);
  console.log(
    `dump: ${counts.size} tables, ${[...counts.values()].reduce((a, b) => a + b, 0)} rows`,
  );
  return checks(sql);
}

/** Imports dump.sql into the scratch database and reads back each check's number. */
async function restore(dir: string, d1: string, list: Check[]): Promise<(number | undefined)[]> {
  await wrangler(dir, d1, [
    "d1",
    "execute",
    SCRATCH,
    "--remote",
    "--yes",
    "--file",
    join(dir, "dump.sql"),
  ]);
  console.log(`imported into ${SCRATCH}`);
  const out = await wrangler(dir, d1, [
    "d1",
    "execute",
    SCRATCH,
    "--remote",
    "--json",
    "--command",
    countQuery(list.map((c) => c.sql)),
  ]);
  return parseCounts(out, list.length);
}

/** Creates the scratch database, restores into it and checks it; deletes it, pass or fail. */
async function inScratch(dir: string, creds: Creds, key: string): Promise<number> {
  let created = false;
  try {
    const expected = await fetchDump(dir, creds, key);
    await wrangler(dir, creds.d1, ["d1", "create", SCRATCH, "--location", "weur"]);
    created = true;
    console.log(`created ${SCRATCH}`);
    return report(expected, await restore(dir, creds.d1, expected)) ? 1 : 0;
  } finally {
    if (created) {
      await wrangler(dir, creds.d1, ["d1", "delete", SCRATCH, "--skip-confirmation"]);
      console.log(`deleted ${SCRATCH}`);
    }
  }
}

async function restoreTest(creds: Creds, key: string): Promise<number> {
  // An empty dir with no wrangler config: no env, no binding, nothing but the names passed below.
  const dir = await mkdtemp(join(tmpdir(), "ps-restore-test-"));
  try {
    return await inScratch(dir, creds, key);
  } finally {
    // Its own finally: the dump in it is production data, removed even when the delete above fails.
    await rm(dir, { recursive: true, force: true });
  }
}

async function prepare(from: string | undefined, to: string | undefined): Promise<number> {
  if (!from || !to)
    throw new Error("usage: bun scripts/restore-test.ts prepare <dump.sql> <out.sql>");
  await Bun.write(to, importable(await Bun.file(from).text()));
  console.log(`wrote ${to}`);
  return 0;
}

async function main(): Promise<number> {
  const [, , first, ...rest] = Bun.argv;
  if (first === "prepare") return prepare(rest[0], rest[1]);
  const creds = {
    account: need("CLOUDFLARE_ACCOUNT_ID"),
    r2: need("CLOUDFLARE_R2_TOKEN"),
    d1: need("CLOUDFLARE_D1_TOKEN"),
  };
  const key = first ?? latestKey(await listKeys(creds.account, creds.r2));
  if (!key) throw new Error(`no dump under ${BUCKET}/${PREFIX}`);
  console.log(`dump: ${BUCKET}/${key}`);
  return restoreTest(creds, key);
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
