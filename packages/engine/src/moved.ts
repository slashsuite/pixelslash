import {
  blocksOf,
  byteAt,
  CLOSE,
  compareLines,
  lineCount,
  lineHash,
  lineOffsets,
  MIN_LINES,
  num,
  samePixel,
  type Block,
  type MoveInput,
  type Span,
} from "./move-lines.ts";
import {
  findRegions,
  PIXEL_CHANGED,
  type Region,
  type RegionOptions,
  type RegionResult,
} from "./regions.ts";

export type { MoveInput } from "./move-lines.ts";

/**
 * Moved blocks.
 *
 * When a gap grows by 4 px, everything below it moves down 4 px with its content intact. Compared
 * pixel for pixel, the whole lower half differs, and it used to be painted as one red change. This
 * pass finds the blocks of a `change` region that are Main's content moved by whole pixels, takes
 * their pixels out of the field (and the red out of the overlay), and reports each as a `moved`
 * region with its `dx`, `dy` and the rectangle it came from. What is left red is what really
 * changed: the strip the block vacated, or an edit inside it.
 *
 * The rule, per `change` region and axis (vertical first, then horizontal on what is left):
 *
 *  1. Lines. A line is one row of the region's columns (vertical) or one column of its rows
 *     (horizontal). Each Branch line is matched to a Main line over the same span: byte for byte,
 *     or every pixel within the diff's own colour threshold.
 *  2. An offset per line, in this order: the previous line's non-zero offset (a block keeps
 *     moving together), else 0 (the line did not move), else the nearest Main line with the same
 *     content hash. A line that matches nothing, or was given a guessed offset, takes the next
 *     line's offset if it fits as well (a backward pass), so a block's first lines are not lost to
 *     a repeated border.
 *  3. Blocks. A run of lines with one non-zero offset is a block, trimmed at both ends of lines
 *     that are one colour (blank space fits any offset) or that also match at 0. A block needs
 *     MIN_LINES lines, MIN_CONTENT_LINES of them not one colour: a few blank lines prove nothing.
 *     What it clears must be MIN_SIDE across too: one glyph matches its twin anywhere on a page.
 *  4. A move, not a copy. When Branch still shows the block's content where it came from, the
 *     content was not moved: something else now looks like a thing that is still there (an icon
 *     swapped for one that also sits higher up). That block stays `change`.
 *
 * Only `change` regions are searched, after the shift labels: a region `shift.ts` already calls a
 * sub-pixel shift, or noise, keeps that label.
 *
 * Only whole-pixel moves along one axis are found; a diagonal move, a move with a fractional part
 * (that is `shift.ts`'s) and a block that moved and changed stay `change`. Sizes may differ: the
 * Main line may lie outside the overlap, and the block on Branch is clipped to it.
 */

/** A block narrower than this across the move (in what it clears) is not called a move. */
const MIN_SIDE = 12;

/** Field and overlay index of (line, p) on the overlap's grid. */
function cellAt(width: number, vertical: boolean, line: number, p: number): number {
  return vertical ? line * width + p : p * width + line;
}

/**
 * The block's differing pixels that the move explains, as (line, p) pairs, and their extent
 * across the move. A pixel it does not explain (a corner re-rasterised, an edit inside) stays changed.
 */
function movedCells(input: MoveInput, vertical: boolean, block: Block) {
  const { field } = input;
  const cells: number[] = [];
  let q0 = Infinity;
  let q1 = -Infinity;
  for (let line = block.l0; line <= block.l1; line++) {
    for (let p = block.p0; p <= block.p1; p++) {
      if (num(field.kind, cellAt(field.width, vertical, line, p), 0) === 0) continue;
      const ia = byteAt(input.main, vertical, line - block.d, p);
      if (!samePixel(input, ia, byteAt(input.branch, vertical, line, p))) continue;
      cells.push(line, p);
      q0 = Math.min(q0, p);
      q1 = Math.max(q1, p);
    }
  }
  return { cells, q0, q1 };
}

/** Take `cells` out of the field and their red out of the overlay; the counts they held. */
function clearCells(input: MoveInput, vertical: boolean, cells: number[]) {
  const { field, overlay } = input;
  let changed = 0;
  let antialiased = 0;
  for (let i = 0; i < cells.length; i += 2) {
    const line = num(cells, i, 0);
    const p = num(cells, i + 1, 0);
    const at = cellAt(field.width, vertical, line, p);
    if (field.kind[at] === PIXEL_CHANGED) {
      changed++;
      const io = cellAt(overlay.width, vertical, line, p) * 4;
      overlay.data.fill(0, io, io + 4);
    } else antialiased++;
    field.kind[at] = 0;
    field.amplitude[at] = 0;
    field.lighter[at] = 0;
  }
  return { changed, antialiased };
}

/** The `moved` region for `block`, spanning `q0..q1` across the move. */
function movedRegion(vertical: boolean, block: Block, q0: number, q1: number): Region {
  const along = { at: block.l0, len: block.l1 - block.l0 + 1 };
  const across = { at: q0, len: q1 - q0 + 1 };
  const box = vertical
    ? { x: across.at, y: along.at, w: across.len, h: along.len }
    : { x: along.at, y: across.at, w: along.len, h: across.len };
  const dx = vertical ? 0 : block.d;
  const dy = vertical ? block.d : 0;
  const content = block.exact ? "content identical" : "content the same within the threshold";
  return {
    ...box,
    changedPixels: 0,
    antialiasedPixels: 0,
    kind: "moved",
    why: `${moveWords(dx, dy)}, ${content}`,
    move: { dx, dy, from: { ...box, x: box.x - dx, y: box.y - dy } },
  };
}

/**
 * Take the block's pixels out of the field and its red out of the overlay; the `moved` region it
 * makes, with the pixels it cleared, or null when it is a copy, covered no differing pixel, or is
 * narrower than MIN_SIDE across the move.
 */
function clearBlock(
  input: MoveInput,
  vertical: boolean,
  block: Block,
): { region: Region; changed: number; antialiased: number } | null {
  if (stillThere(input, vertical, block)) return null;
  const { cells, q0, q1 } = movedCells(input, vertical, block);
  if (cells.length === 0 || q1 - q0 + 1 < MIN_SIDE) return null;
  return { region: movedRegion(vertical, block, q0, q1), ...clearCells(input, vertical, cells) };
}

/**
 * Step 4: whether Branch still has the block's content at the place it came from, so it was
 * copied, not moved. Counted over the lines that are not one colour: half or more matching at
 * their source is still there.
 */
function stillThere(input: MoveInput, vertical: boolean, block: Block): boolean {
  const scan = {
    input,
    vertical,
    span: { l0: block.l0, l1: block.l1, p0: block.p0, p1: block.p1 },
  };
  const branchLines = lineCount(input.branch, vertical);
  let content = 0;
  let there = 0;
  for (let line = block.l0; line <= block.l1; line++) {
    const from = line - block.d;
    if (lineHash(input.main, vertical, from, scan.span).uniform) continue;
    content++;
    if (from < 0 || from >= branchLines) continue;
    // Branch's line at the source against Main's: the same means the content never left.
    if (compareLines(scan, from, from) >= CLOSE) there++;
  }
  return content > 0 && there * 2 >= content;
}

/** "moved down 4 px", "moved left 12 px". */
export function moveWords(dx: number, dy: number): string {
  if (dy !== 0) return `moved ${dy > 0 ? "down" : "up"} ${Math.abs(dy)} px`;
  return `moved ${dx > 0 ? "right" : "left"} ${Math.abs(dx)} px`;
}

/** The region's lines (along `vertical`'s axis) and positions across it. */
function spanOf(r: Region, vertical: boolean): Span {
  return vertical
    ? { l0: r.y, l1: r.y + r.h - 1, p0: r.x, p1: r.x + r.w - 1 }
    : { l0: r.x, l1: r.x + r.w - 1, p0: r.y, p1: r.y + r.h - 1 };
}

/** The blocks of one `change` region that moved along the axis, each cleared as it is found. */
function movesIn(input: MoveInput, vertical: boolean, region: Region) {
  if (region.kind !== "change") return [];
  const scan = { input, vertical, span: spanOf(region, vertical) };
  if (scan.span.l1 - scan.span.l0 + 1 < MIN_LINES) return [];
  return blocksOf(scan, lineOffsets(scan)).flatMap(
    (block) => clearBlock(input, vertical, block) ?? [],
  );
}

export type Moves = {
  /** The regions found again over the field with the moved blocks taken out. */
  found: RegionResult;
  moved: Region[];
  /** What the moved blocks took out of the changed and anti-aliased counts. */
  changed: number;
  antialiased: number;
};

/**
 * Find the moved blocks in `found`'s `change` regions (already labelled), vertical then
 * horizontal, clear them from the field and the overlay (both are written in place), and find the
 * regions again on what is left, labelled with `label`. `found` is returned as it was when nothing
 * moved.
 */
export function findMoves(
  found: RegionResult,
  input: MoveInput,
  options: RegionOptions,
  label: (regions: Region[]) => Region[],
): Moves {
  const moves: Moves = { found, moved: [], changed: 0, antialiased: 0 };
  for (const vertical of [true, false]) {
    const before = moves.moved.length;
    for (const cleared of moves.found.regions.flatMap((r) => movesIn(input, vertical, r))) {
      moves.moved.push(cleared.region);
      moves.changed += cleared.changed;
      moves.antialiased += cleared.antialiased;
    }
    if (moves.moved.length > before) {
      const again = findRegions(input.field, options);
      moves.found = { ...again, regions: label(again.regions) };
    }
  }
  return moves;
}
