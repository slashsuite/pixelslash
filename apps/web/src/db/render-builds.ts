import { and, eq, inArray, isNotNull, min, ne, or } from "drizzle-orm";
import type { Db } from "./db";
import { builds, projects } from "./schema";

/** What a render token's build is: its project, status, plan and age; null when there is no such build. */
export async function renderBuildRow(db: Db, buildId: string) {
  const [row] = await db
    .select({
      projectId: builds.projectId,
      status: builds.status,
      plan: builds.renderPlan,
      at: builds.createdAt,
    })
    .from(builds)
    .where(eq(builds.id, buildId));
  return row ?? null;
}

/**
 * Error a bundle build whose render failed, only while it is still uploading. False when it had
 * already moved on (its finalise landed first), so nothing else about it is touched.
 */
export async function errorRenderBuild(db: Db, buildId: string, message: string): Promise<boolean> {
  const changed = await db
    .update(builds)
    .set({ status: "errored", error: message })
    .where(and(eq(builds.id, buildId), eq(builds.status, "uploading")))
    .returning({ id: builds.id });
  return changed.length > 0;
}

/** What a superseded build's `error` says: the newer head, so the reader knows where to look. */
export const supersededReason = (commitSha: string, prNumber: number) =>
  `superseded: commit ${commitSha.slice(0, 7)} of pull request #${prNumber} was uploaded after this build, so it was not rendered`;

/**
 * A new head of a pull request makes the bundle builds of its older heads moot: they would render,
 * at minutes each, only for a commit nobody reviews, and the new head's builds wait behind them in
 * the renderer's queue. End `errored` every bundle build of the project's group (its root project
 * and the root's subprojects) on that pull request that is still `uploading` at an older head, and
 * return the ended ids.
 *
 * Older is by arrival: a head is older when its first build on the pull request, in the group, came
 * before `commitSha`'s first. Git cannot say it (`ancestorShas` are the merge-base's, not the
 * head's), and arrival keeps a late build of an old run (one CI did not cancel in time) from ending
 * the new head's builds: its commit was seen first. A client capture is never ended: its own run
 * sends its shots, and that run is CI's to cancel. Each update holds `uploading`, so a build that
 * finalised meanwhile stays as it is.
 */
export async function supersedeBundleBuilds(
  db: Db,
  projectId: string,
  { commitSha, prNumber }: { commitSha: string; prNumber: number | null },
): Promise<string[]> {
  if (prNumber === null) return [];
  const [project] = await db
    .select({ id: projects.id, parent: projects.parentProjectId })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) return [];
  const root = project.parent ?? project.id;
  const group = db
    .select({ id: projects.id })
    .from(projects)
    .where(or(eq(projects.id, root), eq(projects.parentProjectId, root)));
  const onPr = and(inArray(builds.projectId, group), eq(builds.prNumber, prNumber));
  const waiting = await db
    .select({ id: builds.id, commitSha: builds.commitSha })
    .from(builds)
    .where(
      and(
        onPr,
        eq(builds.status, "uploading"),
        isNotNull(builds.renderPlan),
        ne(builds.commitSha, commitSha),
      ),
    );
  if (waiting.length === 0) return [];
  const shas = [...new Set([commitSha, ...waiting.map((b) => b.commitSha)])];
  const firsts = await db
    .select({ commitSha: builds.commitSha, at: min(builds.createdAt) })
    .from(builds)
    .where(and(onPr, inArray(builds.commitSha, shas)))
    .groupBy(builds.commitSha);
  const first = new Map(firsts.map((f) => [f.commitSha, f.at?.getTime() ?? Infinity]));
  const head = first.get(commitSha) ?? Infinity;
  const error = supersededReason(commitSha, prNumber);
  const ended: string[] = [];
  for (const b of waiting) {
    if ((first.get(b.commitSha) ?? Infinity) >= head) continue;
    if (await errorRenderBuild(db, b.id, error)) ended.push(b.id);
  }
  return ended;
}
