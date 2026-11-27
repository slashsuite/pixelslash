import { Buffer } from "node:buffer";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { Db } from "#/db/db";
import { createOrg, createProject } from "#/db/orgs";
import { signInGithubUser } from "#/db/users";

/** The tests' `MODEL_KEY_SECRET`: base64 of 32 fixed bytes. Never a real secret. */
export const TEST_MODEL_KEY_SECRET = Buffer.alloc(32, 7).toString("base64");

// A path, not a URL: under happy-dom the global `URL` is the DOM's, which `node:fs` does not take.
const MIGRATIONS = join(import.meta.dirname, "../../drizzle");

/**
 * The one store factory for the Vitest suites: each test builds its own store from here, and none
 * shares one with another test. `testDb()` is the in-memory default; `d1Db()` is the slower real
 * D1 for what SQLite does not enforce; `seededStore()` adds the user, org and projects most tests
 * start from.
 */

/**
 * An in-memory SQLite with the real migrations applied, behind the same async Drizzle API
 * D1 gives in production. Tests only: no network, no Cloudflare account. Runs under Bun (`bun --bun vitest`).
 * `beforeQuery` sees each statement before it runs and may run SQL of its own, to put a write
 * between a read and the write that follows it.
 */
export function testDb(beforeQuery?: (query: string, exec: (sql: string) => void) => void) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    for (const stmt of readFileSync(join(MIGRATIONS, file), "utf8").split(
      "--> statement-breakpoint",
    )) {
      sqlite.exec(stmt);
    }
  }
  const one = (query: string, params: SQLInputValue[], method: string) => {
    beforeQuery?.(query, (sql) => sqlite.exec(sql));
    const stmt = sqlite.prepare(query);
    // Arrays, not objects: a join selecting two `id` columns must keep both.
    stmt.setReturnArrays(true);
    if (method === "run") {
      stmt.run(...params);
      return { rows: [] };
    }
    const rows = stmt.all(...params).map((r) => Object.values(r));
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  };
  return drizzle(
    async (query, params, method) => one(query, params, method),
    // A batch is one transaction, as D1's is: a statement that throws undoes the ones before it.
    async (queries) => {
      sqlite.exec("BEGIN");
      try {
        const out = queries.map((q) => one(q.sql, q.params, q.method));
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  );
}

export type TestDb = ReturnType<typeof testDb>;

const CONFIG = join(import.meta.dirname, "../../wrangler.jsonc");

/**
 * A fresh local D1 (miniflare, through wrangler) with the real migrations applied. Slower than
 * `testDb()`, and only for what in-memory SQLite does not enforce: D1's limits, such as its 100
 * bound parameters per statement. Nothing is persisted; call `dispose` when done. `d1` is the
 * binding itself, for a test that wraps it. Wrangler loads only when a test asks for one.
 */
export async function d1Db(): Promise<{ db: Db; d1: D1Database; dispose: () => Promise<void> }> {
  const { getPlatformProxy } = await import("wrangler");
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: CONFIG, persist: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    for (const stmt of readFileSync(join(MIGRATIONS, file), "utf8").split(
      "--> statement-breakpoint",
    )) {
      if (stmt.trim()) await proxy.env.DB.prepare(stmt).run();
    }
  }
  return { db: drizzleD1(proxy.env.DB), d1: proxy.env.DB, dispose: () => proxy.dispose() };
}

/** Ada, the user a seeded store signs in. */
const ADA = { githubId: 1, login: "ada", name: null, avatarUrl: null };

/**
 * A fresh store (or `db`, for one built with a `beforeQuery` hook) holding Ada, her org `org` and
 * its `projects`, made in order. `project` is the first of them.
 */
export async function seededStore<D extends Db = TestDb>({
  db,
  org: orgName = "Acme",
  projects: names = ["web"],
}: { db?: D; org?: string; projects?: string[] } = {}) {
  const store = db ?? testDb();
  const user = await signInGithubUser(store, ADA);
  const org = await createOrg(store, user.id, orgName);
  const projects = [];
  for (const name of names) projects.push(await createProject(store, user.id, org.id, name));
  const [project] = projects;
  if (!project) throw new Error("a seeded store needs at least one project");
  return { db: store, user, org, project, projects };
}
