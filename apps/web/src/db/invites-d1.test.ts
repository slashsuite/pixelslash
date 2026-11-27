import { expect, onTestFinished, test } from "vitest";
import { inviteMember } from "./invites";
import { createOrg, listOrgs } from "./orgs";
import { signInGithubUser } from "./users";
import { d1Db } from "#/test/store";

const INVITES = 40;

/** A sign-in takes up every invite in multi-row inserts that stay under D1's 100 bound parameters. */
test(`a sign-in with ${INVITES} pending invites joins every org, on a local D1`, async () => {
  const held = await d1Db();
  onTestFinished(() => held.dispose());
  const { db } = held;
  const owner = await signInGithubUser(db, {
    githubId: 1,
    login: "owner",
    name: null,
    avatarUrl: null,
  });
  for (let i = 0; i < INVITES; i++) {
    const org = await createOrg(db, owner.id, `Org ${String(i).padStart(2, "0")}`);
    await inviteMember(db, owner, org.id, "newcomer");
  }
  const newcomer = await signInGithubUser(db, {
    githubId: 2,
    login: "newcomer",
    name: null,
    avatarUrl: null,
  });
  const orgs = await listOrgs(db, newcomer.id);
  expect(orgs).toHaveLength(INVITES);
  const theirs = orgs.flatMap((o) => o.members.filter((m) => m.login === "newcomer"));
  expect(theirs.map((m) => m.role)).toEqual(Array.from({ length: INVITES }, () => "member"));
}, 60_000);
