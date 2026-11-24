import { describe, expect, test } from "vitest";
import type { CaseLabel } from "../src/corpus.ts";
import { checkMoves, moveFailures, type MoveResult } from "../src/moves.ts";

const label: CaseLabel = {
  label: "real",
  kind: "moved",
  page: "dashboard",
  width: 640,
  height: 360,
  box: { x: 20, y: 250, w: 600, h: 100 },
  move: { dx: 0, dy: 4 },
};
const movedBy = (dx: number, dy: number) => ({
  kind: "moved",
  x: 20,
  y: 258,
  w: 600,
  h: 100,
  move: { dx, dy },
});

describe("the moved-block guard", () => {
  test("passes the committed pairs", () => {
    const { cases, failures } = checkMoves();
    expect(cases).toBeGreaterThanOrEqual(3);
    expect(failures).toEqual([]);
  });

  test("passes one moved region and red no wider than the strip the block vacated", () => {
    const ok: MoveResult = { changed: true, changedPixels: 2400, regions: [movedBy(0, 4)] };
    expect(moveFailures(label, ok)).toEqual([]);
  });

  test("fails red over the moved block, a wrong move, and a moves-only shot called unchanged", () => {
    const red: MoveResult = {
      changed: true,
      changedPixels: 60_000,
      regions: [{ kind: "change", x: 20, y: 254, w: 600, h: 100 }],
    };
    expect(moveFailures(label, red)).toHaveLength(2);
    expect(
      moveFailures(label, { changed: true, changedPixels: 0, regions: [movedBy(0, 3)] }),
    ).toHaveLength(1);
    expect(
      moveFailures(label, { changed: false, changedPixels: 0, regions: [movedBy(0, 4)] }),
    ).toHaveLength(1);
  });
});
