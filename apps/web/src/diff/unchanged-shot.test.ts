import { describe, expect, test } from "vitest";
import { branchView } from "#/db/branch-view";
import { countBuilds } from "#/db/build-counts";
import { buildView } from "#/db/review";
import { groupOf } from "#/lib/snapshot-groups";
import { context, rows, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/**
 * An unchanged shot is a row of its own build like any other shot (it shares its image key with its
 * baseline, `image-store.test.ts`), so every reader resolves it from that row.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const shots = [
  { name: "a", png: white },
  { name: "b", png: red },
];

async function sentTwice() {
  const ctx = await context();
  await upload(ctx, { branch: "main", commit: sha(1), shots });
  const spec = { branch: "feat", mergeBase: sha(1), shots };
  await upload(ctx, { ...spec, commit: sha(2) });
  const second = await upload(ctx, { ...spec, commit: sha(3) });
  return { ctx, second, now: await rows(ctx, second) };
}

describe("an unchanged shot", () => {
  test("is counted, listed and shown against main as unchanged", async () => {
    const { ctx, second, now } = await sentTwice();
    expect(second.status).toBe("passed");
    const counts = (await countBuilds(ctx.db, [second.id])).get(second.id);
    expect(counts).toMatchObject({ unchanged: 2, changed: 0, new: 0, toReview: 0 });

    const page = await buildView(ctx.db, ctx.projectId, second.id);
    expect(new Map(page.snapshots.map((s) => [s.id, groupOf(s)]))).toEqual(
      new Map(now.map((row) => [row.id, "unchanged"])),
    );

    const branch = await branchView(ctx.db, ctx.projectId, "feat");
    expect(branch.build.id).toBe(second.id);
    expect(new Map(branch.againstMain.map((s) => [s.name, s.mainDiffStatus]))).toEqual(
      new Map([
        ["a", "unchanged"],
        ["b", "unchanged"],
      ]),
    );
  });
});
