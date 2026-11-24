import { and, count, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { explaining } from "#/ai/explain-pending";
import { type BuildCounts, countBuilds, emptyCounts } from "#/db/build-counts";
import type { Db } from "#/db/db";
import type { AiSummary } from "#/db/diff-json";
import { type ChangedShot, mostChangedShots } from "#/db/open-shots";
import { builds, projects } from "#/db/schema";
import { prComments } from "#/db/schema-pr-comments";
import { type GithubApp, GithubError, type RepoName, field } from "./app";
import { type SyncedBuild, countsTable, detailsUrlOf, plural, titleOf } from "./build-text";

/*
 * The PixelSlash comment on a pull request (PS-82): one per PR for all of an org's projects on the
 * repo, created by the first build that names the PR and edited in place by each later one, never a
 * new comment per push or per project. Every sync rebuilds the whole body from each project's newest
 * build on the PR's head commit: a section per project with something to show (the project model's
 * summary, or a plain statement that there is none, the counts, the most changed shots as links and
 * the build page), then one line naming the projects with no visual changes. Text and links only: no screenshot ever goes to GitHub
 * (invariant 4). GitHub is told, never asked: the caller logs a failed call and the build's
 * verdict and the request that synced it are untouched.
 */

/** Marks the comment as ours, for a person reading the source and for anything that lists them. */
export const COMMENT_MARKER = "<!-- pixelslash:pr-comment -->";

/** How many shots the comment links; the build page has the rest. */
const NAMED_SHOTS = 5;

type PrCommentDeps = { db: Db; publicUrl: string | undefined };

/** What the comment needs of the synced build; the commit status's row has all of it. */
export type PrCommentBuild = SyncedBuild & {
  commitSha: string;
  repo: RepoName;
  /** The org of the build's top-level project: the comment is the org's on the repo. */
  orgId: string;
  prNumber: number | null;
  /** The project's setting: off sends no comment. */
  comment: boolean;
};

/**
 * Text from a model, a CLI or a person goes into a Markdown comment: `@` and the characters that
 * make links, HTML or code are defused, so nothing in it can notify someone or change the layout.
 */
export function plain(text: string): string {
  return text.replace(/[\\`[\]<>]/g, "\\$&").replaceAll("@", "@​");
}

/** "120 px changed", and the blocks that moved intact when there are any. */
function measuredLine(shot: ChangedShot): string {
  const changed = `${shot.changedPixels} px changed`;
  if (shot.movedBlocks === 0) return changed;
  return `${changed}, ${plural(shot.movedBlocks, "block")} moved intact`;
}

const shotLabel = (shot: ChangedShot) => `${shot.name} (${shot.viewport}, ${shot.theme})`;

function shotLines(shots: ChangedShot[], pageUrl: string | undefined): string[] {
  if (shots.length === 0) return [];
  const lines = shots.map((shot) => {
    const label = plain(shotLabel(shot));
    const named = pageUrl ? `[${label}](${pageUrl}/snapshots/${shot.id})` : label;
    return `- ${named}: ${shot.kind === "new" ? "new shot" : measuredLine(shot)}`;
  });
  return ["", `Most changed shots:`, ...lines];
}

/** The model's summary, or the plain statement that there is none: never an invented one. */
function summaryLines(summary: AiSummary | null, pending: boolean): string[] {
  if (summary) {
    const sentences = summary.sentences.map((s) => plain(s.text));
    const match = summary.match ? [`Against the brief: ${plain(summary.match.text)}`] : [];
    return [sentences.join(" "), ...(match.length > 0 ? ["", ...match] : [])];
  }
  if (pending) return ["The summary is being written; this comment is edited when it is ready."];
  return [
    "Summary skipped: this project has no model that made one. The counts and shots below were measured.",
  ];
}

/** One project's newest build on the PR's head, with what its section shows. */
type ProjectBuild = {
  build: PrCommentBuild;
  projectName: string;
  counts: BuildCounts;
  summary: AiSummary | null;
  summaryPending: boolean;
  shots: ChangedShot[];
  pageUrl: string | undefined;
};

const diffing = ({ build }: ProjectBuild) =>
  build.status === "uploading" || build.status === "processing";
/** Nothing to show beyond a name: passed with no change (`titleOf`'s "No visual changes"). */
const unchanged = ({ build, counts }: ProjectBuild) =>
  build.status === "passed" && counts.changed === 0;
const sum = (all: ProjectBuild[], pick: (counts: BuildCounts) => number) =>
  all.reduce((n, p) => n + pick(p.counts), 0);

/** The one-line total over the projects, e.g. "39 changes to review in 2 of 16 projects". */
function overallTitle(all: ProjectBuild[]): string {
  const of = (n: number) =>
    n === all.length ? plural(n, "project") : `${n} of ${all.length} projects`;
  // Only a build with a verdict is counted: an errored or re-diffing one may hold a partial count.
  const decided = all.filter((p) => !diffing(p) && p.build.status !== "errored");
  const counted = (pick: (counts: BuildCounts) => number, what: string) => {
    const total = sum(decided, pick);
    const showing = decided.filter((p) => pick(p.counts) > 0).length;
    return total > 0 ? [`${plural(total, "change")} ${what} in ${of(showing)}`] : [];
  };
  const errored = all.filter((p) => p.build.status === "errored").length;
  const parts = [
    ...counted((c) => c.toReview, "to review"),
    ...counted((c) => c.rejected, "rejected"),
    ...(errored > 0 ? [`${of(errored)} errored`] : []),
  ];
  if (parts.length > 0) return parts.join("; ");
  const stillDiffing = all.filter(diffing).length;
  if (stillDiffing > 0) return `Diffing the shots of ${of(stillDiffing)}`;
  if (all.every(unchanged)) return `No visual changes in ${of(all.length)}`;
  return `All changes accepted in ${of(all.filter((p) => !unchanged(p)).length)}`;
}

/** A project's summary, counts and shots; an errored or still diffing build shows its title only. */
function detailLines(p: ProjectBuild): string[] {
  if (p.build.status === "errored" || diffing(p)) return [];
  return [
    ...summaryLines(p.summary, p.summaryPending),
    "",
    ...countsTable(p.counts),
    ...shotLines(p.shots, p.pageUrl),
  ];
}

/** The names of the projects a line lists, defused and joined. */
const names = (all: ProjectBuild[]) => all.map((p) => plain(p.projectName)).join(", ");

/**
 * The comment's Markdown, from each project's newest build on the PR's head (at least one). A repo
 * with one commenting project reads as it did before projects shared the comment: no per-project
 * heading. With several, every section is named, even when only one of them built the head.
 */
export function commentOf(all: ProjectBuild[], headSha: string, alone: boolean): string {
  const sha = `\`${headSha.slice(0, 7)}\``;
  const [only] = all;
  if (alone && only) {
    const link = only.pageUrl ? `: [Review the build](${only.pageUrl})` : "";
    const details = detailLines(only);
    return [
      COMMENT_MARKER,
      `### PixelSlash: ${plain(titleOf(only.build, only.counts))}`,
      "",
      ...details,
      ...(details.length > 0 ? [""] : []),
      `Build of ${sha}${link}`,
    ].join("\n");
  }
  const shown = all.filter((p) => !diffing(p) && !unchanged(p));
  const sections = shown.flatMap((p) => [
    `#### ${plain(p.projectName)}: ${plain(titleOf(p.build, p.counts))}`,
    "",
    ...detailLines(p),
    ...(p.pageUrl ? ["", `[Review the build](${p.pageUrl})`] : []),
    "",
  ]);
  const stillDiffing = all.filter(diffing);
  const noChange = all.filter(unchanged);
  return [
    COMMENT_MARKER,
    `### PixelSlash: ${plain(overallTitle(all))}`,
    "",
    ...sections,
    ...(stillDiffing.length > 0 ? [`Still diffing: ${names(stillDiffing)}.`, ""] : []),
    ...(noChange.length > 0 ? [`No visual changes: ${names(noChange)}.`, ""] : []),
    `Builds of ${sha}`,
  ].join("\n");
}

type PrKey = { orgId: string; repo: string; prNumber: number };

/** The org's top-level projects on the repo (case ignored) that comment on pull requests. */
const commentingOnRepo = (pr: PrKey) =>
  and(
    eq(projects.orgId, pr.orgId),
    isNull(projects.parentProjectId),
    eq(projects.githubComment, true),
    eq(sql`lower(${projects.githubRepo})`, pr.repo),
  );

/** Newest first; `created_at` has a second's resolution, so the insert order (`rowid`) breaks a tie. */
const newestFirst = [desc(builds.createdAt), desc(sql`${builds}.rowid`)] as const;

/**
 * The commit of the PR's newest build with a verdict in any of the repo's projects: the PR's head as
 * we know it. A build still uploading or diffing does not move it, so the comment keeps the last
 * verdict until the new commit has one.
 */
async function headOf(db: Db, pr: PrKey): Promise<string | null> {
  const [newest] = await db
    .select({ sha: builds.commitSha })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .where(
      and(
        commentingOnRepo(pr),
        eq(builds.prNumber, pr.prNumber),
        notInArray(builds.status, ["uploading", "processing"]),
      ),
    )
    .orderBy(...newestFirst)
    .limit(1);
  return newest?.sha ?? null;
}

/** Each project's newest build of the PR on `headSha`, ordered by project name. */
async function projectBuilds(
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
    })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .where(
      and(commentingOnRepo(pr), eq(builds.prNumber, pr.prNumber), eq(builds.commitSha, headSha)),
    )
    .orderBy(...newestFirst);
  const newest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!newest.has(row.projectId)) newest.set(row.projectId, row);
  const picked = [...newest.values()].toSorted((a, b) =>
    a.projectName.localeCompare(b.projectName),
  );
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
  return Promise.all(
    picked.map(async ({ aiSummary, queuedAt, projectName, ...row }) => {
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
  );
}

/** How many of the org's projects on the repo comment: one keeps the single-project body. */
async function commentingCount(db: Db, pr: PrKey): Promise<number> {
  const [row] = await db.select({ n: count() }).from(projects).where(commentingOnRepo(pr));
  return row?.n ?? 0;
}

/** The body as the PR stands now, from its head as it is now, or null when it has no build. */
async function bodyOf(deps: PrCommentDeps, pr: PrKey, repo: RepoName): Promise<string | null> {
  const head = await headOf(deps.db, pr);
  const all = head === null ? [] : await projectBuilds(deps, pr, repo, head);
  if (head === null || all.length === 0) return null;
  return commentOf(all, head, (await commentingCount(deps.db, pr)) === 1);
}

const keyOfComment = (pr: PrKey) =>
  and(
    eq(prComments.orgId, pr.orgId),
    eq(prComments.repo, pr.repo),
    eq(prComments.prNumber, pr.prNumber),
  );

/** Edit the stored comment. False when GitHub no longer has it (deleted): the row is dropped too. */
async function editHeld(
  db: Db,
  edit: (id: number) => Promise<unknown>,
  pr: PrKey,
): Promise<boolean> {
  const key = keyOfComment(pr);
  const [held] = await db.select({ id: prComments.commentId }).from(prComments).where(key);
  if (!held) return false;
  try {
    await edit(held.id);
    return true;
  } catch (error) {
    // Deleted on GitHub: it is made again by the caller. Any other failure is the caller's to log.
    if (!(error instanceof GithubError && error.status === 404)) throw error;
    // Only the id that 404'd: another sync may already have stored the PR's new comment.
    await db.delete(prComments).where(and(key, eq(prComments.commentId, held.id)));
    return false;
  }
}

/** Where a comment goes: the database that holds its id and the client and repo that send it. */
type Target = { db: Db; client: GithubApp; repo: RepoName };

/** Put `body` on the PR: edit the stored comment, or make it when there is none. */
async function put({ db, client, repo }: Target, pr: PrKey, body: string): Promise<void> {
  const edit = (id: number) =>
    client.request(repo, "PATCH", `/repos/${repo}/issues/comments/${id}`, { body });
  if (await editHeld(db, edit, pr)) return;

  const created = await client.request(
    repo,
    "POST",
    `/repos/${repo}/issues/${pr.prNumber}/comments`,
    { body },
  );
  const id = Number(field(created, "id"));
  const stored = await db
    .insert(prComments)
    .values({ ...pr, commentId: id })
    .onConflictDoNothing()
    .returning({ id: prComments.commentId });
  if (stored.length > 0) return;
  // Another sync made the PR's comment first: that one is the PR's, so it gets this state and ours goes.
  // Ours goes first: if the edit then fails, the PR still has the one comment.
  await client.request(repo, "DELETE", `/repos/${repo}/issues/comments/${id}`);
  await editHeld(db, edit, pr);
}

/**
 * The most times one sync writes the comment, a guard rather than a budget. Two projects' syncs can
 * each read the PR, then write in the other order, so the older body lands last; each sync reads
 * the PR again after its write and writes again until what it wrote is what it reads, a newer head
 * included. A sync stops early only when the PR keeps changing under it this many times, and then
 * each of those changes is a decision or a build whose own sync writes after it.
 */
const WRITES = 10;

/**
 * Create or edit the PR's comment for a build that has a verdict. Nothing for a build with no PR,
 * a project that turned the comment off (or a subproject), a build still being diffed, or one
 * that is not on the PR's head: an older build deciding late does not overwrite the newest. A
 * comment someone deleted is created again.
 */
export async function syncPrComment(
  deps: PrCommentDeps,
  client: GithubApp,
  build: PrCommentBuild,
): Promise<void> {
  const { db } = deps;
  const { prNumber, repo } = build;
  if (prNumber === null || !build.comment) return;
  if (build.status === "uploading" || build.status === "processing") return;
  const pr: PrKey = { orgId: build.orgId, repo: repo.toLowerCase(), prNumber };
  if ((await headOf(db, pr)) !== build.commitSha) return;

  let body = await bodyOf(deps, pr, repo);
  for (let write = 0; body !== null && write < WRITES; write++) {
    await put({ db, client, repo }, pr, body);
    const now = await bodyOf(deps, pr, repo);
    if (now === body) return;
    body = now;
  }
}
