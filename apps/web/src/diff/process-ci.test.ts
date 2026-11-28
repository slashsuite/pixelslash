import { ENGINE_VERSION } from "@slashsuite/pixelslash-engine/ci-diff";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { call, setup } from "#/api/test-support";
import { getBuild } from "#/db/builds";
import { reviewSnapshot } from "#/db/review";
import { builds } from "#/db/schema";
import { orgBlobs } from "#/storage/blobs";
import { NoRecoveryError, processBuild } from "./process";
import { type Run, begin, branch, ciProject, noDiff, run, send } from "./test-ci";
import { sha } from "./test-builds";
import { RED, shot } from "./test-shots";

/** A project that diffs in CI (ob 1727), end to end through the API (`test-ci.ts`). */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const redder = shot({ blocks: [{ x: 4, y: 4, w: 24, h: 20, rgb: RED }] });

type Ran = Awaited<ReturnType<typeof run>>;

/** What a reviewer reads of a shot, which the CLI and the server must agree on. */
const view = (r: Ran) => ({
  build: r.build?.status,
  diffStatus: r.row.diffStatus,
  // The server settles identical bytes without measuring (ob 1948), which the CLI's wire
  // result never says; everything it does say is the same.
  diffResult: r.row.diffResult && { ...r.row.diffResult, settledBy: undefined },
  carries: r.row.carriedFrom !== null,
  reviewState: r.row.reviewState,
  baseline: r.row.baselineKey !== null,
});

/** Each build sent twice in turn: to the ci project (acme), measured by the CLI, and to the server one. */
async function onBothSides(held: Awaited<ReturnType<typeof ciProject>>, sequence: Run[]) {
  const ci = { ...held.deps, diff: noDiff };
  const ran = [];
  for (const spec of sequence) {
    const onCi = await run(held, held.acme.token, spec, ci);
    ran.push({ onCi, onServer: await run(held, held.other.token, spec) });
  }
  return ran;
}

describe("a project that diffs in CI", () => {
  test("the CLI and the server reach the same results, carry included; only measured_by differs", async () => {
    const held = await ciProject();
    const ran = await onBothSides(held, [
      { branch: "main", commit: sha(1), png: white },
      branch(2, red), // changed against main
      branch(3, red), // identical to an undecided change: carries it
      branch(4, redder), // moved past the open change: measured against main's accepted shot
    ]);
    expect(ran.map((r) => r.onCi.done.status)).toEqual([200, 200, 200, 200]);
    // A shot with nothing to compare against is measured by no one.
    expect(
      ran.map((r) => [r.onCi.row.measuredBy, r.onCi.row.engineVersion, r.onServer.row.measuredBy]),
    ).toEqual([
      [null, null, null],
      ["ci", ENGINE_VERSION, "server"],
      ["ci", ENGINE_VERSION, "server"],
      ["ci", ENGINE_VERSION, "server"],
    ]);
    expect(ran.map((r) => view(r.onCi))).toEqual(ran.map((r) => view(r.onServer)));
    expect(ran.map((r) => [r.onCi.row.diffStatus, view(r.onCi).carries])).toEqual([
      ["new", false],
      ["changed", false],
      ["unchanged", true],
      ["changed", false],
    ]);
  });

  test("a ci build finalises without the server diff; a server build with no diff errors", async () => {
    const held = await ciProject();
    const deps = { ...held.deps, diff: noDiff };
    await run(held, held.acme.token, { branch: "main", commit: sha(1), png: white }, deps);
    const ci = await run(held, held.acme.token, branch(2, red), deps);
    expect(ci.build?.status).toBe("changes");
    expect(ci.row.diffStatus).toBe("changed");

    await run(held, held.other.token, { branch: "main", commit: sha(1), png: white }, deps);
    const server = await run(held, held.other.token, branch(2, red), deps);
    expect(server.build?.status).toBe("errored");
  });

  test("a squash-merged main build is auto-accepted through CI (ob 1559)", async () => {
    const held = await ciProject();
    const deps = { ...held.deps, diff: noDiff };
    await run(held, held.acme.token, { branch: "main", commit: sha(1), png: white }, deps);
    const squash = await run(
      held,
      held.acme.token,
      { branch: "main", commit: sha(2), png: red },
      deps,
    );
    expect(squash.row).toMatchObject({ diffStatus: "changed", reviewState: "accepted" });
    expect(squash.build?.status).toBe("passed");
  });

  // Which results are refused is `ci-result.test.ts`'s table; this is the reaction to one.
  test("a result the server refuses errors the shot by name and the build", async () => {
    const held = await ciProject();
    const deps = { ...held.deps, diff: noDiff };
    await run(held, held.acme.token, { branch: "main", commit: sha(1), png: white }, deps);
    const r = await run(
      held,
      held.acme.token,
      { ...branch(2, red), tamper: () => undefined },
      deps,
    );
    expect(r.measured).toHaveLength(1);
    expect(r.row.diffStatus).toBeNull();
    expect(r.row.diffError).toMatch(/no result/);
    expect(r.build?.status).toBe("errored");
    expect(r.build?.error).toMatch(/re-run the CI job/);
  });

  test("a shot that cannot reuse its own diff is not measured against main, and main is never diffed", async () => {
    const held = await ciProject();
    const deps = { ...held.deps, diff: noDiff };
    const onMain = await run(
      held,
      held.acme.token,
      { branch: "main", commit: sha(1), png: white },
      deps,
    );
    const first = await run(held, held.acme.token, branch(2, red), deps);
    // Against main as well as its own baseline, which is main's: the diff is copied.
    expect(first.row).toMatchObject({ diffStatus: "changed", mainDiffStatus: "changed" });
    await reviewSnapshot(held.db, {
      projectId: held.acme.project.id,
      snapshotId: first.row.id,
      state: "accepted",
      userId: held.acme.user.id,
    });
    // Its own baseline is now the branch's accepted shot: CI sent no result for main's.
    const second = await run(held, held.acme.token, branch(3, redder), deps);
    expect(second.row.baselineKey).not.toBe(onMain.row.imageKey);
    expect(second.row).toMatchObject({
      mainBaselineKey: onMain.row.imageKey,
      mainDiffStatus: null,
      mainDiffResult: null,
    });
    expect(second.build?.status).not.toBe("errored");
  });

  // A pull request opened while main's build at its merge base is still being diffed (PS-812).
  test("a build decided during the upload is not picked at finalise; the next build picks it", async () => {
    const held = await ciProject();
    const deps = { ...held.deps, diff: noDiff };
    const token = held.acme.token;
    const old = await run(held, token, { branch: "main", commit: sha(1), png: white }, deps);
    const onBase = await begin(held, token, { branch: "main", commit: sha(2), png: red }, deps);
    const spec = { ...branch(3, redder), mergeBase: sha(2), ancestors: [sha(1)] };
    const pr = await begin(held, token, spec, deps);
    // main at the merge base had no verdict when the CLI asked: the pick is its ancestor's.
    expect(pr.pick.baseline?.id).toBe(old.row.id);
    const based = await send(onBase);
    expect(based.build?.status).toBe("passed");

    // Finalise makes the pick the CLI measured against, so nothing is refused as stale.
    const r = await send(pr);
    expect(r.build).toMatchObject({ status: "changes", error: null });
    expect(r.row).toMatchObject({ diffStatus: "changed", baselineKey: old.row.imageKey });
    // A build opened after main's verdict picks main's shot.
    const next = await run(held, token, { ...spec, branch: "feat/y", commit: sha(4) }, deps);
    expect(next.pick.baseline?.id).toBe(based.row.id);
    expect(next.build).toMatchObject({ status: "changes", error: null });
  });

  // The pull request's Worker read a clock ahead of the one that gave main its verdict.
  test("a build opened before a verdict never counts it decided, whatever its clock read", async () => {
    const held = await ciProject();
    const deps = { ...held.deps, diff: noDiff };
    const token = held.acme.token;
    const old = await run(held, token, { branch: "main", commit: sha(1), png: white }, deps);
    const onBase = await begin(held, token, { branch: "main", commit: sha(2), png: red }, deps);
    const spec = { ...branch(3, redder), mergeBase: sha(2), ancestors: [sha(1)] };
    const pr = await begin(held, token, spec, deps);
    const ahead = new Date(Date.now() + 60_000);
    await held.db.update(builds).set({ createdAt: ahead }).where(eq(builds.id, pr.id));
    await send(onBase);

    const r = await send(pr);
    expect(r.build).toMatchObject({ status: "changes", error: null });
    expect(r.row).toMatchObject({ baselineKey: old.row.imageKey });
  });

  test("an old CLI is refused by a ci project and accepted by a server one", async () => {
    const held = await ciProject();
    const body = JSON.stringify({ commitSha: sha(1), branch: "main" });
    const refused = await call(held.deps, "POST /api/v1/builds", held.acme.token, body);
    expect(refused.status).toBe(426);
    expect(await refused.json()).toEqual({
      error: "this project diffs in CI; upgrade the CLI",
    });
    expect(await held.db.select().from(builds)).toHaveLength(0);

    const accepted = await call(held.deps, "POST /api/v1/builds", held.other.token, body);
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ diffLocation: "server" });
  });

  test("an errored ci build is not recovered: finalising it again is a 409", async () => {
    const held = await ciProject();
    const deps = { ...held.deps, diff: noDiff };
    await run(held, held.acme.token, { branch: "main", commit: sha(1), png: white }, deps);
    const r = await run(
      held,
      held.acme.token,
      { ...branch(2, red), tamper: () => undefined },
      deps,
    );
    expect(r.build?.status).toBe("errored");

    const build = await getBuild(held.db, held.acme.project.id, r.id);
    await expect(
      processBuild(
        { db: held.db, blobs: orgBlobs(held.deps.store, held.acme.org.id), diff: noDiff },
        build,
      ),
    ).rejects.toBeInstanceOf(NoRecoveryError);
    const again = await call(
      deps,
      `POST /api/v1/builds/${r.id}/finalize`,
      held.acme.token,
      JSON.stringify({ snapshots: 1 }),
    );
    expect(again.status).toBe(409);
  });

  test("results sent to a server project are not trusted: the server measures", async () => {
    const held = await setup();
    await run(held, held.acme.token, { branch: "main", commit: sha(1), png: white });
    const r = await run(held, held.acme.token, {
      ...branch(2, red),
      tamper: (rs) => rs.map((x) => ({ ...x, status: "unchanged" })),
    });
    expect(r.row).toMatchObject({ measuredBy: "server", diffStatus: "changed" });
  });
});
