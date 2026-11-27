import { describe, expect, test } from "vitest";
import { type Ctx, context, onlyShot, rows, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import type { SentFlake } from "./flakes";
import { reviewSnapshot } from "./review";
import { saveAndRediff } from "#/diff/override";
import { must } from "#/test/must";

const block = { x: 8, y: 8, w: 12, h: 12, rgb: RED };
const before = () => shot();
const after = () => shot({ blocks: [block] });

/** The CLI's record of a shot whose run 2 differed (ob 1737): it opens the key's flaky shot. */
const flake: SentFlake = {
  record: { runs: 3, differed: [2], regions: [], engineVersion: "0.1.0", policy: "review" },
  captures: [{ run: 2, png: shot().buffer }],
};

/** Main accepted `about` as `before`, then a main build changed it while its key's flaky shot was open. */
async function flakyChangeOnMain(ctx: Ctx) {
  await upload(ctx, { branch: "main", commit: sha(1), shots: [{ name: "about", png: before() }] });
  return upload(ctx, {
    branch: "main",
    commit: sha(2),
    ancestors: [sha(1)],
    shots: [{ name: "about", png: after(), flaky: "review", flake }],
  });
}

describe("a flaky shot on the default branch becomes the baseline once its image is settled", () => {
  test("main reproducing the image accepts it, and a pull request at that commit measures 0 changed", async () => {
    const ctx = await context();
    const changed = await flakyChangeOnMain(ctx);
    expect(changed.status).toBe("changes");
    expect((await onlyShot(ctx, changed)).reviewState).toBe("pending");
    // The next main build renders the same image while the flaky shot is still open.
    const again = await upload(ctx, {
      branch: "main",
      commit: sha(3),
      ancestors: [sha(2), sha(1)],
      shots: [{ name: "about", png: after() }],
    });
    const reproduced = await onlyShot(ctx, again);
    expect(reproduced).toMatchObject({ diffStatus: "unchanged", reviewState: "accepted" });
    expect(reproduced.flakeId).not.toBeNull();
    expect(again.status).toBe("passed");
    // The first main build is not decided for anyone: nobody looked at its change.
    expect((await onlyShot(ctx, changed)).reviewState).toBe("pending");
    // A pull request based there, with main's own image, is measured against it and not the old one.
    const pr = await upload(ctx, {
      branch: "feature",
      commit: sha(4),
      mergeBase: sha(3),
      ancestors: [sha(2), sha(1)],
      shots: [{ name: "about", png: after() }],
    });
    expect((await onlyShot(ctx, pr)).diffStatus).toBe("unchanged");
    expect(pr.status).toBe("passed");
  });

  test("a re-diff that finds the flaky shot unchanged against main's waiting change accepts it", async () => {
    const ctx = await context();
    await flakyChangeOnMain(ctx);
    // A faint second block: changed under a strict threshold, unchanged once 100 px are allowed.
    const faint = shot({ blocks: [block, { x: 30, y: 8, w: 6, h: 6, rgb: RED }] });
    const again = await upload(ctx, {
      branch: "main",
      commit: sha(3),
      ancestors: [sha(2), sha(1)],
      shots: [{ name: "about", png: faint, diff: { threshold: 0.1 } }],
    });
    expect(await onlyShot(ctx, again)).toMatchObject({
      diffStatus: "changed",
      reviewState: "pending",
    });
    const saved = await saveAndRediff(
      { db: ctx.db, blobs: ctx.scoped },
      {
        userId: ctx.userId,
        build: again,
        target: { name: "about", variant: null },
        options: { minChangedPixels: 100 },
      },
    );
    expect(saved.status).toBe("passed");
    expect(await onlyShot(ctx, again)).toMatchObject({
      diffStatus: "unchanged",
      reviewState: "accepted",
    });
  });

  test("a main build that renders the flaky key differently again still waits", async () => {
    const ctx = await context();
    await flakyChangeOnMain(ctx);
    const other = await upload(ctx, {
      branch: "main",
      commit: sha(3),
      ancestors: [sha(2), sha(1)],
      shots: [{ name: "about", png: shot({ blocks: [{ ...block, x: 30 }] }) }],
    });
    expect(await onlyShot(ctx, other)).toMatchObject({
      diffStatus: "changed",
      reviewState: "pending",
    });
    expect(other.status).toBe("changes");
  });

  test("a `skip` flaky shot is not accepted on main, even with an image a person accepted on a pull request", async () => {
    const ctx = await context();
    await upload(ctx, {
      branch: "main",
      commit: sha(1),
      shots: [{ name: "about", png: before() }],
    });
    const skipFlake = { ...flake, record: { ...flake.record, policy: "skip" as const } };
    const pr = await upload(ctx, {
      branch: "feature",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [{ name: "about", png: after(), flaky: "skip", flake: skipFlake }],
    });
    await reviewSnapshot(ctx.db, {
      projectId: ctx.projectId,
      snapshotId: (await onlyShot(ctx, pr)).id,
      state: "accepted",
      userId: ctx.userId,
    });
    const merged = await upload(ctx, {
      branch: "main",
      commit: sha(3),
      ancestors: [sha(1)],
      shots: [{ name: "about", png: after(), flaky: "skip" }],
    });
    expect((await onlyShot(ctx, merged)).reviewState).toBe("pending");
  });

  test("an image a person accepted on a pull request is accepted on the main build that holds it", async () => {
    const ctx = await context();
    await upload(ctx, {
      branch: "main",
      commit: sha(1),
      shots: [{ name: "about", png: before() }],
    });
    // The flaky shot on `about` opens on the pull request.
    const pr = await upload(ctx, {
      branch: "feature",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [{ name: "about", png: after(), flaky: "review", flake }],
    });
    const [prAbout] = await rows(ctx, pr);
    await reviewSnapshot(ctx.db, {
      projectId: ctx.projectId,
      snapshotId: must(prAbout, "the PR's about shot").id,
      state: "accepted",
      userId: ctx.userId,
    });
    // The merge build: `about` holds the accepted image, `contact` the same bytes under a key
    // nobody accepted them for, and both are labelled with the open flaky shot of their key.
    const merged = await upload(ctx, {
      branch: "main",
      commit: sha(3),
      ancestors: [sha(1)],
      shots: [
        { name: "about", png: after() },
        { name: "contact", png: after(), flaky: "review", flake },
      ],
    });
    const byName = new Map((await rows(ctx, merged)).map((row) => [row.name, row]));
    expect(byName.get("about")).toMatchObject({ diffStatus: "changed", reviewState: "accepted" });
    expect(byName.get("about")?.flakeId).not.toBeNull();
    expect(byName.get("contact")).toMatchObject({ diffStatus: "new", reviewState: "pending" });
    expect(merged.status).toBe("changes");
  });

  test("an image that is still pending on a pull request accepts nothing on main", async () => {
    const ctx = await context();
    await upload(ctx, {
      branch: "main",
      commit: sha(1),
      shots: [{ name: "about", png: before() }],
    });
    await upload(ctx, {
      branch: "feature",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [{ name: "about", png: after(), flaky: "review", flake }],
    });
    const merged = await upload(ctx, {
      branch: "main",
      commit: sha(3),
      ancestors: [sha(1)],
      shots: [{ name: "about", png: after() }],
    });
    expect((await onlyShot(ctx, merged)).reviewState).toBe("pending");
    expect(merged.status).toBe("changes");
  });
});
