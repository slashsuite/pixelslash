import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { type Ctx, context, onlyShot, sha, uploadLegacy as upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { DAY_MS } from "#/lib/retention";
import { orgSweepBlobs } from "#/storage/blobs";
import type { Build } from "./builds";
import { builds, snapshots } from "./schema";
import { sweepRetention } from "./retention";

// The default branch's own window (`mainDays`): what it may delete and the builds it always keeps.
const block = { x: 8, y: 8, w: 12, h: 12, rgb: RED };
const NOW = new Date("2026-10-28T12:00:00Z");
const WINDOW = 30;
const MAIN = 365;

async function age(ctx: Ctx, build: Build, days: number): Promise<void> {
  await ctx.db
    .update(builds)
    .set({ createdAt: new Date(NOW.getTime() - days * DAY_MS) })
    .where(eq(builds.id, build.id));
}

const sweepMain = (ctx: Ctx, mainDays: number | null = MAIN) =>
  sweepRetention(ctx.db, (orgId) => orgSweepBlobs(ctx.blobs.store, orgId), {
    days: WINDOW,
    mainDays: mainDays ?? undefined,
    now: NOW,
    dryRun: false,
  });

const buildIds = async (ctx: Ctx) =>
  (await ctx.db.select({ id: builds.id }).from(builds)).map((b) => b.id);
const blobsOf = (ctx: Ctx, build: Build) =>
  [...ctx.blobs.data.keys()].filter((k) => k.includes(`/builds/${build.id}/`));

/** A default-branch build whose shots differ from every other's, so no two share an image. */
const onMain = (ctx: Ctx, n: number, names: string[] = ["home"]) =>
  upload(ctx, {
    branch: "main",
    commit: sha(n),
    shots: names.map((name) => ({ name, png: shot({ blocks: [{ ...block, x: n, y: n }] }) })),
  });

/** A branch build with one shot, on its own commit and with no ancestry. */
const alone = (ctx: Ctx, branch: string, n: number) =>
  upload(ctx, { branch, commit: sha(n), shots: [{ png: shot() }] });

describe("the default branch's own window", () => {
  test("an old main build nothing current needs is a candidate; the newest and a baseline holder stay", async () => {
    const ctx = await context();
    // Aged as they go, so each one's baseline is the one before it.
    const holder = await onMain(ctx, 1, ["home", "about"]);
    await age(ctx, holder, 410);
    const oldest = await onMain(ctx, 2);
    await age(ctx, oldest, 400);
    const middle = await onMain(ctx, 3);
    await age(ctx, middle, 380);
    const newest = await onMain(ctx, 4);
    await age(ctx, newest, 370);
    const { plan, result } = await sweepMain(ctx);
    // `holder` has the newest shot of "about"; `newest` is the project's newest main build;
    // `middle` is the baseline `newest` was diffed against, a hop from a build that stays. `oldest`
    // is only `middle`'s baseline, and a main build kept for a hop keeps no other main build.
    expect(plan.keptCurrent.toSorted()).toEqual([holder.id, newest.id].toSorted());
    expect(plan.keptReferenced).toEqual([middle.id]);
    expect(plan.expired.map((b) => [b.id, b.window])).toEqual([[oldest.id, "main"]]);
    expect(result?.buildsDeleted).toBe(1);
    expect((await buildIds(ctx)).toSorted()).toEqual([holder.id, middle.id, newest.id].toSorted());
    expect(blobsOf(ctx, oldest)).toEqual([]);
    expect(blobsOf(ctx, holder).length).toBeGreaterThan(0);
  });

  test("a main build inside its window stays", async () => {
    const ctx = await context();
    const old = await onMain(ctx, 1);
    await age(ctx, old, MAIN - 1);
    const newer = await onMain(ctx, 2);
    await age(ctx, newer, 1);
    await onMain(ctx, 3);
    const { plan } = await sweepMain(ctx);
    expect(plan.expired).toEqual([]);
  });

  test("with the window unset, no main build is a candidate, however old", async () => {
    const ctx = await context();
    for (const n of [1, 2, 3]) await age(ctx, await onMain(ctx, n), 900 - n);
    const { plan } = await sweepMain(ctx, null);
    expect(plan.main).toBeNull();
    expect(plan.expired).toEqual([]);
    expect(plan.keptCurrent).toEqual([]);
    expect(await buildIds(ctx)).toHaveLength(3);
  });

  test("a branch build a main build kept for a hop points at stays", async () => {
    const ctx = await context();
    const feature = await alone(ctx, "feature", 9);
    await age(ctx, feature, 400);
    // Past the window and not the newest: kept only because `newest` was diffed against it.
    const hop = await onMain(ctx, 1);
    await age(ctx, hop, 400);
    await ctx.db
      .update(snapshots)
      .set({ baselineKey: (await onlyShot(ctx, feature)).imageKey })
      .where(eq(snapshots.buildId, hop.id));
    const newest = await onMain(ctx, 2);
    await age(ctx, newest, 370);
    const { plan } = await sweepMain(ctx);
    expect(plan.keptCurrent).toEqual([newest.id]);
    expect(plan.keptReferenced.toSorted()).toEqual([feature.id, hop.id].toSorted());
    expect(plan.expired).toEqual([]);
  });
});
