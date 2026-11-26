import { describe, expect, test } from "vitest";
import { mainStands } from "./against-main";
import { context, rows, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/**
 * Whether a branch shot's stored result against main still stands (ob 1723) is read from main's
 * shot, not its image: images are stored once per org by hash, so two shots of main can share one
 * image key while their ignore areas differ.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });

async function measured() {
  const ctx = await context();
  const mainBuild = await upload(ctx, {
    branch: "main",
    commit: sha(1),
    shots: [{ name: "a", png: white }],
  });
  const feat = await upload(ctx, {
    branch: "feat",
    commit: sha(2),
    mergeBase: sha(1),
    shots: [{ name: "a", png: red }],
  });
  const [onMain] = await rows(ctx, mainBuild);
  const [onFeat] = await rows(ctx, feat);
  if (!onMain || !onFeat) throw new Error("no rows");
  return { onMain, onFeat };
}

describe("mainStands", () => {
  test("the result names the main shot it was measured against", async () => {
    const { onMain, onFeat } = await measured();
    expect(onFeat).toMatchObject({
      mainDiffStatus: "changed",
      mainBaselineKey: onMain.imageKey,
      mainBaselineSnapshotId: onMain.id,
    });
  });

  test("stands against the same main shot", async () => {
    const { onMain, onFeat } = await measured();
    expect(mainStands(onFeat, onMain)).toBe(true);
  });

  test("does not stand against another main shot with the same image and other ignore areas", async () => {
    const { onMain, onFeat } = await measured();
    const another = {
      ...onMain,
      id: "another-main-shot",
      ignore: [{ x: 8, y: 8, width: 16, height: 12 }],
    };
    expect(another.imageKey).toBe(onFeat.mainBaselineKey);
    expect(mainStands(onFeat, another)).toBe(false);
  });

  test("a row measured before the shot was stored is measured again", async () => {
    const { onMain, onFeat } = await measured();
    expect(mainStands({ ...onFeat, mainBaselineSnapshotId: null }, onMain)).toBe(false);
  });

  test("new against main stands while main has no shot, and not once it has one", async () => {
    const { onMain, onFeat } = await measured();
    const isNew = {
      ...onFeat,
      mainBaselineKey: null,
      mainBaselineSnapshotId: null,
      mainDiffStatus: "new" as const,
    };
    expect(mainStands(isNew, undefined)).toBe(true);
    expect(mainStands(isNew, onMain)).toBe(false);
  });
});
