import { describe, expect, test } from "vitest";
import { randomToken } from "#/lib/crypto";
import { actorProjects, actorUser } from "./actor";
import { orgs, members, projects, userTokens, users } from "./schema";
import { SMOKE, smokeAccountSql } from "./smoke-account";
import { testDb } from "./test-db";
import { verifyUserToken } from "./tokens";

/** A migrated database with the given SQL texts applied, in order, before the first query. */
function dbWith(...texts: string[]) {
  let applied = false;
  return testDb((_query, exec) => {
    if (applied) return;
    applied = true;
    for (const text of texts) exec(text);
  });
}

const count = async (db: ReturnType<typeof testDb>) => ({
  users: (await db.select().from(users)).length,
  orgs: (await db.select().from(orgs)).length,
  members: (await db.select().from(members)).length,
  projects: (await db.select().from(projects)).length,
  tokens: (await db.select().from(userTokens)).length,
});

describe("smokeAccountSql", () => {
  test("makes a user whose token sees its own synthetic org's project", async () => {
    const token = randomToken("psu_");
    const db = dbWith(await smokeAccountSql(token));
    const user = await verifyUserToken(db, token);
    expect(user).toEqual({ userId: SMOKE.userId });
    expect((await actorUser(db, SMOKE.userId)).login).toBe(SMOKE.login);
    const seen = await actorProjects(db, { kind: "user", userId: SMOKE.userId });
    expect(seen.map((p) => [p.id, p.org.id])).toEqual([[SMOKE.projectId, SMOKE.orgId]]);
    const [org] = await db.select().from(orgs);
    expect(org?.isSmoke).toBe(true);
  });

  test("applied again with a new token adds no row, and only the new token works", async () => {
    const first = randomToken("psu_");
    const second = randomToken("psu_");
    const db = dbWith(await smokeAccountSql(first), await smokeAccountSql(second));
    expect(await count(db)).toEqual({ users: 1, orgs: 1, members: 1, projects: 1, tokens: 1 });
    expect(await verifyUserToken(db, first)).toBeNull();
    expect(await verifyUserToken(db, second)).toEqual({ userId: SMOKE.userId });
  });

  test("holds the hash, never the token, and refuses a token of another kind", async () => {
    const token = randomToken("psu_");
    expect(await smokeAccountSql(token)).not.toContain(token);
    await expect(smokeAccountSql(randomToken("psci_"))).rejects.toThrow(/psu_/);
  });
});
