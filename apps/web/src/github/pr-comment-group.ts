import { type BuildCounts, sumCounts } from "#/db/build-counts";
import type { GroupMember } from "#/db/commit-group";
import { type SyncedBuild, detailsUrlOf } from "./build-text";

/*
 * The PR comment's section for a project with subprojects: what the group adds up to, and a line
 * per member with its build on the head.
 */

/** A line of a group's section: a subproject (or the project itself) and its build on the head. */
export type MemberLine = {
  name: string;
  /** Null when it has no build on the head: a task cache skipped it. */
  build: SyncedBuild | null;
  counts: BuildCounts;
  pageUrl: string | undefined;
};

/** The member lines of a group, with each build's link. */
export const memberLines = (publicUrl: string | undefined, members: GroupMember[]): MemberLine[] =>
  members.map((m) => ({
    name: m.name,
    build: m.build,
    counts: m.counts,
    pageUrl: m.build ? detailsUrlOf(publicUrl, m.build) : undefined,
  }));

/**
 * What the group adds up to as one build: the worst status first (errored, rejected, diffing,
 * waiting), then passed, over the counted members' summed counts.
 */
export function groupBuild(members: GroupMember[]): Pick<SyncedBuild, "status" | "error"> & {
  counts: BuildCounts;
} {
  const counted = members.flatMap((m) => (m.build ? [{ ...m, build: m.build }] : []));
  const counts = sumCounts(counted.map((m) => m.counts));
  const order = ["errored", "failed", "uploading", "processing", "changes"] as const;
  for (const status of order) {
    const hit = counted.find((m) => m.build.status === status);
    if (hit)
      return {
        status,
        error:
          status === "errored" ? `${hit.name}: ${hit.build.error ?? "no reason recorded"}` : null,
        counts,
      };
  }
  return { status: "passed", error: null, counts };
}
