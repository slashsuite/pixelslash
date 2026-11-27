import { describe, expect, test } from "vitest";
import { inviteMember } from "./invites";
import { LastOwnerError, leaveOrg, removeMember } from "./members";
import { createOrg, listOrgs } from "./orgs";
import { invites as invitesTable } from "./schema-invites";
import { signInGithubUser } from "./users";
import { testDb } from "#/test/store";
import { must } from "#/test/must";

const profile = (githubId: number, login: string) => ({
  githubId,
  login,
  name: null,
  avatarUrl: null,
});

/** Alice owns Acme and Bob is its member; `beforeQuery` as in `testDb`. */
async function acme(beforeQuery?: Parameters<typeof testDb>[0]) {
  const db = testDb(beforeQuery);
  const alice = await signInGithubUser(db, profile(1, "alice"));
  const org = await createOrg(db, alice.id, "Acme");
  await inviteMember(db, alice, org.id, "bob");
  const bob = await signInGithubUser(db, profile(2, "bob"));
  const invites = async () => must((await listOrgs(db, alice.id))[0], "the org").invites;
  return { db, org, alice, bob, invites };
}

type Exec = (sql: string) => void;

/** A `beforeQuery` that, once armed, runs `then` before the next statement starting with `prefix`. */
function armed(prefix: string) {
  let then: ((exec: Exec) => void) | null = null;
  return {
    arm: (next: (exec: Exec) => void) => {
      then = next;
    },
    beforeQuery: (query: string, exec: Exec) => {
      if (!then || !query.startsWith(prefix)) return;
      const run = then;
      then = null;
      run(exec);
    },
  };
}

describe("leaving and removal take the invites with them", () => {
  test("a member who leaves keeps no invite to rejoin by", async () => {
    const { db, org, alice, bob, invites } = await acme();
    // An invite naming him written before invites for members were refused.
    await db
      .insert(invitesTable)
      .values({ id: "old", orgId: org.id, githubLogin: "bob", invitedBy: alice.id });
    await leaveOrg(db, bob.id, org.id);
    expect(await invites()).toEqual([]);
    await signInGithubUser(db, profile(2, "bob"));
    expect(await listOrgs(db, bob.id)).toEqual([]);
  });

  test("a refused leave (the last owner) keeps the invites naming them", async () => {
    const { db, org, alice, invites } = await acme();
    await inviteMember(db, alice, org.id, "alice@example.com");
    await expect(leaveOrg(db, alice.id, org.id)).rejects.toThrow(LastOwnerError);
    expect((await invites()).map((i) => i.email)).toEqual(["alice@example.com"]);
  });

  test("a removal that fails part way leaves the member and the invites as they were", async () => {
    const hook = armed('delete from "invites"');
    const { db, org, alice, bob, invites } = await acme(hook.beforeQuery);
    await inviteMember(db, bob, org.id, "carol");
    hook.arm(() => {
      throw new Error("D1 went away");
    });
    await expect(removeMember(db, alice.id, org.id, bob.id)).rejects.toThrow("D1 went away");
    expect(must((await listOrgs(db, bob.id))[0], "Bob's org").id).toBe(org.id);
    expect((await invites()).map((i) => i.githubLogin)).toEqual(["carol"]);
  });

  test("an invite is not written once its sender has been removed", async () => {
    const hook = armed('insert into "invites"');
    const { db, org, bob, invites } = await acme(hook.beforeQuery);
    hook.arm((exec) =>
      exec(`DELETE FROM members WHERE org_id = '${org.id}' AND user_id = '${bob.id}'`),
    );
    await inviteMember(db, bob, org.id, "carol");
    expect(await invites()).toEqual([]);
  });
});
