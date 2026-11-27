import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { builds, snapshots } from "#/db/schema";
import { issueOrgToken, issueUserToken } from "#/db/tokens";
import { createOrg, setGithubRepo } from "#/db/orgs";
import { signInGithubUser } from "#/db/users";
import { context, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import type { StatusBody } from "#/github/check-run";
import { fakeGithub } from "#/github/test-github";
import { call, idOf } from "./test-support";

/** Review over API v1: a person's token decides, with the web app's effect. */

const PUBLIC_URL = "https://pixelslash.test";

const block = { x: 8, y: 8, w: 12, h: 12, rgb: RED };

/** A main build and a feature build that changes `about`, with a personal token for its org's member. */
async function changed() {
  const ctx = await context();
  // A token server on a stand-in for GitHub: each build a sync reaches gets a commit status.
  const github = fakeGithub();
  await setGithubRepo(ctx.db, ctx.userId, ctx.projectId, "acme/web");
  ctx.deps.checkRuns = { app: null, token: github.token(), publicUrl: PUBLIC_URL };
  await upload(ctx, {
    branch: "main",
    commit: sha(1),
    shots: [
      { name: "home", png: shot() },
      { name: "about", png: shot() },
    ],
  });
  const feature = await upload(ctx, {
    branch: "feature",
    commit: sha(2),
    mergeBase: sha(1),
    shots: [
      { name: "home", png: shot() },
      { name: "about", png: shot({ blocks: [block] }) },
    ],
  });
  expect(feature.status).toBe("changes");
  const [about] = await ctx.db
    .select()
    .from(snapshots)
    .where(eq(snapshots.buildId, feature.id))
    .then((rows) => rows.filter((s) => s.name === "about"));
  if (!about) throw new Error("no about shot");
  const ada = (await issueUserToken(ctx.db, ctx.userId, "laptop", null)).token;
  let seen = github.statusCalls().length;
  /** The builds synced since the last look, by the build page each new commit status links. */
  const synced = () => {
    const calls = github.statusCalls().slice(seen);
    seen += calls.length;
    return calls.map((c) => buildOf(JSON.parse(c.raw)));
  };
  return { ctx, feature, about, ada, synced };
}

/** The build id at the end of a status's Details link. */
const buildOf = (status: StatusBody) => status.target_url?.split("/builds/")[1];

type Body = {
  status: string;
  build_ids: string[];
  error: { code: string; message: string };
};
async function json(res: Response) {
  const body: Body = await res.json();
  return { status: res.status, body };
}

const review = (
  ctx: Awaited<ReturnType<typeof changed>>["ctx"],
  id: string,
  token: string,
  b: unknown,
) => call(ctx.deps, `POST /api/v1/snapshots/${id}/review`, token, JSON.stringify(b)).then(json);
const acceptAll = (ctx: Awaited<ReturnType<typeof changed>>["ctx"], id: string, token: string) =>
  call(ctx.deps, `POST /api/v1/builds/${id}/accept-all`, token).then(json);

const buildStatus = async (ctx: Awaited<ReturnType<typeof changed>>["ctx"], id: string) =>
  (await ctx.db.select().from(builds).where(eq(builds.id, id)))[0]?.status;

/** The branch again with the change still open: its `about` carries the first build's. */
async function carrying(ctx: Awaited<ReturnType<typeof changed>>["ctx"]) {
  const carrier = await upload(ctx, {
    branch: "feature",
    commit: sha(3),
    mergeBase: sha(1),
    shots: [
      { name: "home", png: shot() },
      { name: "about", png: shot({ blocks: [block] }) },
    ],
  });
  expect(carrier.status).toBe("changes");
  return carrier;
}

describe("review over the API", () => {
  test("accepting the changed shot passes the build, under the token's user, and syncs it", async () => {
    const { ctx, feature, about, ada, synced } = await changed();
    const res = await review(ctx, about.id, ada, { state: "accepted" });
    expect(res).toMatchObject({ status: 200, body: { status: "passed" } });
    expect(res.body.build_ids[0]).toBe(feature.id);
    expect(await buildStatus(ctx, feature.id)).toBe("passed");
    const [row] = await ctx.db.select().from(snapshots).where(eq(snapshots.id, about.id));
    expect(row).toMatchObject({ reviewState: "accepted", reviewedBy: ctx.userId });
    expect(synced()).toEqual(res.body.build_ids);

    // The read API names the reviewer as the web app does.
    const read = await call(ctx.deps, `GET /api/v1/snapshots/${about.id}`, ada);
    const shotBody: { snapshot: { reviewed_by: string; review_state: string } } = await read.json();
    expect(shotBody.snapshot).toMatchObject({ reviewed_by: "ada", review_state: "accepted" });
  });

  test.each([
    [
      "a review",
      (w: Awaited<ReturnType<typeof changed>>) =>
        review(w.ctx, w.about.id, w.ada, { state: "accepted" }),
    ],
    [
      "an accept-all",
      (w: Awaited<ReturnType<typeof changed>>) => acceptAll(w.ctx, w.feature.id, w.ada),
    ],
  ])("%s reaches the build that carries the change, and syncs both", async (_, decide) => {
    const world = await changed();
    const { ctx, feature, synced } = world;
    const carrier = await carrying(ctx);
    synced();
    const res = await decide(world);
    expect(res).toMatchObject({ status: 200, body: { status: "passed" } });
    expect(res.body.build_ids).toEqual([feature.id, carrier.id]);
    expect(await buildStatus(ctx, carrier.id)).toBe("passed");
    expect(synced()).toEqual([feature.id, carrier.id]);
  });

  test("rejecting the changed shot fails the build", async () => {
    const { ctx, feature, about, ada, synced } = await changed();
    const res = await review(ctx, about.id, ada, { state: "rejected" });
    expect(res).toMatchObject({ status: 200, body: { status: "failed" } });
    expect(await buildStatus(ctx, feature.id)).toBe("failed");
    expect(synced()).toEqual(res.body.build_ids);
  });

  test("accept-all passes the build and syncs it; a rejected build's accept-all is 409", async () => {
    const { ctx, feature, about, ada, synced } = await changed();
    const res = await acceptAll(ctx, feature.id, ada);
    expect(res).toMatchObject({ status: 200, body: { status: "passed" } });
    expect(res.body.build_ids[0]).toBe(feature.id);
    expect(await buildStatus(ctx, feature.id)).toBe("passed");
    const [row] = await ctx.db.select().from(snapshots).where(eq(snapshots.id, about.id));
    expect(row).toMatchObject({ reviewState: "accepted", reviewedBy: ctx.userId });
    expect(synced()).toEqual(res.body.build_ids);

    await review(ctx, about.id, ada, { state: "rejected" });
    synced();
    const refused = await acceptAll(ctx, feature.id, ada);
    expect(refused).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
    expect(await buildStatus(ctx, feature.id)).toBe("failed");
    expect(synced()).toEqual([]);
  });

  test("a bad state is 400 and writes nothing", async () => {
    const { ctx, feature, about, ada, synced } = await changed();
    for (const body of [{ state: "approved" }, {}, "accepted"])
      expect(await review(ctx, about.id, ada, body)).toMatchObject({
        status: 400,
        body: { error: { code: "bad_request" } },
      });
    expect(await buildStatus(ctx, feature.id)).toBe("changes");
    expect(synced()).toEqual([]);
  });

  test("a CI or org token is 403 on any id or body", async () => {
    const { ctx, feature, about, synced } = await changed();
    const org = (await issueOrgToken(ctx.db, ctx.userId, ctx.orgId, "ci")).token;
    for (const token of [ctx.acme.token, org]) {
      for (const id of [about.id, "missing"])
        for (const body of [{ state: "accepted" }, { state: "nope" }])
          expect((await review(ctx, id, token, body)).status).toBe(403);
      for (const id of [feature.id, "missing"])
        expect(await acceptAll(ctx, id, token)).toMatchObject({
          status: 403,
          body: { error: { code: "forbidden" } },
        });
    }
    expect(await buildStatus(ctx, feature.id)).toBe("changes");
    expect(synced()).toEqual([]);
  });

  test("an unknown id, or a project the user is not a member of, is 404", async () => {
    const { ctx, feature, about, ada, synced } = await changed();
    expect((await review(ctx, "missing", ada, { state: "accepted" })).status).toBe(404);
    expect((await acceptAll(ctx, "missing", ada)).status).toBe(404);

    const eve = await signInGithubUser(ctx.db, {
      githubId: 2,
      login: "eve",
      name: null,
      avatarUrl: null,
    });
    await createOrg(ctx.db, eve.id, "Elsewhere");
    const theirs = (await issueUserToken(ctx.db, eve.id, "laptop", null)).token;
    expect(await review(ctx, about.id, theirs, { state: "accepted" })).toMatchObject({
      status: 404,
      body: { error: { code: "not_found" } },
    });
    expect((await acceptAll(ctx, feature.id, theirs)).status).toBe(404);
    expect(await buildStatus(ctx, feature.id)).toBe("changes");
    expect(synced()).toEqual([]);
  });

  test("a build still uploading is 409", async () => {
    const { ctx, ada } = await changed();
    const open = await call(
      ctx.deps,
      "POST /api/v1/builds",
      ctx.acme.token,
      JSON.stringify({ commitSha: sha(9), branch: "feature" }),
    );
    expect((await acceptAll(ctx, await idOf(open), ada)).status).toBe(409);
  });
});
