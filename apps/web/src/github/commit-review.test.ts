import { describe, expect, test } from "vitest";
import { call, newBuild } from "#/api/test-support";
import { commitReview } from "#/db/commit-review";
import { buildView } from "#/db/review";
import { sha } from "#/diff/test-builds";
import type { StatusBody } from "./check-run";
import { CHANGED, PLAIN, world } from "./test-world";

/**
 * The combined review of a commit across a project and its subprojects, and the one PR comment and
 * status the group gets: the review's rows are each build's own, so a decision shows on both pages.
 */

type World = Awaited<ReturnType<typeof world>>;

const names = (n: number) => Array.from({ length: n }, (_, i) => `s${String(i).padStart(2, "0")}`);
const lastStatus = (w: World): StatusBody | undefined => {
  const raw = w.github.statusCalls().at(-1)?.raw;
  return raw ? JSON.parse(raw) : undefined;
};

/** P with `subs` subprojects, a main build of each, then PR 7's head on sha(2) with `png` for each. */
async function group(subs: string[], png = CHANGED) {
  const w = await world();
  const made = new Map<string, string>();
  for (const name of subs) made.set(name, (await w.addSubproject(name)).id);
  await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
  for (const subproject of subs)
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN, subproject });
  const on = (subproject?: string, shot = png) =>
    w.finalise({
      commit: sha(2),
      branch: "feat/x",
      mergeBase: sha(1),
      png: shot,
      pr: 7,
      ...(subproject ? { subproject } : {}),
    });
  return { ...w, made, on, review: () => commitReview(w.db, w.acme.project.id, sha(2)) };
}

describe("the combined review of a commit", () => {
  test("20 subprojects with one change each show 20 changes, grouped by subproject", async () => {
    const subs = names(20);
    const w = await group(subs);
    await w.on(undefined, PLAIN);
    for (const name of subs) await w.on(name);

    const review = await w.review();
    expect(review.totals).toEqual({ changes: 20, waiting: 20, accepted: 0, rejected: 0 });
    expect(review.groups.map((g) => g.name)).toEqual(["web", ...subs]);
    expect(review.groups[0]?.totals.changes).toBe(0);
    for (const g of review.groups.slice(1)) {
      expect(g.totals).toEqual({ changes: 1, waiting: 1, accepted: 0, rejected: 0 });
      expect(g.snapshots).toHaveLength(1);
    }
  }, 60_000);

  test("a decision made on the build page shows here, and one made here shows on the build page", async () => {
    const w = await group(["a", "b"]);
    const a = await w.on("a");
    const b = await w.on("b");
    const aId = w.made.get("a") ?? "";
    const bId = w.made.get("b") ?? "";

    // On a's build page: the decision is a's own row.
    await w.decide(a.id, "accepted", aId);
    let review = await w.review();
    expect(review.groups.find((g) => g.name === "a")?.snapshots[0]?.reviewState).toBe("accepted");

    // Here: the row is b's build's row, decided with b's project, so b's build page has it.
    const row = review.groups.find((g) => g.name === "b")?.snapshots[0];
    expect(row).toBeDefined();
    await w.decide(b.id, "rejected", bId);
    const page = await buildView(w.db, bId, b.id);
    expect(page?.snapshots.find((s) => s.id === row?.id)?.reviewState).toBe("rejected");
    review = await w.review();
    expect(review.totals).toEqual({ changes: 2, waiting: 0, accepted: 1, rejected: 1 });
  });

  test("a subproject that did not run on the commit is listed with its last build and counts nothing", async () => {
    const w = await group(["a", "b"]);
    await w.on("a");
    const review = await w.review();
    const b = review.groups.find((g) => g.name === "b");
    expect(b?.build).toBeNull();
    expect(b?.lastBuild?.commitSha).toBe(sha(1));
    expect(b?.totals.changes).toBe(0);
    expect(review.totals.changes).toBe(1);
  });

  test("a subproject that ran `upload --skipped` is not run, on the page and in the PR comment", async () => {
    const w = await group(["a", "b"]);
    const skip = newBuild({ commitSha: sha(2), branch: "feat/x", subproject: "b", skipped: true });
    expect((await call(w.deps, "POST /api/v1/builds", w.acme.token, skip)).status).toBe(201);
    await w.on("a");
    const b = (await w.review()).groups.find((g) => g.name === "b");
    expect(b?.build).toBeNull();
    expect(b?.lastBuild?.commitSha).toBe(sha(1));
    const [body] = [...w.github.comments().values()];
    expect(body).toContain("- b: not run on this commit (unchanged)");
  });

  test("accepting the last waiting change turns the group's status green", async () => {
    const w = await group(["a", "b"]);
    const a = await w.on("a");
    const b = await w.on("b");
    await w.sync(await w.decide(a.id, "accepted", w.made.get("a")));
    expect(lastStatus(w)?.state).toBe("pending");
    await w.sync(await w.decide(b.id, "accepted", w.made.get("b")));
    expect(lastStatus(w)).toMatchObject({ state: "success", description: "All changes accepted" });
  });
});

describe("one PR comment for the group", () => {
  const orders: [string, (string | undefined)[]][] = [
    ["top first", [undefined, "a", "b"]],
    ["a subproject first", ["b", undefined, "a"]],
    ["subprojects only", ["a", "b"]],
  ];
  for (const [label, order] of orders)
    test(`names each subproject and links the commit's review, ${label}`, async () => {
      const w = await group(["a", "b"]);
      for (const subproject of order) await w.on(subproject);
      const comments = [...w.github.comments().values()];
      expect(comments).toHaveLength(1);
      const [body] = comments;
      expect(body).toContain("- a: ");
      expect(body).toContain("- b: ");
      expect(body).toContain(
        `[Review every change](https://pixelslash.test/projects/${w.acme.project.id}/commits/${sha(2)})`,
      );
      expect(body).toContain(
        order.includes(undefined) ? "- web: " : "- web: not run on this commit",
      );
    });
});
