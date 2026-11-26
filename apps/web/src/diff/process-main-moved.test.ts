import { describe, expect, test } from "vitest";
import { type Ctx, context, rows, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/**
 * A branch built after main moved is measured against the build at its merge-base, not the image
 * main had when the branch was last built (PS-562, PS-703). On hackcove a branch rebased onto a main
 * that had changed the overview reported the overview as changed against main's old image: a false
 * change for every shot main had moved, though the branch touched none of them.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const blue = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: [0, 0, 255] }] });

const NAMES = ["overview", "settings", "pricing"] as const;
type Pngs = Partial<Record<(typeof NAMES)[number], typeof white>>;

/** Every page, white unless named. */
const pages = (changed: Pngs = {}) => NAMES.map((name) => ({ name, png: changed[name] ?? white }));

/** Main, a branch built on it, then main changing the overview under the branch. */
async function mainMovedUnderBranch(ctx: Ctx) {
  await upload(ctx, { branch: "main", commit: sha(1), shots: pages() });
  const before = await upload(ctx, {
    branch: "feat/nav",
    commit: sha(2),
    mergeBase: sha(1),
    shots: pages(),
  });
  expect(before.status).toBe("passed");
  return upload(ctx, {
    branch: "main",
    commit: sha(3),
    ancestors: [sha(1)],
    shots: pages({ overview: red }),
  });
}

/** Each shot's diff status and baseline, by name. */
async function measured(ctx: Ctx, buildId: Parameters<typeof rows>[1]) {
  return Object.fromEntries(
    (await rows(ctx, buildId)).map((row) => [
      row.name,
      { diffStatus: row.diffStatus, baselineKey: row.baselineKey, imageKey: row.imageKey },
    ]),
  );
}

describe("a branch built after main moved", () => {
  test("rebased onto the new main, it has zero false changes against the merge-base build", async () => {
    const ctx = await context();
    const main = await mainMovedUnderBranch(ctx);
    const after = await upload(ctx, {
      branch: "feat/nav",
      commit: sha(4),
      mergeBase: sha(3),
      ancestors: [sha(1)],
      shots: pages({ overview: red }),
    });
    const shots = await measured(ctx, after);
    for (const name of NAMES)
      expect({ name, diffStatus: shots[name]?.diffStatus }).toEqual({
        name,
        diffStatus: "unchanged",
      });
    // The overview main changed is measured against main's new image, not its old one.
    expect(shots["overview"]?.baselineKey).toBe((await measured(ctx, main))["overview"]?.imageKey);
    expect(after.status).toBe("passed");
  });

  test("its own change is the only one reported", async () => {
    const ctx = await context();
    await mainMovedUnderBranch(ctx);
    const after = await upload(ctx, {
      branch: "feat/nav",
      commit: sha(4),
      mergeBase: sha(3),
      ancestors: [sha(1)],
      shots: pages({ overview: red, pricing: blue }),
    });
    const statuses = Object.fromEntries(
      Object.entries(await measured(ctx, after)).map(([name, row]) => [name, row.diffStatus]),
    );
    expect(statuses).toEqual({ overview: "unchanged", settings: "unchanged", pricing: "changed" });
    expect(after.status).toBe("changes");
  });
});
