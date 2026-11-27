import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { getPlatformProxy } from "wrangler";

/**
 * 0042 gives every membership a role. Applied the way `wrangler d1 migrations apply` does it (one
 * file, one batch), on a D1 already holding memberships: each org's earliest member becomes its
 * owner, and every other member is a `member`. Afterwards a membership written with no role (the
 * Worker before 0042, while a deploy runs) is a `member`, unless its org has no owner: then it is.
 */

const MIGRATIONS = new URL("../../drizzle/", import.meta.url);
const CONFIG = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
const FILES = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .toSorted();
const ROLES = FILES.findIndex((f) => f.startsWith("0042_"));

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

const roles = async (db: D1Database) =>
  (
    await db
      .prepare("SELECT org_id, user_id, role FROM members ORDER BY org_id, user_id")
      .all<{ org_id: string; user_id: string; role: string }>()
  ).results.map((r) => `${r.org_id} ${r.user_id} ${r.role}`);

describe("migration 0042", () => {
  test("the earliest member of each org becomes its owner, and a later member is a member unless the org has no owner", async () => {
    const db = await d1();
    expect(ROLES).toBeGreaterThan(0);
    await apply(db, FILES.slice(0, ROLES));
    await db.batch([
      db.prepare(
        "INSERT INTO users (id, github_id, login) VALUES ('u1', 1, 'a'), ('u2', 2, 'b'), ('u3', 3, 'c'), ('u4', 4, 'd')",
      ),
      db.prepare(
        "INSERT INTO orgs (id, name) VALUES ('o1', 'Acme'), ('o2', 'Tie'), ('o3', 'Empty')",
      ),
      // Acme: u2 joined first. Tie: u3 and u1 joined in the same millisecond, so the user id decides.
      db.prepare(
        "INSERT INTO members (org_id, user_id, created_at) VALUES ('o1', 'u1', 2000), ('o1', 'u2', 1000), ('o1', 'u3', 3000), ('o2', 'u3', 500), ('o2', 'u1', 500)",
      ),
    ]);

    await apply(db, FILES.slice(ROLES));

    expect(await roles(db)).toEqual([
      "o1 u1 member",
      "o1 u2 owner",
      "o1 u3 member",
      "o2 u1 owner",
      "o2 u3 member",
    ]);
    // The old createOrg: the creator of a new org, with no role given, is still its owner.
    await db.prepare("INSERT INTO members (org_id, user_id) VALUES ('o3', 'u4')").run();
    await db
      .prepare("INSERT INTO members (org_id, user_id) VALUES ('o3', 'u1'), ('o1', 'u4')")
      .run();
    expect(await roles(db)).toEqual(
      expect.arrayContaining(["o3 u4 owner", "o3 u1 member", "o1 u4 member"]),
    );
  }, 60_000);
});
