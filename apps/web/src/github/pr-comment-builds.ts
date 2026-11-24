import { and, count, desc, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { explaining } from "#/ai/explain-pending";
import { countBuilds, emptyCounts } from "#/db/build-counts";
import { commitGroup } from "#/db/commit-group";
import type { Db } from "#/db/db";
import { mostChangedShots } from "#/db/open-shots";
import { builds, projects } from "#/db/schema";
import type { RepoName } from "./app";
import { commitReviewUrl, detailsUrlOf } from "./build-text";
import type { PrCommentBuild, PrCommentDeps, ProjectBuild } from "./pr-comment";
import { groupBuild, memberLines } from "./pr-comment-group";

/*
 * What the PR comment is built from: the PR's head as we know it, and each project's newest build
 * of the PR there, a project with subprojects as one section for the group.
 */

/** How many shots the comment links; the build page has the rest. */
const NAMED_SHOTS = 5;

export type PrKey = { orgId: string; repo: string; prNumber: number };

/** A build's top-level project: its own, or its subproject's parent. */
const tops = alias(projects, "top_project");
const topOfBuild = or(
  eq(tops.id, projects.parentProjectId),
  and(isNull(projects.parentProjectId), eq(tops.id, projects.id)),
);

/** The org's top-level projects on the repo (case ignored) that comment on pull requests. */
export const commentingOnRepo = (pr: PrKey, on: typeof projects | typeof tops = projects) =>
  and(
    eq(on.orgId, pr.orgId),
    isNull(on.parentProjectId),
    eq(on.githubComment, true),
    eq(sql`lower(${on.githubRepo})`, pr.repo),
  );

/** Newest first; `created_at` has a second's resolution, so the insert order (`rowid`) breaks a tie. */
const newestFirst = [desc(builds.createdAt), desc(sql`${builds}.rowid`)] as const;

/**
 * The commit of the PR's newest build with a verdict in any of the repo's projects (or their
 * subprojects): the PR's head as
 * we know it. A build still uploading or diffing does not move it, so the comment keeps the last
 * verdict until the new commit has one.
 */
export async function headOf(db: Db, pr: PrKey): Promise<string | null> {
  const [newest] = await db
    .select({ sha: builds.commitSha })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .innerJoin(tops, topOfBuild)
    .where(
      and(
        commentingOnRepo(pr, tops),
        eq(builds.prNumber, pr.prNumber),
        notInArray(builds.status, ["uploading", "processing"]),
      ),
    )
    .orderBy(...newestFirst)
    .limit(1);
  return newest?.sha ?? null;
}

/** The section of a project with subprojects: every member's newest build on the head. */
async function groupSection(
  deps: PrCommentDeps,
  top: { id: string; name: string },
  { pr, repo, headSha }: { pr: PrKey; repo: RepoName; headSha: string },
): Promise<ProjectBuild> {
  const members = await commitGroup(deps.db, top.id, headSha);
  const { counts, ...state } = groupBuild(members);
  const origin = deps.publicUrl?.replace(/\/+$/, "");
  return {
    build: {
      id: top.id,
      projectId: top.id,
      ...state,
      commitSha: headSha,
      repo,
      orgId: pr.orgId,
      prNumber: pr.prNumber,
      comment: true,
    },
    projectName: top.name,
    counts,
    summary: null,
    summaryPending: false,
    shots: [],
    pageUrl: origin ? commitReviewUrl(origin, top.id, headSha) : undefined,
    members: memberLines(deps.publicUrl, members),
  };
}

/** Each project's newest build of the PR on `headSha`, ordered by project name. */
export async function projectBuilds(
  deps: PrCommentDeps,
  pr: PrKey,
  repo: RepoName,
  headSha: string,
): Promise<ProjectBuild[]> {
  const { db } = deps;
  const rows = await db
    .select({
      id: builds.id,
      projectId: builds.projectId,
      status: builds.status,
      error: builds.error,
      commitSha: builds.commitSha,
      prNumber: builds.prNumber,
      aiSummary: builds.aiSummary,
      queuedAt: builds.aiSummaryQueuedAt,
      projectName: projects.name,
      topId: tops.id,
      topName: tops.name,
      grouped: sql<number>`exists (select 1 from projects as sub where sub.parent_project_id = ${tops.id})`,
    })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .innerJoin(tops, topOfBuild)
    .where(
      and(
        commentingOnRepo(pr, tops),
        eq(builds.prNumber, pr.prNumber),
        eq(builds.commitSha, headSha),
      ),
    )
    .orderBy(...newestFirst);
  // A project with subprojects is one section for the group, whichever member built the head.
  const groups = new Map<string, { id: string; name: string }>();
  const newest = new Map<string, Omit<(typeof rows)[number], "topId" | "topName" | "grouped">>();
  for (const { topId, topName, grouped, ...row } of rows)
    if (grouped) groups.set(topId, { id: topId, name: topName });
    else if (!newest.has(row.projectId)) newest.set(row.projectId, row);
  const picked = [...newest.values()];
  const counts = await countBuilds(
    db,
    picked.map((r) => r.id),
  );
  const now = Date.now();
  // Shots are skipped only where no section lists them: errored, still diffing, or passed unchanged.
  // A build of new shots alone has no `changed` but lists them, so `changed` alone is not the test.
  const shows = (status: string, id: string) =>
    status !== "errored" &&
    status !== "uploading" &&
    status !== "processing" &&
    !(status === "passed" && (counts.get(id)?.changed ?? 0) === 0);
  const sections = await Promise.all([
    ...[...groups.values()].map((top) => groupSection(deps, top, { pr, repo, headSha })),
    ...picked.map(async ({ aiSummary, queuedAt, projectName, ...row }) => {
      const build: PrCommentBuild = { ...row, repo, orgId: pr.orgId, comment: true };
      return {
        build,
        projectName,
        counts: counts.get(row.id) ?? emptyCounts(),
        summary: aiSummary ?? null,
        summaryPending: explaining(queuedAt ?? null, now),
        shots: shows(row.status, row.id) ? await mostChangedShots(db, row.id, NAMED_SHOTS) : [],
        pageUrl: detailsUrlOf(deps.publicUrl, build),
      };
    }),
  ]);
  return sections.toSorted((a, b) => a.projectName.localeCompare(b.projectName));
}

/** How many of the org's projects on the repo comment: one keeps the single-project body. */
export async function commentingCount(db: Db, pr: PrKey): Promise<number> {
  const [row] = await db.select({ n: count() }).from(projects).where(commentingOnRepo(pr));
  return row?.n ?? 0;
}
