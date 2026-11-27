import { describe, expect, test, vi } from "vitest";
import { MAX_STATEMENT, dumpCounts, importable, splitRow } from "../restore-dump";
import { checks, countQuery, latestKey, parseCounts, withScratch } from "../restore-test";

/** A wrangler stand-in: records each subcommand, and throws for the ones named in `fail`. */
function runner(...fail: string[]) {
  const calls: string[] = [];
  const run = (args: string[]): Promise<string> => {
    const sub = args.slice(0, 2).join(" ");
    calls.push(sub);
    return fail.includes(sub) ? Promise.reject(new Error(`${sub} failed`)) : Promise.resolve("");
  };
  return { calls, run };
}

const pass = (): Promise<number> => Promise.resolve(0);
const importFails = (): Promise<number> => Promise.reject(new Error("import failed"));

describe("restore-test", () => {
  test("counts one INSERT a row, per table, and keeps empty tables", () => {
    const sql = [
      "PRAGMA defer_foreign_keys=TRUE;",
      'CREATE TABLE "builds" (id text primary key);',
      "CREATE TABLE IF NOT EXISTS shots (id text);",
      'CREATE TABLE "empty" (id text);',
      'INSERT INTO "builds" ("id") VALUES(\'a\');',
      'INSERT INTO "builds" ("id") VALUES(\'b\');',
      "INSERT INTO shots VALUES('x');",
      "CREATE INDEX i ON shots(id);",
    ].join("\n");
    expect(Object.fromEntries(dumpCounts(sql))).toEqual({ builds: 2, shots: 1, empty: 0 });
  });

  test("unquotes a doubled quote in a table name", () => {
    const sql = 'CREATE TABLE "a""b" (x);\nINSERT INTO "a""b" VALUES(1);';
    expect(Object.fromEntries(dumpCounts(sql))).toEqual({ 'a"b': 1 });
  });

  test("a row value that only looks like an INSERT is not counted", () => {
    const sql = 'CREATE TABLE "t" (x);\nINSERT INTO "t" VALUES(\'INSERT INTO "t" VALUES(1)\');';
    expect(dumpCounts(sql).get("t")).toBe(1);
  });

  test("moves every CREATE TABLE ahead of the rows, the rest in order", () => {
    const sql = [
      "PRAGMA defer_foreign_keys=TRUE;",
      "CREATE TABLE `builds` (",
      "\t`project_id` text REFERENCES `projects`(`id`)",
      ");",
      "INSERT INTO \"builds\" VALUES('p');",
      "CREATE TABLE `projects` (`id` text);",
      "INSERT INTO \"projects\" VALUES('p');",
      "DELETE FROM sqlite_sequence;",
      "CREATE INDEX i ON `builds` (`project_id`);",
    ].join("\n");
    expect(importable(sql).split("\n")).toEqual([
      "PRAGMA defer_foreign_keys=TRUE;",
      "CREATE TABLE `builds` (",
      "\t`project_id` text REFERENCES `projects`(`id`)",
      ");",
      "CREATE TABLE `projects` (`id` text);",
      "INSERT INTO \"projects\" VALUES('p');",
      "INSERT INTO \"builds\" VALUES('p');",
      "DELETE FROM sqlite_sequence;",
      "CREATE INDEX i ON `builds` (`project_id`);",
    ]);
  });

  test("a self-reference or a cycle keeps the export's order", () => {
    const sql = [
      "CREATE TABLE a (id text, b text REFERENCES b(id), p text REFERENCES a(id));",
      "INSERT INTO a VALUES(1);",
      "CREATE TABLE b (id text, a text REFERENCES a(id));",
      "INSERT INTO b VALUES(2);",
    ].join("\n");
    expect(importable(sql).split("\n").slice(2)).toEqual([
      "INSERT INTO a VALUES(1);",
      "INSERT INTO b VALUES(2);",
    ]);
  });

  test("a row over D1's limit becomes an INSERT and appends, each under it, that rebuild it", () => {
    const big = "x".repeat(60_000) + "it''s" + "é".repeat(30_000);
    const line = `INSERT INTO "b" ("id","t","n") VALUES('k1','${big}',fn(1, 2));`;
    const parts = splitRow(line);
    expect(parts[0]).toBe(`INSERT INTO "b" ("id","t","n") VALUES('k1','',fn(1, 2));`);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(MAX_STATEMENT);
    const pieces = parts.slice(1).map((p) => {
      expect(p.startsWith(`UPDATE "b" SET "t" = "t" || '`)).toBe(true);
      expect(p.endsWith(`' WHERE rowid = last_insert_rowid();`)).toBe(true);
      return p.slice(
        `UPDATE "b" SET "t" = "t" || '`.length,
        -`' WHERE rowid = last_insert_rowid();`.length,
      );
    });
    expect(pieces.join("")).toBe(big);
    expect(splitRow("INSERT INTO t VALUES(1);")).toEqual(["INSERT INTO t VALUES(1);"]);
  });

  test("the latest key is the newest dump under the prefix", () => {
    expect(
      latestKey([
        "d1/pixelslash/2026-11-27T034100Z.sql.gz",
        "d1/pixelslash/2026-11-28T034100Z.sql.gz",
        "d1/pixelslash/2026-11-28T034100Z.sql",
        "other/2027-01-01T000000Z.sql.gz",
      ]),
    ).toBe("d1/pixelslash/2026-11-28T034100Z.sql.gz");
    expect(latestKey([])).toBeUndefined();
  });

  test("checks every table's rows and each split column's total length, in one query", () => {
    const big = "x".repeat(100_000);
    const sql = [
      'CREATE TABLE "b""c" (id, t);',
      `INSERT INTO "b""c" ("id","t") VALUES('k1','${big}');`,
      `INSERT INTO "b""c" ("id","t") VALUES('k2','it''s é');`,
      'INSERT INTO "b""c" ("id","t") VALUES(\'k3\',NULL);',
      "CREATE TABLE a (id);",
    ].join("\n");
    const list = checks(sql);
    expect(list.map((c) => [c.label, c.want])).toEqual([
      ['b"c', 3],
      ["a", 0],
      ['b"c.t length', 100_006],
    ]);
    expect(countQuery(list.map((c) => c.sql))).toBe(
      'SELECT (SELECT count(*) FROM "b""c") AS c0, (SELECT count(*) FROM "a") AS c1, ' +
        '(SELECT coalesce(sum(length("t")), 0) FROM "b""c") AS c2',
    );
  });

  describe("the scratch database", () => {
    test("is deleted after a pass", async () => {
      const { calls, run } = runner();
      await expect(withScratch(run, pass)).resolves.toBe(0);
      expect(calls).toEqual(["d1 create", "d1 delete"]);
    });

    test("is deleted when the restore fails", async () => {
      const { calls, run } = runner();
      await expect(withScratch(run, importFails)).rejects.toThrow("import failed");
      expect(calls).toEqual(["d1 create", "d1 delete"]);
    });

    test("is deleted by name when the create throws, which may have made it", async () => {
      const { calls, run } = runner("d1 create");
      const body = vi.fn<() => Promise<number>>(pass);
      await expect(withScratch(run, body)).rejects.toThrow("d1 create failed");
      expect(body).not.toHaveBeenCalled();
      expect(calls).toEqual(["d1 create", "d1 delete"]);
    });

    test("a failed create keeps its own error when there was nothing to delete", async () => {
      const { calls, run } = runner("d1 create", "d1 delete");
      await expect(withScratch(run, pass)).rejects.toThrow("d1 create failed");
      expect(calls).toEqual(["d1 create", "d1 delete"]);
    });

    test("a failed delete after a create that returned fails the run", async () => {
      const { run } = runner("d1 delete");
      await expect(withScratch(run, pass)).rejects.toThrow("d1 delete failed");
    });
  });

  test("reads the counts back by column, and a missing one as undefined", () => {
    const out = JSON.stringify([{ results: [{ c0: 3, c1: 0 }], success: true }]);
    expect(parseCounts(out, 3)).toEqual([3, 0, undefined]);
    expect(parseCounts("[]", 1)).toEqual([undefined]);
  });
});
