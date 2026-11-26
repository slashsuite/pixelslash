import { and, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { snapshotKeyOf } from "./baselines";
import { chunk, inChunks } from "./chunks";
import type { Db } from "./db";
import { builds, snapshots } from "./schema";

/**
 * The flaky shots of a default-branch build that are accepted with the rest of it after all. The
 * default branch never auto-accepts a flaky shot (ob 1724), since its image may be noise, and a
 * main shot that stays pending is no baseline: every pull request is then measured against an
 * older accepted image and shows main's own change as its own. Two kinds of evidence settle that
 * the image is not noise, and nothing else does:
 *
 * - **Reproduced on main:** the diff found the shot unchanged against main's previous shot, which
 *   holds the same undecided change (`carried_from`). Two builds of main rendered the same image.
 * - **Accepted on another branch:** a person accepted a shot of the same key with the same bytes
 *   on a pull request's build: the merge build holds the image that person approved.
 *
 * Only a `review` shot: a `skip` shot is documented never to become a baseline on its own. A native
 * shot of a stale twin key waits for a person whatever its flake (PS-297), so it is left.
 */
async function settledFlakyShots(
  db: Db,
  build: { id: string; projectId: string; branch: string },
): Promise<string[]> {
  const pending = await db
    .select({
      id: snapshots.id,
      name: snapshots.name,
      platform: snapshots.platform,
      browser: snapshots.browser,
      viewport: snapshots.viewport,
      theme: snapshots.theme,
      imageSha256: snapshots.imageSha256,
      diffStatus: snapshots.diffStatus,
      carriedFrom: snapshots.carriedFrom,
    })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.buildId, build.id),
        isNotNull(snapshots.flakeId),
        isNull(snapshots.staleOf),
        eq(snapshots.reviewState, "pending"),
        // A `skip` shot never moves its baseline unless a person accepts it; no policy is `review`.
        or(isNull(snapshots.flakyPolicy), ne(snapshots.flakyPolicy, "skip")),
      ),
    );
  const reproduced = (row: (typeof pending)[number]) =>
    row.diffStatus === "unchanged" && row.carriedFrom !== null;
  const settled = pending.filter(reproduced).map((row) => row.id);
  const rest = pending.filter((row) => !reproduced(row) && row.imageSha256 !== null);
  const accepted = await acceptedElsewhere(
    db,
    build,
    rest.flatMap((row) => row.imageSha256 ?? []),
  );
  for (const row of rest)
    if (accepted.has(`${row.imageSha256}${snapshotKeyOf(row)}`)) settled.push(row.id);
  return settled;
}

/**
 * Accept the settled flaky shots of a default-branch build, so they become the baseline: a fresh
 * run's (`acceptDefaultBranchBuild`), or, on a re-diff, only `among` the shots whose result moved.
 */
export async function acceptSettledFlakyShots(
  db: Db,
  build: { id: string; projectId: string; branch: string },
  among?: string[],
): Promise<void> {
  const settled = await settledFlakyShots(db, build);
  const ids = among ? settled.filter((id) => among.includes(id)) : settled;
  // Beside the ids the statement binds the two values it sets.
  for (const part of chunk(ids, 2))
    await db
      .update(snapshots)
      .set({ reviewState: "accepted", reviewedAt: new Date() })
      .where(inArray(snapshots.id, part));
}

/**
 * The (hash, key) pairs a person accepted on another branch of the project, among these image
 * hashes. Read by hash (indexed); the key is matched here, since one image may be shot under many.
 */
async function acceptedElsewhere(
  db: Db,
  build: { projectId: string; branch: string },
  hashes: string[],
): Promise<Set<string>> {
  // Beside the hashes the statement binds the project, the branch and the review state.
  const rows = await inChunks(hashes, 3, (part) =>
    db
      .select({
        imageSha256: snapshots.imageSha256,
        name: snapshots.name,
        platform: snapshots.platform,
        browser: snapshots.browser,
        viewport: snapshots.viewport,
        theme: snapshots.theme,
      })
      .from(snapshots)
      .innerJoin(builds, eq(builds.id, snapshots.buildId))
      .where(
        and(
          inArray(snapshots.imageSha256, part),
          eq(snapshots.reviewState, "accepted"),
          // A person's decision: the default branch's own auto-accept records no reviewer.
          isNotNull(snapshots.reviewedBy),
          eq(builds.projectId, build.projectId),
          ne(builds.branch, build.branch),
        ),
      ),
  );
  return new Set(rows.map((row) => `${row.imageSha256}${snapshotKeyOf(row)}`));
}
