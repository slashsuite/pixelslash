import { describe, expect, onTestFinished, test } from "vitest";
import { memoryStore } from "#/api/test-support";
import { rediffShots } from "#/diff/rerun";
import { type Uploads, rows, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { sha256Bytes } from "#/lib/crypto";
import { orgBlobs } from "#/storage/blobs";
import { snapshotDiffOptions } from "./builds";
import { heldImages } from "./held-images";
import { listBuilds } from "./build-list";
import type { Db } from "./db";
import { snapshotIgnoreBoxes, snapshotOverrides } from "./override-export";
import { overrideChanges } from "./overrides";
import { listOrgs } from "./orgs";
import { acceptAllSnapshots, buildView } from "./review";
import { d1Db, seededStore } from "#/test/store";
import { twinsOfBuild } from "./twins";
import { baselinesOf } from "./twins-read";
import { must } from "#/test/must";

/**
 * A build bigger than D1's 100 bound parameters per statement (ob 1773). In-memory SQLite allows
 * far more, so this runs on a local D1 (miniflare), which refuses such a statement as D1 does.
 */

const SHOTS = 250;
const names = Array.from({ length: SHOTS }, (_, i) => `s${String(i).padStart(3, "0")}`);
const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const every = (png: typeof white) => names.map((name) => ({ name, png }));

/**
 * The diff stops itself at a wall-clock budget (`DIFF_BUDGET_MS`). This test measures D1's
 * parameter limit, not diff speed, so its clock never moves and a slow runner cannot run the budget
 * out: a build that ends `errored`, or a main build that does not finish, would fail it on timing.
 */
const frozen = { now: () => 0 };

/** The test's own local D1, seeded with Ada's org and its `web` project; disposed when the test ends. */
async function localD1(): Promise<Uploads & { userId: string }> {
  const held = await d1Db();
  onTestFinished(() => held.dispose());
  const { db, user, org, project } = await seededStore<Db>({ db: held.db });
  const { store } = memoryStore();
  return { db, projectId: project.id, userId: user.id, scoped: orgBlobs(store, org.id) };
}

describe(`a build of ${SHOTS} shots on a local D1 (ob 1773)`, () => {
  test("the build page, its snapshot pages and a re-diff load without error", async () => {
    const ctx = await localD1();
    await upload(ctx, { branch: "main", commit: sha(1), shots: every(white) }, frozen);
    const first = await upload(
      ctx,
      { branch: "feat", commit: sha(2), mergeBase: sha(1), shots: every(red) },
      frozen,
    );
    expect(first.status).toBe("changes");
    await acceptAllSnapshots(ctx.db, {
      projectId: ctx.projectId,
      buildId: first.id,
      userId: ctx.userId,
    });
    const second = await upload(
      ctx,
      { branch: "feat", commit: sha(3), mergeBase: sha(1), shots: every(red) },
      frozen,
    );
    expect(second.status).toBe("passed");

    // The build page.
    const view = await buildView(ctx.db, ctx.projectId, second.id);
    expect(view.snapshots).toHaveLength(SHOTS);
    expect(view.snapshots.every((s) => s.approvedEarlier?.buildId === first.id)).toBe(true);
    const shotNames = [...new Set(view.snapshots.map((s) => s.name))];
    expect(await overrideChanges(ctx.db, ctx.userId, ctx.projectId, shotNames)).toEqual([]);

    // The build page's twin read: a web build, so the android and ios baselines are read under every
    // name (PS-406: the baselines read bound more than it counted, and 89 names broke it).
    await twinsOfBuild(ctx.db, second.id);
    // The widest form of that read: all three platforms and the excluded build.
    const wide = await baselinesOf(ctx.db, {
      projectIds: [ctx.projectId],
      platforms: ["web", "android", "ios"],
      names,
      exceptBuild: second.id,
    });
    expect(wide.length).toBeGreaterThan(0);

    // The shot pages: the first, a middle and the last shot.
    const picked = [view.snapshots[0], view.snapshots[SHOTS >> 1], view.snapshots.at(-1)];
    for (const snapshot of picked.map((s) => must(s, "a picked shot"))) {
      await snapshotDiffOptions(ctx.db, snapshot.id);
      await snapshotOverrides(ctx.db, ctx.userId, ctx.projectId, snapshot);
      await snapshotIgnoreBoxes(ctx.db, ctx.userId, ctx.projectId, snapshot);
    }

    // The project and organizations pages count every build's shots.
    expect(await listBuilds(ctx.db, ctx.projectId)).toHaveLength(3);
    expect(await listOrgs(ctx.db, ctx.userId)).toHaveLength(1);

    // A re-diff of every shot, as a review-UI override that applies to all of them does.
    const ids = (await rows(ctx, second)).map((row) => row.id);
    const result = await rediffShots({ db: ctx.db, blobs: ctx.scoped, ...frozen }, second, ids);
    expect(result).toMatchObject({ status: "passed", error: null });
    const after = await buildView(ctx.db, ctx.projectId, second.id);
    expect(after.snapshots.every((s) => s.diffStatus === "unchanged")).toBe(true);
  }, 300_000);

  test("the merge-base and 200 ancestors reach the baseline query in parts (ob 1788)", async () => {
    const ctx = await localD1();
    const old = await upload(ctx, { branch: "main", commit: sha(1001), shots: [{ png: white }] });
    const history = Array.from({ length: 200 }, (_, i) => sha(1150 - i));
    const branch = await upload(ctx, {
      branch: "deep",
      commit: sha(5000),
      mergeBase: sha(1151),
      ancestors: history,
      shots: [{ png: red }],
    });
    expect((await rows(ctx, branch))[0]).toMatchObject({
      diffStatus: "changed",
      baselineKey: (await rows(ctx, old))[0]?.imageKey,
    });
  }, 60_000);

  test("150 hashes are looked up in parts, the held one found (PS-424)", async () => {
    const ctx = await localD1();
    await upload(ctx, { branch: "main", commit: sha(7001), shots: [{ png: white }] });
    const real = await sha256Bytes(white.buffer);
    const absent = Array.from({ length: 150 }, (_, i) => i.toString(16).padStart(64, "0"));
    const found = await heldImages(ctx.db, ctx.projectId, [...absent, real]);
    expect([...found.keys()]).toEqual([real]);
  }, 60_000);
});
