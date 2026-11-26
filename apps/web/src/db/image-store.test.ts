import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { createOrg, createProject } from "#/db/orgs";
import { type Ctx, context, legacyLayout, onlyShot, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { sha256Bytes } from "#/lib/crypto";
import { DAY_MS } from "#/lib/retention";
import { type BlobStore, orgBlobs, orgSweepBlobs } from "#/storage/blobs";
import { imageKeyOf } from "./builds";
import { sweepRetention } from "./retention";
import { builds } from "./schema";

/** Every image is stored once per org, under its hash; older shots keep their per-build key. */

const red = shot({ blocks: [{ x: 8, y: 8, w: 12, h: 12, rgb: RED }] });

/** The org's store, recording every key put into it. */
function recording(ctx: Ctx) {
  const puts: string[] = [];
  const blobs: BlobStore = {
    ...ctx.scoped,
    put: async (key, body, type) => {
      puts.push(key);
      await ctx.scoped.put(key, body, type);
    },
  };
  return { blobs, puts };
}

const pngsIn = (ctx: Ctx) => [...ctx.blobs.data.keys()].filter((k) => !k.endsWith(".diff.png"));

describe("the org's image store", () => {
  test("a PNG is stored under its hash, in the org's images", async () => {
    const ctx = await context();
    const build = await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: red }] });
    const row = await onlyShot(ctx, build);
    expect(row.imageKey).toBe(imageKeyOf(await sha256Bytes(red.buffer)));
    expect(row.imageKey).toBe(`images/${row.imageSha256}.png`);
    expect(pngsIn(ctx)).toEqual([`orgs/${ctx.orgId}/${row.imageKey}`]);
  });

  test("two projects of one org sending the same image store one blob", async () => {
    const ctx = await context();
    const web = await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: red }] });
    const docs = await createProject(ctx.db, ctx.userId, ctx.orgId, "docs");
    const store = recording(ctx);
    const other = { ...ctx, projectId: docs.id, scoped: store.blobs };
    const second = await upload(
      other,
      { branch: "main", commit: sha(2), shots: [{ name: "home", png: red }] },
      { blobs: store.blobs },
    );
    const a = await onlyShot(ctx, web);
    const b = await onlyShot(ctx, second);
    expect(b.imageKey).toBe(a.imageKey);
    expect(store.puts).toEqual([]);
    expect(pngsIn(ctx)).toEqual([`orgs/${ctx.orgId}/${a.imageKey}`]);
  });

  test("a build sending bytes the org holds puts no image", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: red }] });
    const store = recording(ctx);
    await upload(
      { ...ctx, scoped: store.blobs },
      { branch: "main", commit: sha(2), shots: [{ png: red }] },
      { blobs: store.blobs },
    );
    expect(store.puts).toEqual([]);
  });

  test("another org's copy of the same image is its own blob", async () => {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: red }] });
    const org = await createOrg(ctx.db, ctx.userId, "Elsewhere");
    const project = await createProject(ctx.db, ctx.userId, org.id, "web");
    const theirs = { ...ctx, projectId: project.id, scoped: orgBlobs(ctx.blobs.store, org.id) };
    await upload(theirs, { branch: "main", commit: sha(1), shots: [{ png: red }] });
    const key = imageKeyOf(await sha256Bytes(red.buffer));
    expect(pngsIn(ctx).toSorted()).toEqual(
      [`orgs/${ctx.orgId}/${key}`, `orgs/${org.id}/${key}`].toSorted(),
    );
  });

  test("a build stored under the old per-build key still reads, and is a baseline as before", async () => {
    const ctx = await context();
    const old = await legacyLayout(
      ctx,
      await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: red }] }),
    );
    const oldShot = await onlyShot(ctx, old);
    expect(oldShot.imageKey).toMatch(new RegExp(`^builds/${old.id}/[0-9a-f]{32}\\.png$`));
    const bytes = await new Response(await ctx.scoped.get(oldShot.imageKey)).arrayBuffer();
    expect(new Uint8Array(bytes)).toEqual(red);

    const next = await upload(ctx, { branch: "main", commit: sha(2), shots: [{ png: red }] });
    expect(await onlyShot(ctx, next)).toMatchObject({
      diffStatus: "unchanged",
      baselineKey: oldShot.imageKey,
      baselineSnapshotId: oldShot.id,
    });
  });

  test("the sweep deletes an expired build whose image a kept build shares, and keeps the image", async () => {
    const ctx = await context();
    const now = new Date("2026-10-28T12:00:00Z");
    const old = await upload(ctx, { branch: "feature-a", commit: sha(2), shots: [{ png: red }] });
    const kept = await upload(ctx, { branch: "feature-b", commit: sha(3), shots: [{ png: red }] });
    await ctx.db
      .update(builds)
      .set({ createdAt: new Date(now.getTime() - 40 * DAY_MS) })
      .where(eq(builds.id, old.id));
    const { plan, result } = await sweepRetention(
      ctx.db,
      (orgId) => orgSweepBlobs(ctx.blobs.store, orgId),
      { days: 30, now, dryRun: false },
    );
    // The image is the org's, so it holds the old build back from nobody, and the sweep leaves it.
    expect(plan.expired.map((b) => b.id)).toEqual([old.id]);
    expect(result?.buildsDeleted).toBe(1);
    const key = (await onlyShot(ctx, kept)).imageKey;
    expect(await ctx.scoped.has(key)).toBe(true);
  });
});
