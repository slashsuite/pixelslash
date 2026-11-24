import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { type BuildCounts, countBuilds, emptyCounts } from "./build-counts";
import type { Db } from "./db";
import { type BuildStatus, builds, projects } from "./schema";

/*
 * A top-level project and its subprojects on one commit: the newest build of each there. The
 * commit status, the PR comment and the combined review page all read the group from here.
 */

/** A build as the group sees it. */
export type MemberBuild = {
  id: string;
  projectId: string;
  status: BuildStatus;
  error: string | null;
};

/** A project of the group: the top-level project itself, or one of its subprojects. */
export type GroupMember = {
  projectId: string;
  name: string;
  /** The top-level project, whose own builds are its lane beside the subprojects'. */
  top: boolean;
  /** Its newest build on the commit; null when it did not run there: no build, or a skipped one. */
  build: MemberBuild | null;
  counts: BuildCounts;
};

/** `upload --skipped` leaves a passed build that holds no shot: the member did not run. */
const skipped = (b: MemberBuild, c: BuildCounts) =>
  b.status === "passed" &&
  c.changed + c.new + c.removed + c.unchanged + c.rebaseline + c.unmeasured === 0;

/**
 * The top-level project of `projectId` and its subprojects, each with its newest build on
 * `commitSha` and that build's counts; the top-level project first, then its subprojects by name.
 */
export async function commitGroup(
  db: Db,
  topProjectId: string,
  commitSha: string,
): Promise<GroupMember[]> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, parent: projects.parentProjectId })
    .from(projects)
    .where(or(eq(projects.id, topProjectId), eq(projects.parentProjectId, topProjectId)));
  const onCommit = await db
    .select({
      id: builds.id,
      projectId: builds.projectId,
      status: builds.status,
      error: builds.error,
    })
    .from(builds)
    .where(
      and(
        inArray(
          builds.projectId,
          rows.map((r) => r.id),
        ),
        eq(builds.commitSha, commitSha),
      ),
    )
    // Two isolates can still write one `created_at` millisecond, so the insert order (`rowid`)
    // breaks a tie; the random id cannot, and a rerun must win over the build it replaces.
    .orderBy(desc(builds.createdAt), desc(sql`${builds}.rowid`));
  // Newest first, so the first build met per project is the one that counts.
  const newest = new Map<string, MemberBuild>();
  for (const b of onCommit) if (!newest.has(b.projectId)) newest.set(b.projectId, b);
  const counts = await countBuilds(
    db,
    [...newest.values()].map((b) => b.id),
  );
  const members = rows.map((r) => {
    const found = newest.get(r.id);
    const tally = (found && counts.get(found.id)) ?? emptyCounts();
    const build = found && !skipped(found, tally) ? found : null;
    return {
      projectId: r.id,
      name: r.name,
      top: r.parent === null,
      build,
      counts: build ? tally : emptyCounts(),
    };
  });
  return members.toSorted((a, b) => Number(b.top) - Number(a.top) || a.name.localeCompare(b.name));
}

/** Whether the top-level project has subprojects: a plain project keeps its one-build status. */
export async function hasSubprojects(db: Db, topProjectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.parentProjectId, topProjectId))
    .limit(1);
  return row !== undefined;
}
