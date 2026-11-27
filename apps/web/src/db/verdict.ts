import { and, eq, inArray } from "drizzle-orm";
import { awaitsDecision } from "#/lib/snapshot-groups";
import type { Db } from "./db";
import { builds, snapshots } from "./schema";

/**
 * Build status after the diff (ob 1470, review model 1422). A changed shot blocks until it is
 * accepted or rejected, and so does an unchanged one that carries a change still open on the
 * branch's previous build (ob 1712) or one that differs from main and was never accepted (PS-284). A
 * new shot waits like a change (PS-284); removed shots never block; any rejection fails the build
 * until a new build arrives. `passed` therefore means "nothing left to decide", not "no
 * differences".
 */
export type Verdict = "changes" | "passed" | "failed";

export function verdictOf(rows: Parameters<typeof awaitsDecision>[0][]): Verdict {
  if (rows.some((row) => row.reviewState === "rejected")) return "failed";
  if (rows.some(awaitsDecision)) return "changes";
  return "passed";
}

/** The verdict the build's shots add up to. */
async function verdictOfBuild(db: Db, buildId: string): Promise<Verdict> {
  const rows = await db
    .select({
      diffStatus: snapshots.diffStatus,
      reviewState: snapshots.reviewState,
      carriedFrom: snapshots.carriedFrom,
      staleOf: snapshots.staleOf,
      flakeId: snapshots.flakeId,
      flakyPolicy: snapshots.flakyPolicy,
    })
    .from(snapshots)
    .where(eq(snapshots.buildId, buildId));
  return verdictOf(rows);
}

export const VERDICT_STATUSES: Verdict[] = ["changes", "passed", "failed"];

/**
 * Recompute the verdict of a build that already has one (a review decision, an explain settling, a flaky shot).
 * It writes only over a verdict: a `processing` or `errored` build is a run's, and a late writer
 * must not turn it into one (PS-392). Returns the verdict it wrote, or null when it wrote nothing
 * because the build is not at a verdict.
 */
export async function refreshBuildStatus(db: Db, buildId: string): Promise<Verdict | null> {
  const status = await verdictOfBuild(db, buildId);
  const written = await db
    .update(builds)
    .set({ status })
    .where(and(eq(builds.id, buildId), inArray(builds.status, VERDICT_STATUSES)))
    .returning({ id: builds.id });
  return written.length > 0 ? status : null;
}

/**
 * The end of a diff run: give the build its verdict, if this run still holds the claim. The write
 * is fenced on `processing` and on the run's own `startedAt`, which `claim` and `claimForRerun`
 * stored as `processingStartedAt`: a run that outlived its claim (`STALE_PROCESSING_MS`) and a
 * successor that took the build over can then not both write the final status (PS-392). Returns
 * the verdict, or null when nothing was written: the build is no longer this run's.
 */
export async function finishRun(db: Db, buildId: string, startedAt: Date): Promise<Verdict | null> {
  const status = await verdictOfBuild(db, buildId);
  const written = await db
    .update(builds)
    .set({ status })
    .where(
      and(
        eq(builds.id, buildId),
        eq(builds.status, "processing"),
        eq(builds.processingStartedAt, startedAt),
      ),
    )
    .returning({ id: builds.id });
  return written.length > 0 ? status : null;
}

/** A finished build whose stored verdict is not the one its shots add up to under today's rule. */
export type StaleVerdict = { buildId: string; from: Verdict; to: Verdict };

/**
 * Bring every finished build's stored verdict up to today's rule (PS-430): a build written under an
 * older rule (one where a new shot did not wait, PS-284) can say `passed` with a decision still open.
 * It lists what differs and, only with `apply`, writes it, each write fenced on the status it read, so
 * a review that lands meanwhile wins. Builds that are `processing` or `errored` are a run's and are
 * left alone. Additive and idempotent: a second run finds nothing, since every write is the verdict
 * the same rule reads back.
 */
export async function recomputeVerdicts(
  db: Db,
  options: { apply: boolean },
): Promise<StaleVerdict[]> {
  const finished = await db
    .select({ id: builds.id, status: builds.status })
    .from(builds)
    .where(inArray(builds.status, VERDICT_STATUSES));
  const stale: StaleVerdict[] = [];
  for (const build of finished) {
    const from = VERDICT_STATUSES.find((status) => status === build.status);
    if (!from) continue;
    const to = await verdictOfBuild(db, build.id);
    if (to === from) continue;
    stale.push({ buildId: build.id, from, to });
    if (options.apply)
      await db
        .update(builds)
        .set({ status: to })
        .where(and(eq(builds.id, build.id), eq(builds.status, from)));
  }
  return stale;
}
