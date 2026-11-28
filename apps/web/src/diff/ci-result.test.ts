import { diffPngs, summarizeDiff } from "@slashsuite/pixelslash-engine/diff";
import { describe, expect, test } from "vitest";
import { parseCiInput, pngSize } from "#/api/validate";
import {
  CiResultError,
  type CiUpload,
  NAMED_REFUSALS,
  checkCiResult,
  refusedMessage,
} from "./ci-result";
import { RED, shot } from "./test-shots";

/** The checks a CI result passes before it is stored (ob 1727), on a real engine result. */

const main = shot();
const branch = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const real = summarizeDiff(diffPngs(Buffer.from(main), Buffer.from(branch), {}));

function upload(diffResult: unknown, status: unknown = "changed"): CiUpload {
  return {
    engineVersion: "0.1.0",
    image: pngSize(branch.buffer),
    results: [{ baselineId: "b", status, diffResult, diffKey: "k" }],
  };
}

/** The baseline the server settled on: `b`, the size of `main`'s own header. */
const b = { id: "b", size: pngSize(main.buffer) };
const check = (u: unknown) => () => checkCiResult(u, b, {});

describe("checkCiResult", () => {
  test("the engine's own result passes and is stored as sent", () => {
    expect(checkCiResult(upload(real), b, {})).toMatchObject({ changed: true, diffKey: "k" });
  });

  test.each([
    ["nothing sent", null, /^no result/],
    ["a result for another baseline", { ...upload(real), results: [] }, /^no result/],
    ["a status the counts do not give", upload(real, "unchanged"), /does not follow/],
    ["a status that is not one", upload(real, "maybe"), /status must be/],
    [
      "a region outside the image",
      upload({ ...real, regions: [{ ...real.regions[0], x: 60 }] }),
      /outside/,
    ],
    [
      "more changed pixels than the image",
      upload({ ...real, changedPixels: 1e6 }),
      /exceed the overlap/,
    ],
    ["another shot's size", upload({ ...real, branchWidth: 65 }), /branch size/],
    ["a negative count", upload({ ...real, changedPixels: -1 }), /invalid result/],
    [
      "another baseline's size",
      upload({ ...real, mainHeight: 47 }),
      /main size .* baseline's 64x48/,
    ],
  ])("refuses %s", (_what, sent, reason) => {
    expect(check(sent)).toThrow(CiResultError);
    expect(check(sent)).toThrow(reason);
  });

  /**
   * A block that moved down 4 px: the box on Branch, its source on Main 4 px higher. It keeps the
   * pixels it explains, which the engine leaves out of the run's changedPixels.
   */
  const box = { x: 30, y: 20, w: 20, h: 16 };
  const moved = {
    ...real.regions[0],
    ...box,
    kind: "moved",
    changedPixels: real.changedPixels,
    antialiasedPixels: 0,
  };
  const withMove = (move: unknown, kind = "moved") =>
    upload({ ...real, regions: [...real.regions, { ...moved, kind, move }] });
  const down4 = { dx: 0, dy: 4, from: { ...box, y: 16 } };

  test("a moved region and its move are stored as sent", () => {
    const stored = checkCiResult(withMove(down4), b, {});
    expect(stored.diffResult.regions.at(-1)).toMatchObject({ kind: "moved", move: down4 });
  });

  test.each([
    ["a moved region with no move", withMove(undefined), /move must be an object/],
    ["a move on two axes", withMove({ ...down4, dx: 2 }), /exactly one axis/],
    [
      "a source that is not the box less the move",
      withMove({ ...down4, from: box }),
      /less the move/,
    ],
    ["a move on a change region", withMove(down4, "change"), /only for a moved region/],
  ])("refuses %s", (_what, sent, reason) => {
    expect(check(sent)).toThrow(reason);
  });

  test("a result for a baseline the server did not pick is stale", () => {
    expect(() => checkCiResult(upload(real), { ...b, id: "other" }, {})).toThrow(/^stale baseline/);
  });
});

describe("the upload's ci field", () => {
  test("is optional, and refuses an empty list or a baseline named twice", () => {
    expect(parseCiInput(undefined)).toBeNull();
    const r = { baselineId: "b", status: "changed", diffResult: {} };
    expect(() => parseCiInput({ engineVersion: "0.1.0", results: [] })).toThrow(/1 to/);
    expect(() => parseCiInput({ engineVersion: "0.1.0", results: [r, r] })).toThrow(/twice/);
  });

  test("the shot's size is read from its PNG header", () => {
    expect(pngSize(branch.buffer)).toEqual({ width: 64, height: 48 });
    expect(() => pngSize(new ArrayBuffer(8))).toThrow(/too short/);
  });
});

const refused = (n: number) => Array.from({ length: n }, (_, i) => `shot ${i}: stale baseline`);

describe("refusedMessage", () => {
  test("names every refused shot when there are few", () => {
    expect(refusedMessage(refused(2), 5)).toBe(
      "this project diffs in CI and 2 of 5 shots have no usable result; re-run the CI job. " +
        "shot 0: stale baseline; shot 1: stale baseline",
    );
  });

  // A run whose every shot was refused printed all 706 reasons on one line (PS-812).
  test("names the first few of many and counts the rest", () => {
    const message = refusedMessage(refused(706), 752);
    expect(message).toMatch(/^this project diffs in CI and 706 of 752 shots have no usable result/);
    expect(message.match(/stale baseline/g)).toHaveLength(NAMED_REFUSALS);
    expect(message).toMatch(/; and 703 more, each with its reason on the shot$/);
  });
});
