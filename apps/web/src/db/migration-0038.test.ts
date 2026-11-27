import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { getPlatformProxy } from "wrangler";
import { must } from "#/test/must";

/**
 * 0038 moves the PR comment's key from (project, PR) to (org, repo in lower case, PR): one comment
 * per pull request for all of an org's projects on the repo. Of the comments a PR already has, the
 * oldest is kept; the rest are no longer tracked. Applied as `wrangler d1 migrations apply` does it
 * (one file, one batch), on a D1 holding two projects' comments on one PR.
 */

const MIGRATIONS = new URL("../../drizzle/", import.meta.url);
const CONFIG = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
const FILES = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .toSorted();
const AT = FILES.findIndex((f) => f.startsWith("0038_"));

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => dispose?.());

async function d1(): Promise<D1Database> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: CONFIG, persist: false });
  dispose = () => proxy.dispose();
  return proxy.env.DB;
}

async function apply(db: D1Database, files: string[]): Promise<void> {
  for (const file of files) {
    const statements = readFileSync(new URL(file, MIGRATIONS), "utf8")
      .split("--> statement-breakpoint")
      .filter((s) => s.trim());
    await db.batch(statements.map((s) => db.prepare(s)));
  }
}

describe("migration 0038", () => {
  test("keeps the oldest comment of each PR under its org and repo, and drops the rest", async () => {
    const db = await d1();
    expect(AT).toBeGreaterThan(0);
    await apply(db, FILES.slice(0, AT));
    await db.batch([
      db.prepare("INSERT INTO orgs (id, name) VALUES ('o1', 'Acme')"),
      db.prepare(
        "INSERT INTO projects (id, org_id, name, github_repo) VALUES ('p1', 'o1', 'web', 'Acme/Web'), ('p2', 'o1', 'docs', 'acme/web'), ('p3', 'o1', 'gone', NULL)",
      ),
      db.prepare(
        "INSERT INTO pr_comments (project_id, pr_number, comment_id, created_at) VALUES ('p2', 7, 902, 2000), ('p1', 7, 901, 1000), ('p2', 8, 903, 3000), ('p3', 7, 904, 500)",
      ),
    ]);
    await apply(db, [must(FILES[AT], "the migration")]);

    const rows = await db
      .prepare("SELECT org_id, repo, pr_number, comment_id FROM pr_comments ORDER BY pr_number")
      .all();
    expect(rows.results).toEqual([
      { org_id: "o1", repo: "acme/web", pr_number: 7, comment_id: 901 },
      { org_id: "o1", repo: "acme/web", pr_number: 8, comment_id: 903 },
    ]);
  }, 60_000);
});
