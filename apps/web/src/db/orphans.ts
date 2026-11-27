import { and, eq, inArray, isNotNull, like } from "drizzle-orm";
import { DAY_MS } from "#/lib/retention";
import type { SweepBlobStore } from "#/storage/blobs";
import { chunk } from "./chunks";
import type { Db } from "./db";
import { builds, flakes, orgs, projects, snapshots } from "./schema";

/**
 * Orphaned images: an image stored by its hash (`images/<sha256>.png`, PS-424) is the org's, shared by
 * every shot that sent those bytes, so deleting a build leaves it. Once no `snapshots` row names it (as
 * `image_key`, `baseline_key` or `main_baseline_key`), nothing can read it again: a by-hash upload
 * is only taken for an image a row still names (`heldImages`). A flaky shot's evidence names images too
 * (the shot and its re-captures, shown on the flaky shot's page), and keeps them the same way. The orphan
 * sweep finds the rest and, when told to, deletes them.
 *
 * Two guards against an upload in flight. An image put less than a day ago is never a candidate:
 * an upload puts the blob before it writes the row. And just before deleting, the rows are read again
 * for exactly the keys about to go. What is left is an upload that found the blob already stored
 * (`has`) and skipped the put in the moment between that second read and the delete; its shot then
 * names a missing image. Stop the server before applying by hand to rule that out (apps/web/README.md,
 * "Retention").
 */

/** How long an image stays out of the sweep after it is put. */
const GRACE_MS = DAY_MS;

const IMAGES = "images";

export type OrphanOptions = {
  now: Date;
  /** At most this many blobs; the rest wait for the next sweep. */
  limit?: number;
};

export type OrphanBlob = { orgId: string; key: string; size: number };

export type OrphanPlan = { orphans: OrphanBlob[] };

type OrphanResult = { blobsDeleted: number; bytesFreed: number };

/** The images the evidence of `orgId`'s flaky shots names: each shot's image and its re-captures. */
async function flakeImages(db: Db, orgId: string): Promise<Set<string>> {
  const rows = await db
    .select({ evidence: flakes.evidence })
    .from(flakes)
    .innerJoin(projects, eq(projects.id, flakes.projectId))
    .where(eq(projects.orgId, orgId));
  const keys = rows.flatMap((row) =>
    row.evidence.flatMap((e) => [e.imageKey, ...e.captures.map((c) => c.key)]),
  );
  return new Set(keys.filter((key) => key.startsWith(`${IMAGES}/`)));
}

/** The image keys of `orgId` that some `snapshots` row or flaky shot names, each column read once, distinct. */
async function namedImages(db: Db, orgId: string): Promise<Set<string>> {
  const named = await flakeImages(db, orgId);
  for (const column of [snapshots.imageKey, snapshots.baselineKey, snapshots.mainBaselineKey]) {
    const rows = await db
      .selectDistinct({ key: column })
      .from(snapshots)
      .innerJoin(builds, eq(builds.id, snapshots.buildId))
      .innerJoin(projects, eq(projects.id, builds.projectId))
      .where(and(eq(projects.orgId, orgId), isNotNull(column), like(column, `${IMAGES}/%`)));
    for (const row of rows) if (row.key) named.add(row.key);
  }
  return named;
}

/** Which of `keys` (all `orgId`'s) a `snapshots` row names now, in any of the three columns, or a flaky shot does. */
async function stillNamed(db: Db, orgId: string, keys: string[]): Promise<Set<string>> {
  const named = await flakeImages(db, orgId);
  const columns = [snapshots.imageKey, snapshots.baselineKey, snapshots.mainBaselineKey];
  const reads = columns.flatMap((column) => chunk(keys, 0, 1).map((part) => ({ column, part })));
  for (const { column, part } of reads) {
    const rows = await db
      .selectDistinct({ key: column })
      .from(snapshots)
      .where(inArray(column, part));
    for (const row of rows) if (row.key) named.add(row.key);
  }
  return named;
}

/** Every org's images that no row names and that were put before the grace period. Changes nothing. */
export async function planOrphans(
  db: Db,
  storeFor: (orgId: string) => SweepBlobStore,
  { now, limit }: OrphanOptions,
): Promise<OrphanPlan> {
  const orphans: OrphanBlob[] = [];
  const orgIds = (await db.select({ id: orgs.id }).from(orgs).orderBy(orgs.id)).map((o) => o.id);
  for (const orgId of orgIds) {
    const listed = await storeFor(orgId).list(IMAGES);
    if (listed.length === 0) continue;
    const named = await namedImages(db, orgId);
    for (const blob of listed.toSorted((a, b) => Number(a.key > b.key) - Number(a.key < b.key))) {
      if (named.has(blob.key)) continue;
      // A store that does not say when a blob was put gives it no grace; R2 always says.
      if (blob.uploaded && now.getTime() - blob.uploaded.getTime() < GRACE_MS) continue;
      if (orphans.length === limit) return { orphans };
      orphans.push({ orgId, key: blob.key, size: blob.size });
    }
  }
  return { orphans };
}

/** Delete what `plan` lists, less any key a row has come to name since it was planned. */
export async function applyOrphans(
  db: Db,
  storeFor: (orgId: string) => SweepBlobStore,
  plan: OrphanPlan,
): Promise<OrphanResult> {
  const result: OrphanResult = { blobsDeleted: 0, bytesFreed: 0 };
  const byOrg = new Map<string, OrphanBlob[]>();
  for (const orphan of plan.orphans)
    byOrg.set(orphan.orgId, [...(byOrg.get(orphan.orgId) ?? []), orphan]);
  for (const [orgId, blobs] of byOrg) {
    const named = await stillNamed(
      db,
      orgId,
      blobs.map((b) => b.key),
    );
    const going = blobs.filter((b) => !named.has(b.key));
    await storeFor(orgId).deleteMany(going.map((b) => b.key));
    result.blobsDeleted += going.length;
    result.bytesFreed += going.reduce((sum, b) => sum + b.size, 0);
  }
  return result;
}

/** Plan the orphan sweep and, unless `dryRun`, carry it out; a dry run lists and reads, nothing else. */
export async function sweepOrphans(
  db: Db,
  storeFor: (orgId: string) => SweepBlobStore,
  options: OrphanOptions & { dryRun: boolean },
): Promise<{ plan: OrphanPlan; result: OrphanResult | null }> {
  const plan = await planOrphans(db, storeFor, options);
  if (options.dryRun) return { plan, result: null };
  return { plan, result: await applyOrphans(db, storeFor, plan) };
}
