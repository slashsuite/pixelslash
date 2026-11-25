import { and, eq } from "drizzle-orm";
import { awaitsDecision, holdsChange } from "#/lib/snapshot-groups";
import { commitGroup, hasSubprojects } from "./commit-group";
import { type Db, NotFoundError } from "./db";
import { type SnapshotView, afterDecision, buildView } from "./review";
import { type BuildStatus, builds, projects } from "./schema";

/*
 * A commit's change set: every shot that holds a change in the newest build of a top-level project
 * and of each of its subprojects on one commit, in the commit page's order (the top-level project
 * first, then its subprojects by name, each in its build page's order). A review that starts on any
 * of those builds walks the whole set, so accepting the last change of one subproject moves on to
 * the next subproject's, and the counter counts the set.
 */

/** Where a shot of the set lives: what the shot page's address needs. */
export type ShotRef = { projectId: string; buildId: string; snapshotId: string };

type Step = ShotRef & { shot: SnapshotView; decidable: boolean };

export type ChangeSet = { topProjectId: string; commitSha: string; steps: Step[] };

/**
 * The change set the build belongs to, or null when there is none to walk: its project has no
 * subprojects and is no subproject, or the build is not its project's newest on the commit (an
 * older run, whose shots the set does not hold).
 */
export async function changeSetOf(
  db: Db,
  projectId: string,
  buildId: string,
): Promise<ChangeSet | null> {
  const [build] = await db
    .select({ id: builds.id, commitSha: builds.commitSha })
    .from(builds)
    .where(and(eq(builds.id, buildId), eq(builds.projectId, projectId)));
  if (!build) throw new NotFoundError("build");
  const [row] = await db
    .select({ parent: projects.parentProjectId })
    .from(projects)
    .where(eq(projects.id, projectId));
  const topProjectId = row?.parent ?? projectId;
  if (!(await hasSubprojects(db, topProjectId))) return null;
  const members = await commitGroup(db, topProjectId, build.commitSha);
  if (!members.some((m) => m.build?.id === build.id)) return null;
  const steps = await Promise.all(
    members.map(async (m): Promise<Step[]> => {
      if (!m.build) return [];
      const { id, status } = m.build;
      const decidable = status === "changes" || status === "passed";
      const view = await buildView(db, m.projectId, id);
      return view.snapshots.filter(holdsChange).map((shot) => ({
        projectId: m.projectId,
        buildId: id,
        snapshotId: shot.id,
        shot,
        decidable,
      }));
    }),
  );
  return { topProjectId, commitSha: build.commitSha, steps: steps.flat() };
}

/**
 * The first shot still waiting for a decision in another build of the set, starting with the
 * builds after `buildId` and wrapping to the earlier ones; null when none waits. A build that
 * takes no decisions (failed, or not finished) is passed over.
 */
export function nextInOtherBuild(set: ChangeSet, buildId: string): ShotRef | null {
  const at = set.steps.findIndex((s) => s.buildId === buildId);
  const ordered = at < 0 ? set.steps : [...set.steps.slice(at), ...set.steps.slice(0, at)];
  const next = ordered.find((s) => s.buildId !== buildId && s.decidable && awaitsDecision(s.shot));
  return next
    ? { projectId: next.projectId, buildId: next.buildId, snapshotId: next.snapshotId }
    : null;
}

/**
 * Where a shot sits among the changes a reviewer decides on: its place (null when it holds none)
 * and their count. Those are the set's when the build has one, else its own build's (`shots`).
 */
export function positionInSet(set: ChangeSet | null, shots: SnapshotView[], snapshotId: string) {
  const ids = set ? set.steps.map((s) => s.snapshotId) : shots.filter(holdsChange).map((s) => s.id);
  const at = ids.indexOf(snapshotId);
  return { index: at < 0 ? null : at + 1, total: ids.length };
}

/** Where an accept sends the reviewer: the build's status after it, the next shot, and the set's commit. */
export type NextStep = {
  buildStatus: BuildStatus;
  /** The next shot that waits, in this build first, then in the rest of the change set; null when none does. */
  next: ShotRef | null;
  /**
   * The commit whose change set the build belongs to, read only once this build has nothing left:
   * the done screen when nothing waits anywhere. Null for a lone build, or while this build still waits.
   */
  commit: { projectId: string; sha: string } | null;
};

/**
 * `afterDecision`, across the change set: once the build has nothing left to decide, the next shot
 * is the first that waits in the set's other builds, and only when none does is the review done.
 */
export async function nextAfterDecision(
  db: Db,
  input: { projectId: string; buildId: string; snapshotId: string },
): Promise<NextStep> {
  const { buildStatus, nextToReviewId } = await afterDecision(db, input);
  // Still one waiting here: the set is not read, since the reviewer stays in this build.
  if (nextToReviewId) {
    const { projectId, buildId } = input;
    return { buildStatus, next: { projectId, buildId, snapshotId: nextToReviewId }, commit: null };
  }
  const set = await changeSetOf(db, input.projectId, input.buildId);
  if (!set) return { buildStatus, next: null, commit: null };
  return {
    buildStatus,
    next: nextInOtherBuild(set, input.buildId),
    commit: { projectId: set.topProjectId, sha: set.commitSha },
  };
}
