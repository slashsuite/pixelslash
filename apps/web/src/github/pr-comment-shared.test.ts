import { describe, expect, test } from "vitest";
import { setGithubComment } from "#/db/github-comment";
import { prComments } from "#/db/schema-pr-comments";
import { sha } from "#/diff/test-builds";
import type { GithubApp } from "./app";
import { syncCheckRuns } from "./check-run";
import { CHANGED, PLAIN, world } from "./test-world";

/** One PR comment shared by every project of an org on the repo, against a stand-in for GitHub. */

type World = Awaited<ReturnType<typeof world>>;

const page = (w: World, buildId: string) =>
  `https://pixelslash.test/projects/${w.acme.project.id}/builds/${buildId}`;

const commentBodies = (w: World) => [...w.github.comments().values()];

/** acme's project and two more on `acme/web`; each with a main build. Returns their CI tokens. */
async function threeProjects(w: World) {
  const docs = await w.linkProject("docs", "Acme/Web");
  const site = await w.linkProject("site", "acme/web");
  for (const token of [undefined, docs, site])
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN, ...(token && { token }) });
  return { docs, site };
}

/** A build of PR 7, from acme's project or the one `token` uploads to. */
const ofPr = (png: Uint8Array<ArrayBuffer>, token?: string) => ({
  commit: sha(2),
  branch: "feat/x",
  mergeBase: sha(1),
  png,
  pr: 7,
  ...(token && { token }),
});

describe("one PR comment for every project on the repo", () => {
  test("each upload edits the one comment: a section per changed project, then the unchanged ones", async () => {
    const w = await world();
    const { docs, site } = await threeProjects(w);
    const ours = await w.finalise(ofPr(CHANGED));
    const theirs = await w.finalise(ofPr(CHANGED, docs));
    await w.finalise(ofPr(PLAIN, site));

    expect(w.github.commentCalls().map((c) => c.method)).toEqual(["POST", "PATCH", "PATCH"]);
    expect(w.github.comments().size).toBe(1);
    expect(await w.db.select().from(prComments)).toHaveLength(1);
    const [body = ""] = commentBodies(w);
    expect(body).toContain("### PixelSlash: 2 changes to review in 2 of 3 projects");
    expect(body).toContain("#### docs: 1 change to review");
    expect(body).toContain(`#### ${w.acme.project.name}: 1 change to review`);
    expect(body).toContain(`[Review the build](${page(w, ours.id)})`);
    const docsProject = (await w.buildRow(theirs.id))?.projectId ?? "";
    expect(body).toContain(`/projects/${docsProject}/builds/${theirs.id})`);
    expect(body).toContain("No visual changes: site.");
    expect(body).not.toContain("#### site");
    expect(body.indexOf("#### ")).toBeLessThan(body.indexOf("No visual changes"));
  });

  test("an upload with no changes on a PR names the project on the no-change line", async () => {
    const w = await world();
    const { site } = await threeProjects(w);
    await w.finalise(ofPr(PLAIN, site));
    await w.finalise(ofPr(PLAIN));

    const [body = ""] = commentBodies(w);
    expect(w.github.comments().size).toBe(1);
    expect(body).toContain("### PixelSlash: No visual changes in 2 projects");
    expect(body).toContain("No visual changes: site, web.");
    expect(body).not.toContain("####");
    expect(body).not.toContain("| Changed |");
  });

  test("two projects uploading at the same time leave one comment with both sections", async () => {
    const w = await world();
    const { docs, site } = await threeProjects(w);
    await Promise.all([
      w.finalise(ofPr(CHANGED)),
      w.finalise(ofPr(CHANGED, docs)),
      w.finalise(ofPr(PLAIN, site)),
    ]);

    expect(w.github.comments().size).toBe(1);
    expect(await w.db.select().from(prComments)).toHaveLength(1);
    const [body = ""] = commentBodies(w);
    expect(body).toContain("2 changes to review in 2 of 3 projects");
    expect(body).toContain("#### docs:");
    expect(body).toContain(`#### ${w.acme.project.name}:`);
    expect(body).toContain("No visual changes: site.");
  });

  test("a sync whose write lands after a newer one's writes again, so no section goes stale", async () => {
    const w = await world();
    const { docs } = await threeProjects(w);
    const ours = await w.finalise(ofPr(CHANGED));
    const theirs = await w.finalise(ofPr(CHANGED, docs));
    const docsProject = (await w.buildRow(theirs.id))?.projectId ?? "";

    // Our sync reads the PR, then its edit is held while docs' decision syncs and lands.
    const inner = w.github.app({ timeoutMs: 50 });
    const held = Promise.withResolvers<void>();
    const patching = Promise.withResolvers<void>();
    let first = true;
    const slow: GithubApp = {
      async request(repo, method, path, body) {
        if (method === "PATCH" && path.includes("/issues/comments/") && first) {
          first = false;
          patching.resolve();
          await held.promise;
        }
        return inner.request(repo, method, path, body);
      },
    };
    const deps = { db: w.db, token: null, publicUrl: "https://pixelslash.test/" };
    const accepted = await w.decide(ours.id, "accepted");
    const stale = syncCheckRuns({ ...deps, app: slow }, accepted);
    await patching.promise;
    await w.sync(await w.decide(theirs.id, "accepted", docsProject));
    expect(commentBodies(w)[0]).toContain("All changes accepted in 2 projects");
    held.resolve();
    await stale;

    // The held edit landed last with what it read (docs still to review), then was put right.
    const edits = w.github.commentCalls().filter((c) => c.method === "PATCH");
    expect(edits.at(-2)?.raw).toContain("1 change to review in 1 of 2 projects");
    expect(w.github.comments().size).toBe(1);
    expect(commentBodies(w)[0]).toContain("All changes accepted in 2 projects");
  });

  test("a project with the comment off, or another org's project on the repo, gets no section", async () => {
    const w = await world();
    const { docs } = await threeProjects(w);
    const theirs = await w.finalise(ofPr(CHANGED, docs));
    const docsProject = (await w.buildRow(theirs.id))?.projectId ?? "";
    await setGithubComment(w.db, w.acme.user.id, docsProject, false);
    await w.finalise(ofPr(CHANGED));

    const [body = ""] = commentBodies(w);
    expect(body).not.toContain("docs");
    expect(body).toContain("### PixelSlash: 1 change to review");
  });
});
