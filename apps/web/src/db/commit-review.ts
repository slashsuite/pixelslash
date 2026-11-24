import { and, desc, eq, ne, sql } from "drizzle-orm";
import { awaitsDecision, holdsChange } from "#/lib/snapshot-groups";
import { type MemberBuild, commitGroup } from "./commit-group";
import type { Db } from "./db";
import { type SnapshotView, buildView } from "./review";
import { builds } from "./schema";

/*
 * The combined review of a top-level project and its subprojects on one commit: every shot that
 * holds a change, waiting or decided, in the newest build of each member there. The rows are each
 * build's own snapshot rows, so a decision made here is the one its build page shows, and the
 * reverse. A member that did not run on the commit (`commitGroup`: no build, or a skipped one) is
 * listed as not run, with its last build elsewhere, and counts no change.
 */

/** A group's tally of its changes, as its heading shows them. */
export type ChangeTotals = { changes: number; waiting: number; accepted: number; rejected: number };

export type CommitReviewGroup = {
  projectId: string;
  name: string;
  top: boolean;
  /** Its newest build on the commit; null when it did not run there. */
  build: MemberBuild | null;
  /** When it did not run: its newest build on another commit, if it has one. */
  lastBuild: { id: string; commitSha: string } | null;
  totals: ChangeTotals;
  /** The shots that hold a change, in the build page's review order. */
  snapshots: SnapshotView[];
};

export type CommitReview = {
  groups: CommitReviewGroup[];
  totals: ChangeTotals;
  /** The branch and PR of the commit's newest build; null when no member built it at all. */
  head: { branch: string; prNumber: number | null } | null;
};

/** A flaky shot its config skips is pending yet waits for no one, so it is a change, not waiting. */
function totalsOf(shots: SnapshotView[]): ChangeTotals {
  const of = (state: SnapshotView["reviewState"]) =>
    shots.filter((s) => s.reviewState === state).length;
  return {
    changes: shots.length,
    waiting: shots.filter(awaitsDecision).length,
    accepted: of("accepted"),
    rejected: of("rejected"),
  };
}

/** The project's newest build on a commit other than `commitSha`: where its shots were last taken. */
async function lastBuildOf(db: Db, projectId: string, commitSha: string) {
  const [row] = await db
    .select({ id: builds.id, commitSha: builds.commitSha })
    .from(builds)
    .where(and(eq(builds.projectId, projectId), ne(builds.commitSha, commitSha)))
    .orderBy(desc(builds.createdAt), desc(sql`${builds}.rowid`))
    .limit(1);
  return row ?? null;
}

/** The commit's combined review for `topProjectId`, a top-level project: itself first, then its subprojects by name. */
export async function commitReview(
  db: Db,
  topProjectId: string,
  commitSha: string,
): Promise<CommitReview> {
  const members = await commitGroup(db, topProjectId, commitSha);
  const views = await Promise.all(
    members.map((m) => (m.build ? buildView(db, m.projectId, m.build.id) : Promise.resolve(null))),
  );
  const groups = await Promise.all(
    members.map(async (m, index): Promise<CommitReviewGroup> => {
      const snapshots = views[index]?.snapshots.filter(holdsChange) ?? [];
      return {
        projectId: m.projectId,
        name: m.name,
        top: m.top,
        build: m.build,
        lastBuild: m.build ? null : await lastBuildOf(db, m.projectId, commitSha),
        totals: totalsOf(snapshots),
        snapshots,
      };
    }),
  );
  const newest = views
    .flatMap((v) => (v ? [v.build] : []))
    .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return {
    groups,
    totals: totalsOf(groups.flatMap((g) => g.snapshots)),
    head: newest ? { branch: newest.branch, prNumber: newest.prNumber } : null,
  };
}
