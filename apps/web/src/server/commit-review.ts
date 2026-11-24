import { notFound, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { commitReview } from "#/db/commit-review";
import { getProjectWithOrg } from "#/db/orgs";
import { reviewGroupOf } from "#/lib/snapshot-groups";
import { database } from "./env";
import { imageUrls } from "./image-urls";
import { field, or404 } from "./input";
import { requireViewer } from "./session";

/**
 * The combined review of a commit (`/projects/$projectId/commits/$sha`): every change in the
 * top-level project's build and each subproject's newest build on the commit, on one page. A
 * subproject's address opens its parent's view, since the group is the parent's.
 */
export const getCommitReview = createServerFn()
  .validator((d: unknown) => ({ projectId: field(d, "projectId"), sha: field(d, "sha") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const db = database();
    const { project, org } = await or404(getProjectWithOrg(db, user.id, data.projectId));
    if (project.parent)
      throw redirect({
        to: "/projects/$projectId/commits/$sha",
        params: { projectId: project.parent.id, sha: data.sha },
      });
    const review = await commitReview(db, project.id, data.sha);
    if (review.head === null) throw notFound();
    // A row shows the branch shot, cropped to the change in the browser, as the build page's card does.
    const thumbs: Record<string, string> = {};
    for (const shot of review.groups.flatMap((g) => g.snapshots)) {
      const group = reviewGroupOf(shot);
      if (group !== "changed" && group !== "new") continue;
      const { branch } = await imageUrls(project.orgId, {
        main: null,
        branch: shot.imageKey,
        diff: null,
      });
      if (branch) thumbs[shot.id] = branch;
    }
    return { org, project, sha: data.sha, ...review, thumbs };
  });
