import { describe, expect, test } from "vitest";
import { sha } from "#/diff/test-builds";
import { CHANGED, PLAIN, world } from "#/github/test-world";
import { changeSetOf, nextAfterDecision } from "./change-set";
import { buildView } from "./review";
import { must } from "#/test/must";

/**
 * A review walks a commit's whole change set: the newest build of a project and of each of its
 * subprojects on the commit. The plain walk (on to the next subproject, then the commit's page, and
 * the counter) is proved in `e2e/commit-review.spec.ts`; these are the edges it does not reach.
 */

/** P with `subs` subprojects, a main build of each, then sha(2) with a change in each of `changed`. */
async function changeSet(subs: string[], changed: string[]) {
  const w = await world();
  const ids = new Map<string, string>();
  for (const name of subs) ids.set(name, (await w.addSubproject(name)).id);
  await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
  for (const subproject of subs)
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN, subproject });
  await w.finalise({ commit: sha(2), branch: "feat/x", mergeBase: sha(1), png: PLAIN });
  const builds = new Map<string, string>();
  for (const subproject of changed) {
    const made = await w.finalise({
      commit: sha(2),
      branch: "feat/x",
      mergeBase: sha(1),
      png: CHANGED,
      subproject,
    });
    builds.set(subproject, made.id);
  }
  const at = (name: string) => {
    const projectId = ids.get(name);
    const buildId = builds.get(name);
    if (!projectId || !buildId) throw new Error(`no build of ${name}`);
    return { projectId, buildId };
  };
  const shotOf = async (name: string) => {
    const { projectId, buildId } = at(name);
    const [shot] = (await buildView(w.db, projectId, buildId)).snapshots;
    if (!shot) throw new Error(`no shot in ${name}`);
    return { projectId, buildId, snapshotId: shot.id };
  };
  /** Decide `name`'s one shot, then ask where the reviewer goes, as the shot page's accept does. */
  const decide = async (name: string, state: "accepted" | "rejected") => {
    const shot = await shotOf(name);
    await w.decide(shot.buildId, state, shot.projectId);
    return nextAfterDecision(w.db, shot);
  };
  return { ...w, at, shotOf, decide, top: w.acme.project.id };
}

describe("a review across a commit's change set", () => {
  test("a review started on a later subproject wraps round to an earlier one still waiting", async () => {
    const w = await changeSet(["a", "b"], ["a", "b"]);
    expect((await w.decide("b", "accepted")).next).toEqual(await w.shotOf("a"));
  });

  test("a subproject whose build failed is passed over", async () => {
    const w = await changeSet(["a", "b", "c"], ["a", "b", "c"]);
    await w.decide("b", "rejected");
    expect((await w.decide("a", "accepted")).next).toEqual(await w.shotOf("c"));
  });

  test("a project with no subprojects has no change set: its own build is the whole review", async () => {
    const w = await world();
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    const made = await w.finalise({
      commit: sha(2),
      branch: "feat/x",
      mergeBase: sha(1),
      png: CHANGED,
    });
    const projectId = w.acme.project.id;
    expect(await changeSetOf(w.db, projectId, made.id)).toBeNull();
    const [shot] = (await buildView(w.db, projectId, made.id)).snapshots;
    await w.decide(made.id, "accepted");
    const after = await nextAfterDecision(w.db, {
      projectId,
      buildId: made.id,
      snapshotId: must(shot, "the build's shot").id,
    });
    expect(after).toEqual({ buildStatus: "passed", next: null, commit: null });
  });

  test("an older run of a subproject on the commit is not the set's: it walks alone", async () => {
    const w = await changeSet(["a"], ["a"]);
    const older = w.at("a");
    await w.finalise({
      commit: sha(2),
      branch: "feat/x",
      mergeBase: sha(1),
      png: CHANGED,
      subproject: "a",
    });
    expect(await changeSetOf(w.db, older.projectId, older.buildId)).toBeNull();
  });
});
