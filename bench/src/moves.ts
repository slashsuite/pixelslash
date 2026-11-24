/**
 * The moved-block guard, run by `bench:check`: each pair in bench/moves/ holds a block that moved
 * intact by whole pixels (moves-cases.ts). The engine must call the shot changed, report that move
 * as one `moved` region over the labelled box, and paint no more red than the strip the block
 * vacated (the move times the box's other side). Argos has no verdict on these, so they are not a
 * scored corpus; a failure here is a regression whatever the scores say.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { measurePngs } from "@slashsuite/pixelslash-engine/diff";
import { MOVES_DIR, parseLabel, type CaseLabel } from "./corpus.ts";

/** What the engine made of one pair, as much as the guard reads. */
export type MoveResult = {
  changed: boolean;
  changedPixels: number;
  regions: {
    kind: string;
    x: number;
    y: number;
    w: number;
    h: number;
    move?: { dx: number; dy: number };
  }[];
};

/** Why `result` fails the case's label, or none: an empty list is a pass. */
export function moveFailures(label: CaseLabel, result: MoveResult): string[] {
  const { move, box } = label;
  if (!move || !box) return ["label.json has no move or box"];
  const fails: string[] = [];
  if (!result.changed) fails.push("not changed: a moved block is still a change");
  const moved = result.regions.filter((r) => r.kind === "moved");
  const hit = moved.filter((r) => r.move?.dx === move.dx && r.move?.dy === move.dy);
  if (hit.length !== 1)
    fails.push(
      `want one moved region by ${move.dx},${move.dy}, got ${JSON.stringify(moved.map((r) => r.move))}`,
    );
  const overlaps = hit.some(
    (r) => r.x < box.x + box.w && box.x < r.x + r.w && r.y < box.y + box.h && box.y < r.y + r.h,
  );
  if (hit.length === 1 && !overlaps) fails.push("the moved region misses the labelled box");
  const vacated = Math.abs(move.dx) * box.h + Math.abs(move.dy) * box.w;
  if (result.changedPixels > vacated)
    fails.push(`${result.changedPixels} px changed, more than the ${vacated} px the block vacated`);
  return fails;
}

/** Every pair in bench/moves/, measured; one line per failure, `<case>: <why>`. */
export function checkMoves(dir = MOVES_DIR): { cases: number; failures: string[] } {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .toSorted();
  const failures = names.flatMap((name) => {
    const at = join(dir, name);
    const label = parseLabel(readFileSync(join(at, "label.json"), "utf8"));
    const result = measurePngs(
      readFileSync(join(at, "base.png")),
      readFileSync(join(at, "head.png")),
    );
    return moveFailures(label, result).map((why) => `${name}: ${why}`);
  });
  return { cases: names.length, failures };
}
