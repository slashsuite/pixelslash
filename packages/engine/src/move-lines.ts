import type { Raster } from "./diff-probe.ts";
import type { DiffField } from "./regions.ts";
import { colourDelta } from "./yiq.ts";

/**
 * Steps 1 to 3 of the moved-block rule (`moved.ts` states it): each Branch line matched to a Main
 * line, an offset per line, and the runs of one offset long enough to call a block.
 */

/** A block shorter than this many lines is not called a move. */
export const MIN_LINES = 12;
/** Lines in a block that are not one colour: what makes the match evidence. */
const MIN_CONTENT_LINES = 3;
/** Nearest hash candidates tried for a line before it is given up on. */
const MAX_CANDIDATES = 8;
export const NONE = 0x7fffffff;
/**
 * A line's match: none; all but a few pixels (a rounded corner re-rasterised at a new offset);
 * every pixel within the colour threshold; or byte for byte.
 */
const DIFFERS = 0;
const ROUGH = 1;
export const CLOSE = 2;
export const IDENTICAL = 3;
export type Match = typeof DIFFERS | typeof ROUGH | typeof CLOSE | typeof IDENTICAL;
/** The pixels a line may miss by and still be ROUGH: at least this many, or a share of the span. */
const MIN_MISSES = 4;
const MISS_SHARE = 1 / 50;

/** The pair, the field over their overlap, the overlay and the threshold the pixel loop used. */
export type MoveInput = {
  main: Raster;
  branch: Raster;
  field: DiffField;
  /** The diff image, the larger shot's size; a moved pixel's red is cleared from it. */
  overlay: Raster;
  /** Squared colour distance above which two pixels differ. */
  maxDelta: number;
};

/** Lines along the move and positions across it, all inclusive. */
export type Span = { l0: number; l1: number; p0: number; p1: number };

/** One pass: the pair, the axis (rows when `vertical`) and the span of lines it compares. */
export type Scan = { input: MoveInput; vertical: boolean; span: Span };

export type Block = { d: number; l0: number; l1: number; p0: number; p1: number; exact: boolean };

/** The byte offset of position `p` on line `line`: a row when `vertical`, a column otherwise. */
export function byteAt(r: Raster, vertical: boolean, line: number, p: number): number {
  return (vertical ? line * r.width + p : p * r.width + line) * 4;
}

export function lineCount(r: Raster, vertical: boolean): number {
  return vertical ? r.height : r.width;
}

/** `a[i]`, or `fallback` past the end. */
export function num(a: ArrayLike<number>, i: number, fallback: number): number {
  return a[i] ?? fallback;
}

/** FNV-1a over the line's pixels, and whether they are all one colour. */
export function lineHash(r: Raster, vertical: boolean, line: number, span: Span) {
  const d = r.data;
  let hash = 0x811c9dc5;
  let first = -1;
  let uniform = true;
  for (let p = span.p0; p <= span.p1; p++) {
    const i = byteAt(r, vertical, line, p);
    const v =
      ((d[i] ?? 0) | ((d[i + 1] ?? 0) << 8) | ((d[i + 2] ?? 0) << 16)) +
      (d[i + 3] ?? 0) * 0x1000000;
    if (first === -1) first = v;
    else if (v !== first) uniform = false;
    hash = Math.imul(hash ^ v, 0x01000193);
  }
  return { hash: hash >>> 0, uniform };
}

/** Whether the pixel at byte `ia` of `a` is byte for byte the one at `ib` of `b`. */
function sameBytes(a: Uint8Array, ia: number, b: Uint8Array, ib: number): boolean {
  return (
    a[ia] === b[ib] && a[ia + 1] === b[ib + 1] && a[ia + 2] === b[ib + 2] && a[ia + 3] === b[ib + 3]
  );
}

/** Whether Branch's pixel at byte `ib` is Main's at `ia` within the threshold. */
export function samePixel(input: MoveInput, ia: number, ib: number): boolean {
  const a = input.main.data;
  const b = input.branch.data;
  if (sameBytes(a, ia, b, ib)) return true;
  return Math.abs(colourDelta(a, ia, b, ib)) <= input.maxDelta;
}

/** Branch line `lb` against Main line `lm`, over the span. */
export function compareLines({ input, vertical, span }: Scan, lb: number, lm: number): Match {
  const { main, branch } = input;
  if (lm < 0 || lm >= lineCount(main, vertical)) return DIFFERS;
  const allowed = Math.max(MIN_MISSES, Math.ceil((span.p1 - span.p0 + 1) * MISS_SHARE));
  let misses = 0;
  let exact = true;
  for (let p = span.p0; p <= span.p1; p++) {
    const ia = byteAt(main, vertical, lm, p);
    const ib = byteAt(branch, vertical, lb, p);
    if (sameBytes(main.data, ia, branch.data, ib)) continue;
    exact = false;
    if (samePixel(input, ia, ib)) continue;
    if (++misses > allowed) return DIFFERS;
  }
  if (misses > 0) return ROUGH;
  return exact ? IDENTICAL : CLOSE;
}

/** Branch line `lb` against the Main line `d` before it. */
const fits = (scan: Scan, lb: number, d: number): Match => compareLines(scan, lb, lb - d);

/** Main's non-uniform lines over the span, by content hash. */
function mainIndex({ input, vertical, span }: Scan): Map<number, number[]> {
  const index = new Map<number, number[]>();
  const lines = lineCount(input.main, vertical);
  for (let lm = 0; lm < lines; lm++) {
    const { hash, uniform } = lineHash(input.main, vertical, lm, span);
    if (uniform) continue;
    const at = index.get(hash);
    if (at) at.push(lm);
    else index.set(hash, [lm]);
  }
  return index;
}

type Lines = { d: Int32Array; match: Uint8Array; uniform: Uint8Array };
type Offset = { d: number; match: Match };
const NO_OFFSET: Offset = { d: NONE, match: DIFFERS };

/** The offset of the nearest Main line with `hash` that matches `lb`, or NONE. */
function nearest(scan: Scan, lb: number, candidates: number[] | undefined): Offset {
  if (!candidates) return NO_OFFSET;
  const tries = candidates
    .filter((lm) => lm !== lb)
    .toSorted((x, y) => Math.abs(x - lb) - Math.abs(y - lb))
    .slice(0, MAX_CANDIDATES);
  for (const lm of tries) {
    const match = compareLines(scan, lb, lm);
    if (match !== DIFFERS) return { d: lb - lm, match };
  }
  return NO_OFFSET;
}

/** A clean fit beats a rough one: the block's own offset first, then no move at all. */
function ranked(atPrev: Match, atZero: Match, prev: number): Offset | null {
  if (atPrev >= CLOSE) return { d: prev, match: atPrev };
  if (atZero >= CLOSE) return { d: 0, match: atZero };
  if (atPrev === ROUGH) return { d: prev, match: atPrev };
  return null;
}

/** Step 2, forward: line `lb`'s offset, given the previous line's. */
function forwardOffset(
  scan: Scan,
  index: Map<number, number[]>,
  lb: number,
  prev: number,
): Offset & { uniform: boolean } {
  const { hash, uniform } = lineHash(scan.input.branch, scan.vertical, lb, scan.span);
  const atPrev = prev === NONE || prev === 0 ? DIFFERS : fits(scan, lb, prev);
  const atZero = atPrev >= CLOSE ? DIFFERS : fits(scan, lb, 0);
  const clean = ranked(atPrev, atZero, prev);
  if (clean) return { ...clean, uniform };
  const guess = uniform ? NO_OFFSET : nearest(scan, lb, index.get(hash));
  const rough = guess.match === DIFFERS && atZero === ROUGH;
  return { ...(rough ? { d: 0, match: atZero } : guess), uniform };
}

/** Whether a line keeps its offset in the backward pass: it is the next line's, or either is still. */
const settled = (d: number, next: number) => d === next || d === 0 || next === NONE || next === 0;

/**
 * Step 2, backward: a block's first lines take its offset when it fits them, over no offset or a
 * guessed one (repeated lines have several candidates, and the nearest is not always the block's).
 */
function extendBack(scan: Scan, lines: Lines): void {
  for (let i = lines.d.length - 2; i >= 0; i--) {
    const next = num(lines.d, i + 1, NONE);
    const d = num(lines.d, i, NONE);
    if (settled(d, next)) continue;
    const match = fits(scan, scan.span.l0 + i, next);
    if (match === DIFFERS || (d !== NONE && match < num(lines.match, i, 0))) continue;
    lines.d[i] = next;
    lines.match[i] = match;
  }
}

/** Steps 1 and 2: an offset for each Branch line of the span. */
export function lineOffsets(scan: Scan): Lines {
  const n = scan.span.l1 - scan.span.l0 + 1;
  const lines: Lines = {
    d: new Int32Array(n).fill(NONE),
    match: new Uint8Array(n),
    uniform: new Uint8Array(n),
  };
  const index = mainIndex(scan);
  let prev = NONE;
  for (let i = 0; i < n; i++) {
    const { d, match, uniform } = forwardOffset(scan, index, scan.span.l0 + i, prev);
    lines.uniform[i] = uniform ? 1 : 0;
    lines.d[i] = d;
    lines.match[i] = match;
    prev = d;
  }
  extendBack(scan, lines);
  return lines;
}

/** The run `[start, end]` less its weak lines at both ends: blank, rough, or not moved. */
function trimmed(scan: Scan, lines: Lines, start: number, end: number): [number, number] {
  const weak = (i: number) =>
    lines.uniform[i] === 1 ||
    lines.match[i] === ROUGH ||
    compareLines(scan, scan.span.l0 + i, scan.span.l0 + i) >= CLOSE;
  let i0 = start;
  let i1 = end;
  while (i0 <= i1 && weak(i0)) i0++;
  while (i1 >= i0 && weak(i1)) i1--;
  return [i0, i1];
}

/** The lines of `[i0, i1]` that are not one colour and match, and whether every one is exact. */
function evidence(lines: Lines, i0: number, i1: number): { content: number; exact: boolean } {
  let content = 0;
  let exact = true;
  for (let i = i0; i <= i1; i++) {
    if (lines.uniform[i] === 0 && num(lines.match, i, 0) >= CLOSE) content++;
    if (lines.match[i] !== IDENTICAL) exact = false;
  }
  return { content, exact };
}

/** The block the run `[start, end]` of one offset makes, or null when it is not a move. */
function blockOf(scan: Scan, lines: Lines, start: number, end: number): Block | null {
  const d = num(lines.d, start, NONE);
  if (d === NONE || d === 0) return null;
  const [i0, i1] = trimmed(scan, lines, start, end);
  const { content, exact } = evidence(lines, i0, i1);
  if (i1 - i0 + 1 < MIN_LINES || content < MIN_CONTENT_LINES) return null;
  const { l0, p0, p1 } = scan.span;
  return { d, l0: l0 + i0, l1: l0 + i1, p0, p1, exact };
}

/** Step 3: the runs of one non-zero offset, trimmed, that are long enough to call a move. */
export function blocksOf(scan: Scan, lines: Lines): Block[] {
  const blocks: Block[] = [];
  const n = lines.d.length;
  for (let start = 0; start < n;) {
    let end = start;
    while (end + 1 < n && lines.d[end + 1] === lines.d[start]) end++;
    const block = blockOf(scan, lines, start, end);
    if (block) blocks.push(block);
    start = end + 1;
  }
  return blocks;
}
