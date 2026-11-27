import { describe, expect, test } from "vitest";
import { ForbiddenError, NotFoundError } from "./db";
import { LastOwnerError, leaveOrg, removeMember, setMemberRole } from "./members";
import { clearOrgModel, setOrgModel } from "./models";
import { createOrg, createProject, getProject, getProjectWithOrg, listOrgs } from "./orgs";
import { inviteMember, withdrawInvite } from "./invites";
import { issueOrgToken, listOrgTokens, revokeOrgToken } from "./tokens";
import { builds, snapshots } from "./schema";
import { TEST_MODEL_KEY_SECRET, testDb } from "#/test/store";
import { signInGithubUser } from "./users";
import { must } from "#/test/must";

const profile = (githubId: number, login: string) => ({
  githubId,
  login,
  name: null,
  avatarUrl: null,
});

describe("org isolation", () => {
  test("a member of org A cannot read or write org B's projects", async () => {
    const db = testDb();
    const alice = await signInGithubUser(db, profile(1, "alice"));
    const bob = await signInGithubUser(db, profile(2, "bob"));
    const orgA = await createOrg(db, alice.id, "A");
    const orgB = await createOrg(db, bob.id, "B");
    const projectB = await createProject(db, bob.id, orgB.id, "b-web");

    await expect(getProject(db, alice.id, projectB.id)).rejects.toThrow(NotFoundError);
    await expect(createProject(db, alice.id, orgB.id, "sneaky")).rejects.toThrow(NotFoundError);
    await expect(inviteMember(db, alice, orgB.id, "alice")).rejects.toThrow(NotFoundError);
    expect((await listOrgs(db, alice.id)).map((o) => o.id)).toEqual([orgA.id]);
    expect(await getProject(db, bob.id, projectB.id)).toEqual(projectB);
  });

  test("a project comes with its org's name, and only for a member", async () => {
    const db = testDb();
    const alice = await signInGithubUser(db, profile(1, "alice"));
    const bob = await signInGithubUser(db, profile(2, "bob"));
    const org = await createOrg(db, alice.id, "Acme");
    const project = await createProject(db, alice.id, org.id, "web");

    expect(await getProjectWithOrg(db, alice.id, project.id)).toEqual({
      project: { ...project, parent: null },
      org: { id: org.id, name: "Acme" },
    });
    await expect(getProjectWithOrg(db, bob.id, project.id)).rejects.toThrow(NotFoundError);
  });

  test("an invite becomes a membership when that GitHub login signs in", async () => {
    const db = testDb();
    const alice = await signInGithubUser(db, profile(1, "alice"));
    const org = await createOrg(db, alice.id, "A");
    const project = await createProject(db, alice.id, org.id, "web");
    await inviteMember(db, alice, org.id, "Carol");

    const carol = await signInGithubUser(db, profile(3, "carol"));

    expect(await getProject(db, carol.id, project.id)).toEqual(project);
    expect(await listOrgs(db, carol.id)).toEqual([
      expect.objectContaining({
        id: org.id,
        projects: [{ ...project, latest: null, parentName: null }],
      }),
    ]);
  });

  test("orgs and projects sort by name ignoring case", async () => {
    const db = testDb();
    const alice = await signInGithubUser(db, profile(1, "alice"));
    const zed = await createOrg(db, alice.id, "Zed Studio");
    const hack = await createOrg(db, alice.id, "hackcove");
    const pixel = await createOrg(db, alice.id, "Pixel Labs");
    const web = await createProject(db, alice.id, hack.id, "Web");
    const api = await createProject(db, alice.id, hack.id, "api");

    const orgs = await listOrgs(db, alice.id);

    expect(orgs.map((o) => o.id)).toEqual([hack.id, pixel.id, zed.id]);
    expect(orgs[0]?.projects.map((p) => p.id)).toEqual([api.id, web.id]);
  });
});

type Seed = { diffStatus: "changed" | "new" | "unchanged" | null; reviewState?: "accepted" };

/** A build with the given shots, written straight to the tables: these tests read, they do not diff. */
async function seedBuild(
  db: ReturnType<typeof testDb>,
  build: { projectId: string; id: string; at: number; branch?: string },
  shots: Seed[],
) {
  const { projectId, id, at, branch = "main" } = build;
  await db.insert(builds).values({
    id,
    projectId,
    commitSha: id.padEnd(40, "0"),
    branch,
    prNumber: branch === "main" ? null : 7,
    status: "changes",
    createdAt: new Date(at),
  });
  for (const [i, shot] of shots.entries()) {
    await db.insert(snapshots).values({
      id: `${id}-${i}`,
      buildId: id,
      name: `shot-${i}`,
      platform: "linux",
      browser: "chromium",
      viewport: "1280x720",
      theme: "light",
      envFingerprint: "env",
      imageKey: `${id}-${i}.png`,
      ...shot,
    });
  }
}

describe("the organizations overview", () => {
  test("each project carries its latest build and what the shots came to", async () => {
    const db = testDb();
    const alice = await signInGithubUser(db, profile(1, "alice"));
    const org = await createOrg(db, alice.id, "Acme");
    const web = await createProject(db, alice.id, org.id, "web");
    const docs = await createProject(db, alice.id, org.id, "docs");
    await createProject(db, alice.id, org.id, "idle");
    await seedBuild(db, { projectId: web.id, id: "old", at: 1000 }, [{ diffStatus: "changed" }]);
    await seedBuild(db, { projectId: web.id, id: "new", at: 2000, branch: "feat/x" }, [
      { diffStatus: "changed" },
      { diffStatus: "changed", reviewState: "accepted" },
      { diffStatus: "new" },
      { diffStatus: "unchanged" },
      { diffStatus: null },
    ]);
    await seedBuild(db, { projectId: docs.id, id: "d1", at: 1500 }, [{ diffStatus: "unchanged" }]);

    const [overview] = await listOrgs(db, alice.id);
    const byName = Object.fromEntries(
      must(overview, "the overview").projects.map((p) => [p.name, p]),
    );

    expect(byName["web"]?.latest).toMatchObject({
      id: "new",
      branch: "feat/x",
      prNumber: 7,
      total: 5,
      counts: { changed: 2, new: 1, unchanged: 1, unmeasured: 1, toReview: 2 },
    });
    expect(byName["docs"]?.latest?.counts.toReview).toBe(0);
    expect(byName["idle"]?.latest).toBeNull();
    // The badge counts projects whose *latest* build is waiting, not shots: only web is.
    expect(overview?.waiting).toBe(1);
  });

  test("members and pending invites are listed, and an invite can be withdrawn", async () => {
    const db = testDb();
    const alice = await signInGithubUser(db, profile(1, "alice"));
    const org = await createOrg(db, alice.id, "Acme");
    await inviteMember(db, alice, org.id, "Carol");

    const [before] = await listOrgs(db, alice.id);
    expect(before?.members.map((m) => m.login)).toEqual(["alice"]);
    expect(before?.invites).toEqual([expect.objectContaining({ githubLogin: "carol" })]);

    const pending = must(before?.invites[0], "the pending invite");
    await withdrawInvite(db, alice.id, org.id, pending.id);
    expect((await listOrgs(db, alice.id))[0]?.invites).toEqual([]);
    // Withdrawn, so signing in does not join the org.
    const carol = await signInGithubUser(db, profile(3, "carol"));
    expect(await listOrgs(db, carol.id)).toEqual([]);
  });

  test("another org's member cannot withdraw an invite, and a missing id is a 404", async () => {
    const db = testDb();
    const alice = await signInGithubUser(db, profile(1, "alice"));
    const bob = await signInGithubUser(db, profile(2, "bob"));
    const orgA = await createOrg(db, alice.id, "A");
    const orgB = await createOrg(db, bob.id, "B");
    await inviteMember(db, alice, orgA.id, "carol");
    const pending = must((await listOrgs(db, alice.id))[0]?.invites[0], "the pending invite");

    await expect(withdrawInvite(db, bob.id, orgA.id, pending.id)).rejects.toThrow(NotFoundError);
    // Bob is a member of B, but the invite belongs to A.
    await expect(withdrawInvite(db, bob.id, orgB.id, pending.id)).rejects.toThrow(NotFoundError);
    expect((await listOrgs(db, alice.id))[0]?.invites).toHaveLength(1);
  });
});

/** Alice made the org, so owns it; Bob joined it by invite, so is a member; Eve is in another org. */
async function acmeOrg() {
  const db = testDb();
  const alice = await signInGithubUser(db, profile(1, "alice"));
  const org = await createOrg(db, alice.id, "Acme");
  await inviteMember(db, alice, org.id, "bob");
  const bob = await signInGithubUser(db, profile(2, "bob"));
  const eve = await signInGithubUser(db, profile(3, "eve"));
  await createOrg(db, eve.id, "Elsewhere");
  return { db, org, alice, bob, eve };
}

const roles = async (db: ReturnType<typeof testDb>, userId: string) =>
  Object.fromEntries(
    must((await listOrgs(db, userId))[0], "the org").members.map((m) => [m.login, m.role]),
  );

const MODEL = {
  baseUrl: "https://org.example/v1",
  model: "org-model",
  apiKey: "sk-org",
  autoPassNoise: false,
  modelKeySecret: TEST_MODEL_KEY_SECRET,
  modelHosts: { allowPrivate: false, resolve: async () => ["203.0.113.10"] },
};

describe("roles", () => {
  test("the creator is the owner, and an invite joins as a member", async () => {
    const { db, alice } = await acmeOrg();
    expect(await roles(db, alice.id)).toEqual({ alice: "owner", bob: "member" });
  });

  test("every owner-only action is refused for a member (403) and for a non-member (404)", async () => {
    const { db, org, alice, bob, eve } = await acmeOrg();
    const { id: tokenId } = await issueOrgToken(db, alice.id, org.id, "ci");
    const ownerOnly = (userId: string) => [
      removeMember(db, userId, org.id, alice.id),
      setMemberRole(db, userId, { orgId: org.id, userId: bob.id }, "owner"),
      issueOrgToken(db, userId, org.id, "mine"),
      revokeOrgToken(db, userId, tokenId),
      setOrgModel(db, userId, org.id, MODEL),
      clearOrgModel(db, userId, org.id),
    ];
    for (const refused of ownerOnly(bob.id)) {
      await expect(refused).rejects.toThrow(ForbiddenError);
    }
    for (const refused of ownerOnly(eve.id)) await expect(refused).rejects.toThrow(NotFoundError);
    // Nothing changed: Alice still owns it, Bob is still a member, the token is live.
    expect(await roles(db, alice.id)).toEqual({ alice: "owner", bob: "member" });
    expect((await listOrgTokens(db, alice.id)).map((t) => [t.name, t.revokedAt])).toEqual([
      ["ci", null],
    ]);
    await expect(removeMember(db, bob.id, org.id, alice.id)).rejects.toThrow(
      "Only an owner of this organization can do that.",
    );
  });

  test("any member can invite and withdraw an invite", async () => {
    const { db, org, bob } = await acmeOrg();
    await inviteMember(db, bob, org.id, "carol");
    const pending = must((await listOrgs(db, bob.id))[0]?.invites[0], "Bob's invite");
    await withdrawInvite(db, bob.id, org.id, pending.id);
    expect((await listOrgs(db, bob.id))[0]?.invites).toEqual([]);
  });

  test("an owner removes a member; only the membership goes, the tokens they issued stay", async () => {
    const { db, org, alice, bob } = await acmeOrg();
    await setMemberRole(db, alice.id, { orgId: org.id, userId: bob.id }, "owner");
    await issueOrgToken(db, bob.id, org.id, "bob's ci");
    await setMemberRole(db, alice.id, { orgId: org.id, userId: bob.id }, "member");

    await removeMember(db, alice.id, org.id, bob.id);

    expect(await roles(db, alice.id)).toEqual({ alice: "owner" });
    expect(await listOrgs(db, bob.id)).toEqual([]);
    expect((await listOrgTokens(db, alice.id)).map((t) => [t.name, t.revokedAt])).toEqual([
      ["bob's ci", null],
    ]);
    await expect(removeMember(db, alice.id, org.id, bob.id)).rejects.toThrow(NotFoundError);
    await expect(
      setMemberRole(db, alice.id, { orgId: org.id, userId: bob.id }, "owner"),
    ).rejects.toThrow(NotFoundError);
  });

  test("an owner makes a member an owner, and either can step the other down", async () => {
    const { db, org, alice, bob } = await acmeOrg();
    await setMemberRole(db, alice.id, { orgId: org.id, userId: bob.id }, "owner");
    expect(await roles(db, alice.id)).toEqual({ alice: "owner", bob: "owner" });

    await setMemberRole(db, bob.id, { orgId: org.id, userId: alice.id }, "member");
    expect(await roles(db, alice.id)).toEqual({ alice: "member", bob: "owner" });
    // Stepped down, Alice is refused what only an owner may do.
    await expect(issueOrgToken(db, alice.id, org.id, "ci")).rejects.toThrow(ForbiddenError);
  });

  test("the last owner can never be removed, stepped down or leave", async () => {
    const { db, org, alice, bob } = await acmeOrg();
    for (const refused of [
      removeMember(db, alice.id, org.id, alice.id),
      setMemberRole(db, alice.id, { orgId: org.id, userId: alice.id }, "member"),
      leaveOrg(db, alice.id, org.id),
    ])
      await expect(refused).rejects.toThrow(LastOwnerError);
    expect(await roles(db, alice.id)).toEqual({ alice: "owner", bob: "member" });

    // With a second owner Alice may step down; then Bob is the last and may not.
    await setMemberRole(db, alice.id, { orgId: org.id, userId: bob.id }, "owner");
    await setMemberRole(db, alice.id, { orgId: org.id, userId: alice.id }, "member");
    await expect(
      setMemberRole(db, bob.id, { orgId: org.id, userId: bob.id }, "member"),
    ).rejects.toThrow(LastOwnerError);
    await expect(leaveOrg(db, bob.id, org.id)).rejects.toThrow(LastOwnerError);
    expect(await roles(db, bob.id)).toEqual({ alice: "member", bob: "owner" });
  });

  test("two owners stepping each other down at once leave one owner", async () => {
    const { db, org, alice, bob } = await acmeOrg();
    await setMemberRole(db, alice.id, { orgId: org.id, userId: bob.id }, "owner");
    const both = await Promise.allSettled([
      setMemberRole(db, alice.id, { orgId: org.id, userId: bob.id }, "member"),
      setMemberRole(db, bob.id, { orgId: org.id, userId: alice.id }, "member"),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(Object.values(await roles(db, alice.id)).filter((r) => r === "owner")).toHaveLength(1);
  });

  test("a removed member does not rejoin by an invite on their next sign-in", async () => {
    const { db, org, alice, bob } = await acmeOrg();
    // Bob's email, which the server has not seen yet, invited by him before he goes; and no
    // invite for someone already in.
    await inviteMember(db, bob, org.id, "bob@example.com");
    await expect(inviteMember(db, alice, org.id, "BOB")).rejects.toThrow(
      "bob is already a member of this organization.",
    );
    await removeMember(db, alice.id, org.id, bob.id);
    expect(must((await listOrgs(db, alice.id))[0], "the org").invites).toEqual([]);

    await signInGithubUser(db, { ...profile(2, "bob"), email: "bob@example.com" });
    expect(await listOrgs(db, bob.id)).toEqual([]);
    expect(await roles(db, alice.id)).toEqual({ alice: "owner" });
  });

  test("any member can leave, and is then out of the org", async () => {
    const { db, org, alice, bob, eve } = await acmeOrg();
    await leaveOrg(db, bob.id, org.id);
    expect(await listOrgs(db, bob.id)).toEqual([]);
    expect(await roles(db, alice.id)).toEqual({ alice: "owner" });
    await expect(leaveOrg(db, bob.id, org.id)).rejects.toThrow(NotFoundError);
    await expect(leaveOrg(db, eve.id, org.id)).rejects.toThrow(NotFoundError);
  });
});
