import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { type Ctx, context, onlyShot, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { DAY_MS } from "#/lib/retention";
import { type SweepBlobStore, orgSweepBlobs } from "#/storage/blobs";
import { builds, flakes, snapshots } from "./schema";
import { applyOrphans, planOrphans, sweepOrphans } from "./orphans";

const NOW = new Date("2026-10-28T12:00:00Z");

const storeFor = (ctx: Ctx) => (orgId: string) => orgSweepBlobs(ctx.blobs.store, orgId);
const sweep = (ctx: Ctx, dryRun = false, limit?: number) =>
  sweepOrphans(ctx.db, storeFor(ctx), {
    now: NOW,
    dryRun,
    ...(limit === undefined ? {} : { limit }),
  });
const images = (ctx: Ctx) =>
  [...ctx.blobs.data.keys()]
    .filter((k) => k.startsWith(`orgs/${ctx.orgId}/images/`))
    .map((k) => k.slice(`orgs/${ctx.orgId}/`.length))
    .toSorted();

/**
 * A build of one shot whose image no other build shares, its image stored by hash, on a branch of its
 * own so it is no other build's baseline.
 */
const one = (ctx: Ctx, n: number) =>
  upload(ctx, {
    branch: `feature-${n}`,
    commit: sha(n),
    shots: [{ png: shot({ blocks: [{ x: n, y: n, w: 12, h: 12, rgb: RED }] }) }],
  });

/** Drop a build's rows and leave its blobs: what deleting a build does to an org-shared image. */
const forget = (ctx: Ctx, id: string) => ctx.db.delete(builds).where(eq(builds.id, id));

describe("the orphan sweep", () => {
  test("an image no row names goes; one a row names stays", async () => {
    const ctx = await context();
    const gone = await one(ctx, 2);
    const kept = await one(ctx, 3);
    const goneKey = (await onlyShot(ctx, gone)).imageKey;
    const keptKey = (await onlyShot(ctx, kept)).imageKey;
    expect(goneKey).toMatch(/^images\//);
    await forget(ctx, gone.id);
    const { plan, result } = await sweep(ctx);
    expect(plan.orphans.map((o) => [o.orgId, o.key])).toEqual([[ctx.orgId, goneKey]]);
    expect(plan.orphans[0]?.size).toBeGreaterThan(0);
    expect(result).toEqual({ blobsDeleted: 1, bytesFreed: plan.orphans[0]?.size });
    expect(images(ctx)).toEqual([keptKey]);
  });

  test("a dry run lists them and deletes nothing", async () => {
    const ctx = await context();
    const gone = await one(ctx, 2);
    await forget(ctx, gone.id);
    const before = new Map(ctx.blobs.data);
    const { plan, result } = await sweep(ctx, true);
    expect(result).toBeNull();
    expect(plan.orphans).toHaveLength(1);
    expect(ctx.blobs.data).toEqual(before);
  });

  test("an image only a flake's evidence names stays, its re-captures too", async () => {
    const ctx = await context();
    const gone = await one(ctx, 2);
    const goneKey = (await onlyShot(ctx, gone)).imageKey;
    const capture = "images/re-capture.png";
    ctx.blobs.data.set(`orgs/${ctx.orgId}/${capture}`, new ArrayBuffer(4));
    await ctx.db.insert(flakes).values({
      id: "flake",
      projectId: gone.projectId,
      name: "home",
      platform: "web",
      browser: "chromium",
      viewport: "1280x800",
      theme: "light",
      updatedAt: NOW,
      evidence: [
        {
          buildId: gone.id,
          snapshotId: "gone-shot",
          imageKey: goneKey,
          captures: [{ run: 2, key: capture }],
          runs: 2,
          differed: [2],
          regions: [],
          engineVersion: "test",
          policy: "review",
          at: NOW.getTime(),
        },
      ],
    });
    await forget(ctx, gone.id);
    const { plan } = await sweep(ctx);
    expect(plan.orphans).toEqual([]);
    expect(images(ctx)).toEqual([goneKey, capture].toSorted());
  });

  test.each([
    ["image_key", (key: string) => ({ imageKey: key })],
    ["baseline_key", (key: string) => ({ baselineKey: key })],
    ["main_baseline_key", (key: string) => ({ mainBaselineKey: key })],
  ])("an image named only as %s stays", async (_column, name) => {
    const ctx = await context();
    const gone = await one(ctx, 2);
    const live = await one(ctx, 3);
    const goneKey = (await onlyShot(ctx, gone)).imageKey;
    await forget(ctx, gone.id);
    await ctx.db
      .update(snapshots)
      .set(name(goneKey))
      .where(eq(snapshots.id, (await onlyShot(ctx, live)).id));
    const { plan } = await sweep(ctx);
    expect(plan.orphans.map((o) => o.key)).not.toContain(goneKey);
    expect(images(ctx)).toContain(goneKey);
  });

  test("an image put inside the grace period is left for a later sweep", async () => {
    const ctx = await context();
    const gone = await one(ctx, 2);
    await forget(ctx, gone.id);
    const putAt =
      (at: Date) =>
      (orgId: string): SweepBlobStore => {
        const store = orgSweepBlobs(ctx.blobs.store, orgId);
        return {
          ...store,
          list: async (dir) => (await store.list(dir)).map((b) => ({ ...b, uploaded: at })),
        };
      };
    const plan = (at: Date) => planOrphans(ctx.db, putAt(at), { now: NOW });
    expect((await plan(new Date(NOW.getTime() - DAY_MS / 2))).orphans).toEqual([]);
    expect((await plan(new Date(NOW.getTime() - 2 * DAY_MS))).orphans).toHaveLength(1);
  });

  test("a key a row comes to name between the plan and the delete is not deleted", async () => {
    const ctx = await context();
    const gone = await one(ctx, 2);
    const live = await one(ctx, 3);
    const goneKey = (await onlyShot(ctx, gone)).imageKey;
    await forget(ctx, gone.id);
    const plan = await planOrphans(ctx.db, storeFor(ctx), { now: NOW });
    expect(plan.orphans.map((o) => o.key)).toEqual([goneKey]);
    await ctx.db
      .update(snapshots)
      .set({ baselineKey: goneKey })
      .where(eq(snapshots.id, (await onlyShot(ctx, live)).id));
    expect(await applyOrphans(ctx.db, storeFor(ctx), plan)).toEqual({
      blobsDeleted: 0,
      bytesFreed: 0,
    });
    expect(images(ctx)).toContain(goneKey);
  });

  test("the limit takes the first keys and the rest wait", async () => {
    const ctx = await context();
    for (const n of [2, 3, 4]) await forget(ctx, (await one(ctx, n)).id);
    expect((await sweep(ctx, false, 2)).result?.blobsDeleted).toBe(2);
    expect((await sweep(ctx)).result?.blobsDeleted).toBe(1);
    expect(images(ctx)).toEqual([]);
  });

  test("a build's own folder is not an orphan: only images/ is swept", async () => {
    const ctx = await context();
    const gone = await one(ctx, 2);
    await forget(ctx, gone.id);
    await ctx.blobs.store.put(
      `orgs/${ctx.orgId}/builds/${gone.id}/x.png`,
      new ArrayBuffer(4),
      "image/png",
    );
    await sweep(ctx);
    expect([...ctx.blobs.data.keys()]).toContain(`orgs/${ctx.orgId}/builds/${gone.id}/x.png`);
  });
});
