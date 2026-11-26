import { and, asc, desc, eq, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import type { SweepBlobStore } from "#/storage/blobs";
import { DAY_MS } from "#/lib/retention";
import { chunk, inChunks } from "./chunks";
import type { Db } from "./db";
import { heldShot, notSkippedFlaky } from "./markers";
import { builds, flakes, projects, snapshots } from "./schema";
import { effectiveDefaultBranch, parentJoin, parentProjects } from "./effective";

/**
 * Retention (PS-239): a build older than the window, on a branch that is not its project's
 * default, is deleted with its blobs and rows, unless a build that stays still points at it.
 *
 * The default branch has a window of its own (`mainDays`, `PIXELSLASH_RETENTION_MAIN_DAYS`), off
 * unless set. Under it, two kinds of default-branch build are never candidates however old:
 * - each project's newest default-branch build;
 * - a build that holds the current accepted shot of some test: for each snapshot key, the newest
 *   accepted shot on the default branch (what a new build's baseline would be).
 * Another default-branch build past the window is kept only when a build that stays points at it
 * directly. A default-branch build kept that way does not keep the default-branch builds it points at
 * in turn: each build's baseline is the one before it, so following that chain would keep them all.
 * Its compare view may then show no baseline image once the build before it is gone.
 *
 * What a build that stays can point at, and so what keeps another build alive:
 * - `baseline_key` and `main_baseline_key`: the image it was compared against, and what a removed
 *   marker shows (a marker's `image_key` is the baseline build's blob too).
 * - `image_key`: a shot stored by hash (PS-424) has no blob of its own and reads another build's.
 * - `baseline_snapshot_id` and `carried_from`: the shot it was compared against, and the shot whose
 *   undecided change it carries.
 * A branch build kept for that reason keeps what it points at in turn, so the references are followed
 * to a fixpoint. Without a main window, default-branch builds are never candidates, so they always
 * stay and always count.
 *
 * Flake evidence names builds too, but an open flake would pin a build forever: the evidence of a
 * deleted build is dropped from its flake instead.
 *
 * What it does not keep: a shot that only an expired build of the same branch held. A later build
 * of that branch then falls back to the accepted shot at its merge-base, the way a first build does.
 */

export type RetentionOptions = {
  /** The window for builds off the default branch, in days; undefined leaves them all. */
  days?: number | undefined;
  /** The window for default-branch builds, in days; undefined (the default) leaves them all. */
  mainDays?: number | undefined;
  now: Date;
  /** At most this many builds, oldest first; the rest wait for the next sweep. */
  limit?: number;
};

export type PlannedBuild = {
  id: string;
  projectId: string;
  orgId: string;
  branch: string;
  createdAt: Date;
  /** Which window it fell out of: `main` for a default-branch build. */
  window: Window;
  /** Every blob under `builds/<id>/` in the org's store, with its size. */
  blobs: { key: string; size: number }[];
};

export type Window = "branch" | "main";

/** A window that is on: its days and the date before which a build is past it. */
export type WindowPlan = { days: number; cutoff: Date };

export type RetentionPlan = {
  /** Null when that window is off. */
  branch: WindowPlan | null;
  main: WindowPlan | null;
  /** Builds past their window that nothing needs, oldest first. */
  expired: PlannedBuild[];
  /** Builds past their window that stay, because a build that stays points at them. */
  keptReferenced: string[];
  /**
   * Default-branch builds past the main window that are never candidates: a project's newest, or one
   * holding the current accepted shot of a test.
   */
  keptCurrent: string[];
};

export type RetentionResult = { buildsDeleted: number; blobsDeleted: number; bytesFreed: number };

type Candidate = Omit<PlannedBuild, "blobs">;

const windowOf = (days: number | undefined, now: Date): WindowPlan | null =>
  days === undefined ? null : { days, cutoff: new Date(now.getTime() - days * DAY_MS) };

/** The builds past `cutoff` on the default branch (`main`) or off it. */
async function pastWindow(db: Db, window: Window, cutoff: Date): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: builds.id,
      projectId: builds.projectId,
      orgId: projects.orgId,
      branch: builds.branch,
      createdAt: builds.createdAt,
    })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .leftJoin(parentProjects, parentJoin)
    .where(
      and(
        lt(builds.createdAt, cutoff),
        window === "main"
          ? eq(builds.branch, effectiveDefaultBranch())
          : ne(builds.branch, effectiveDefaultBranch()),
      ),
    )
    .orderBy(asc(builds.createdAt), asc(builds.id));
  return rows.map((row) => ({ ...row, window }));
}

/** Each project's newest default-branch build, of `projectIds`. */
async function newestMainBuilds(db: Db, projectIds: string[]): Promise<Set<string>> {
  const newest = new Set<string>();
  for (const projectId of projectIds) {
    const [row] = await db
      .select({ id: builds.id })
      .from(builds)
      .innerJoin(projects, eq(projects.id, builds.projectId))
      .leftJoin(parentProjects, parentJoin)
      .where(and(eq(builds.projectId, projectId), eq(builds.branch, effectiveDefaultBranch())))
      .orderBy(desc(builds.createdAt), desc(builds.id))
      .limit(1);
    if (row) newest.add(row.id);
  }
  return newest;
}

/**
 * The default-branch builds of `projectIds` that hold a current accepted shot: per project and
 * snapshot key (`snapshotKeyOf`'s five columns), the newest accepted shot on the default branch,
 * by the same rules a baseline is picked by (`baselines.ts`): a build that passed or a shot a
 * person accepted, in a build that was not rejected, never a removed marker or a skipped flaky shot,
 * and only a shot with a result. Ranked in SQL, so only the winning build ids are read back.
 */
async function currentAcceptedHolders(db: Db, projectIds: string[]): Promise<Set<string>> {
  // The five key columns; the window function ranks each key's shots newest first.
  const rank = sql<number>`row_number() over (partition by ${builds.projectId}, ${snapshots.name}, ${snapshots.platform}, ${snapshots.browser}, ${snapshots.viewport}, ${snapshots.theme} order by ${builds.createdAt} desc, ${builds.id} desc, ${snapshots.id} desc)`;
  const holders = new Set<string>();
  // `heldShot()` and `notSkippedFlaky()` bind a few values beside the ids.
  for (const part of chunk(projectIds, 8)) {
    const ranked = db
      .select({ buildId: snapshots.buildId, rank: rank.as("rank") })
      .from(snapshots)
      .innerJoin(builds, eq(builds.id, snapshots.buildId))
      .innerJoin(projects, eq(projects.id, builds.projectId))
      .leftJoin(parentProjects, parentJoin)
      .where(
        and(
          inArray(builds.projectId, part),
          eq(builds.branch, effectiveDefaultBranch()),
          inArray(builds.status, ["changes", "passed"]),
          or(eq(builds.status, "passed"), eq(snapshots.reviewState, "accepted")),
          or(isNotNull(snapshots.diffStatus), eq(snapshots.reviewState, "accepted")),
          heldShot(),
          notSkippedFlaky(),
        ),
      )
      .as("ranked");
    const rows = await db
      .selectDistinct({ buildId: ranked.buildId })
      .from(ranked)
      .where(eq(ranked.rank, 1));
    for (const row of rows) holders.add(row.buildId);
  }
  return holders;
}

/**
 * The builds past their windows that may go, oldest first, and the default-branch ones past the main
 * window that never may (`keptCurrent`).
 */
async function candidatesOf(
  db: Db,
  branch: WindowPlan | null,
  main: WindowPlan | null,
): Promise<{ candidates: Candidate[]; keptCurrent: string[] }> {
  const offMain = branch ? await pastWindow(db, "branch", branch.cutoff) : [];
  const onMain = main ? await pastWindow(db, "main", main.cutoff) : [];
  const projectIds = [...new Set(onMain.map((b) => b.projectId))];
  const current = new Set([
    ...(await newestMainBuilds(db, projectIds)),
    ...(await currentAcceptedHolders(db, projectIds)),
  ]);
  const candidates = [...offMain, ...onMain.filter((b) => !current.has(b.id))].toSorted(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || Number(a.id > b.id) - Number(a.id < b.id),
  );
  const keptCurrent = onMain.filter((b) => current.has(b.id)).map((b) => b.id);
  return { candidates, keptCurrent: keptCurrent.toSorted() };
}

/**
 * The candidate build each image key belongs to. A blob belongs to the build whose folder holds it
 * (`builds/<id>/...`), which is not always the build of the row naming it: a shot stored by hash
 * (PS-424) reads another build's image. A key outside that layout is its row's build's own. A key
 * whose folder is not a candidate has no owner here: that build stays for certain. An image stored
 * by content (`images/<sha256>.png`) is the org's, not a build's: the sweep never deletes it, so it
 * holds no build back.
 */
function blobOwners(
  shots: Array<{ buildId: string; imageKey: string }>,
  candidates: ReadonlySet<string>,
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const s of shots) {
    if (s.imageKey.startsWith("images/")) continue;
    const folder = /^builds\/([^/]+)\//.exec(s.imageKey)?.[1] ?? s.buildId;
    if (candidates.has(folder)) owners.set(s.imageKey, folder);
  }
  return owners;
}

/**
 * Who points at whom: `referencer build → builds it points at`, among `candidates`. A referencer
 * outside them is a build that stays for certain.
 */
async function referencesAmong(db: Db, candidates: Candidate[]): Promise<Map<string, Set<string>>> {
  const ids = candidates.map((c) => c.id);
  // `heldShot()` binds `removed` beside the ids.
  const own = await inChunks(ids, 1, (part) =>
    db
      .select({ id: snapshots.id, buildId: snapshots.buildId, imageKey: snapshots.imageKey })
      .from(snapshots)
      .where(and(inArray(snapshots.buildId, part), heldShot())),
  );
  const ownerOfKey = blobOwners(own, new Set(ids));
  const ownerOfShot = new Map(own.map((s) => [s.id, s.buildId]));

  const edges = new Map<string, Set<string>>();
  const point = (from: string, to: string | undefined) => {
    if (to === undefined || to === from) return;
    const set = edges.get(from) ?? new Set<string>();
    set.add(to);
    edges.set(from, set);
  };
  // Three columns are matched per statement, so each key binds three times.
  for (const keys of chunk([...ownerOfKey.keys()], 0, 3)) {
    const rows = await db
      .select({
        buildId: snapshots.buildId,
        imageKey: snapshots.imageKey,
        baselineKey: snapshots.baselineKey,
        mainBaselineKey: snapshots.mainBaselineKey,
      })
      .from(snapshots)
      .where(
        or(
          inArray(snapshots.imageKey, keys),
          inArray(snapshots.baselineKey, keys),
          inArray(snapshots.mainBaselineKey, keys),
        ),
      );
    for (const row of rows) {
      point(row.buildId, ownerOfKey.get(row.imageKey));
      point(row.buildId, ownerOfKey.get(row.baselineKey ?? ""));
      point(row.buildId, ownerOfKey.get(row.mainBaselineKey ?? ""));
    }
  }
  for (const shots of chunk([...ownerOfShot.keys()], 0, 2)) {
    const rows = await db
      .select({
        buildId: snapshots.buildId,
        baselineSnapshotId: snapshots.baselineSnapshotId,
        carriedFrom: snapshots.carriedFrom,
      })
      .from(snapshots)
      .where(
        or(inArray(snapshots.baselineSnapshotId, shots), inArray(snapshots.carriedFrom, shots)),
      );
    for (const row of rows) {
      point(row.buildId, ownerOfShot.get(row.baselineSnapshotId ?? ""));
      point(row.buildId, ownerOfShot.get(row.carriedFrom ?? ""));
    }
  }
  return edges;
}

/**
 * The candidates something that stays points at, directly or through another one that stays. A kept
 * build in `oneHop` (the default-branch candidates) keeps no other build of `oneHop` in turn: it
 * still keeps the branch builds it points at.
 */
export function referencedBuilds(
  candidateIds: ReadonlySet<string>,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
  oneHop: ReadonlySet<string> = new Set(),
): Set<string> {
  const kept = new Set<string>();
  const queue: string[] = [];
  const keep = (id: string) => {
    if (kept.has(id)) return;
    kept.add(id);
    queue.push(id);
  };
  for (const [from, to] of edges) if (!candidateIds.has(from)) to.forEach(keep);
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    const from = id;
    edges.get(from)?.forEach((to) => {
      if (!(oneHop.has(from) && oneHop.has(to))) keep(to);
    });
  }
  return kept;
}

/**
 * What a sweep with these options would delete, and how many bytes that frees. Reads the database
 * and lists the store; changes neither.
 */
export async function planRetention(
  db: Db,
  storeFor: (orgId: string) => SweepBlobStore,
  options: RetentionOptions,
): Promise<RetentionPlan> {
  const branch = windowOf(options.days, options.now);
  const main = windowOf(options.mainDays, options.now);
  const { candidates, keptCurrent } = await candidatesOf(db, branch, main);
  const ids = new Set(candidates.map((c) => c.id));
  const onMain = new Set(candidates.filter((c) => c.window === "main").map((c) => c.id));
  const kept = referencedBuilds(ids, await referencesAmong(db, candidates), onMain);
  const expired: PlannedBuild[] = [];
  // The limit counts what goes, not what is looked at: a chain of expired builds is judged whole.
  for (const build of candidates) {
    if (kept.has(build.id)) continue;
    if (expired.length === options.limit) break;
    const blobs = await storeFor(build.orgId).list(`builds/${build.id}`);
    expired.push({ ...build, blobs });
  }
  return { branch, main, expired, keptReferenced: [...kept].toSorted(), keptCurrent };
}

/**
 * Delete what `plan` lists: each build's blobs first, then its rows (its shots and their flags go
 * with it), so a sweep that stops half way leaves rows whose blobs are gone, which the next one
 * finishes, never blobs with no row to find them by.
 */
export async function applyRetention(
  db: Db,
  storeFor: (orgId: string) => SweepBlobStore,
  plan: RetentionPlan,
): Promise<RetentionResult> {
  const result: RetentionResult = { buildsDeleted: 0, blobsDeleted: 0, bytesFreed: 0 };
  for (const build of plan.expired) {
    await storeFor(build.orgId).deleteMany(build.blobs.map((b) => b.key));
    await db.delete(builds).where(eq(builds.id, build.id));
    result.buildsDeleted += 1;
    result.blobsDeleted += build.blobs.length;
    result.bytesFreed += build.blobs.reduce((sum, b) => sum + b.size, 0);
  }
  await dropEvidenceOf(db, plan.expired);
  return result;
}

/** A flake keeps its row and its other evidence; what a deleted build contributed goes. */
async function dropEvidenceOf(db: Db, deleted: PlannedBuild[]): Promise<void> {
  const gone = new Set(deleted.map((b) => b.id));
  const projectIds = [...new Set(deleted.map((b) => b.projectId))];
  const rows = await inChunks(projectIds, 0, (part) =>
    db
      .select({ id: flakes.id, evidence: flakes.evidence })
      .from(flakes)
      .where(inArray(flakes.projectId, part)),
  );
  for (const row of rows) {
    const kept = row.evidence.filter((e) => !gone.has(e.buildId));
    if (kept.length === row.evidence.length) continue;
    await db.update(flakes).set({ evidence: kept }).where(eq(flakes.id, row.id));
  }
}

/**
 * Plan a sweep and, unless `dryRun`, carry it out. A dry run reads and lists and nothing else: it
 * is the default everywhere a sweep is started, and deleting is always the caller saying so.
 */
export async function sweepRetention(
  db: Db,
  storeFor: (orgId: string) => SweepBlobStore,
  options: RetentionOptions & { dryRun: boolean },
): Promise<{ plan: RetentionPlan; result: RetentionResult | null }> {
  const plan = await planRetention(db, storeFor, options);
  if (options.dryRun) return { plan, result: null };
  return { plan, result: await applyRetention(db, storeFor, plan) };
}
