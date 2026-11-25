import { type GroupMember, commitGroup } from "#/db/commit-group";
import type { Db } from "#/db/db";
import { commitReviewUrl, plural, titleOf } from "./build-text";
import type { StatusBody } from "./check-run";

/*
 * One PixelSlash status for a top-level project and all its subprojects on a commit: what the
 * newest build of each of them on that commit adds up to. A subproject with no build on the commit
 * (a task cache skipped its capture) is listed as not run and holds nothing.
 */

export type GroupState = {
  state: "pending" | "success" | "failure";
  /** One line: what the status says on the PR. */
  description: string;
};

const failed = (m: GroupMember) => m.build?.status === "errored" || m.build?.status === "failed";
const diffing = (m: GroupMember) =>
  m.build?.status === "uploading" || m.build?.status === "processing";
const waiting = (m: GroupMember) => m.build?.status === "changes";

/** Where the group's changes wait: "in 3 subprojects", "in web and 2 subprojects". */
function whereOf(members: GroupMember[]): string {
  const subs = members.filter((m) => !m.top).length;
  const top = members.find((m) => m.top);
  if (subs === 0) return top ? `in ${top.name}` : "";
  const subText = plural(subs, "subproject");
  return top ? `in ${top.name} and ${subText}` : `in ${subText}`;
}

/** Failure first (a sibling still diffing does not hide it), then pending, then success. */
export function groupState(members: GroupMember[]): GroupState {
  const counted = members.filter((m) => m.build !== null);
  const failing = counted.filter(failed);
  const [first] = failing;
  if (first?.build)
    return {
      state: "failure",
      description:
        failing.length === 1
          ? `${first.name}: ${titleOf(first.build, first.counts)}`
          : `${plural(failing.length, "build")} failed: ${failing.map((m) => m.name).join(", ")}`,
    };
  if (counted.some(diffing)) return { state: "pending", description: "Diffing the shots" };
  const open = counted.filter(waiting);
  if (open.length > 0) {
    const total = open.reduce((n, m) => n + m.counts.toReview, 0);
    return {
      state: "pending",
      description: `${plural(total, "change")} to review ${whereOf(open)}`,
    };
  }
  const changed = counted.some((m) => m.counts.changed > 0);
  return {
    state: "success",
    description: changed ? "All changes accepted" : "No visual changes",
  };
}

/** A status description is at most 140 characters. */
const DESCRIPTION_MAX = 140;

/**
 * The status for a build's group: the top-level project's name as its context, the group's state,
 * and a link to the commit's combined review, which lists every member's changes on one page.
 */
export async function groupStatus(
  deps: { db: Db; publicUrl: string | undefined },
  row: { topProjectId: string; commitSha: string; checkName: string },
): Promise<StatusBody> {
  const members = await commitGroup(deps.db, row.topProjectId, row.commitSha);
  const { state, description } = groupState(members);
  const origin = deps.publicUrl?.replace(/\/+$/, "");
  return {
    state,
    context: row.checkName,
    description: description.slice(0, DESCRIPTION_MAX),
    ...(origin && { target_url: commitReviewUrl(origin, row.topProjectId, row.commitSha) }),
  };
}
