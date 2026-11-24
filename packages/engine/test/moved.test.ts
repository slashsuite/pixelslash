import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, test } from "vitest";
import { measurePngs } from "../src/diff.ts";
import { moveWords } from "../src/moved.ts";
import type { Region } from "../src/regions.ts";

/** A block of content: a texture no two lines of which are alike, from `seed`. */
type Block = { x: number; y: number; w: number; h: number; seed: number };

/** A white page with the blocks painted on, 3 px cells of a seeded colour each. */
function page(width: number, height: number, blocks: Block[]): Buffer {
  const img = new PNG({ width, height });
  img.data.fill(255);
  for (const b of blocks) {
    let s = b.seed;
    const cells: number[] = [];
    const cols = Math.ceil(b.w / 3);
    for (let i = 0; i < cols * Math.ceil(b.h / 3); i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      cells.push(s >>> 8);
    }
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        const v = cells[Math.floor(y / 3) * cols + Math.floor(x / 3)] ?? 0;
        const at = ((b.y + y) * width + b.x + x) * 4;
        img.data[at] = v & 0xff;
        img.data[at + 1] = (v >> 8) & 0xff;
        img.data[at + 2] = (v >> 16) & 0xff;
      }
    }
  }
  return PNG.sync.write(img);
}

const header: Block = { x: 20, y: 10, w: 160, h: 30, seed: 1 };
const body = (y: number): Block => ({ x: 20, y, w: 160, h: 90, seed: 2 });
/** Whether (x, y) is on the 1 px border of the 261x121 card at `top`. */
function onBorder(top: number, x: number, y: number): boolean {
  const edge = (y === top || y === top + 120) && x >= 20 && x <= 280;
  return edge || ((x === 20 || x === 280) && y >= top && y <= top + 120);
}

/** A 261x121 card with a 1 px border at `top`, a block of text near its top and one 54 px lower. */
function card(top: number): Buffer {
  const img = PNG.sync.read(page(300, 200, [{ x: 40, y: top + 6, w: 200, h: 12, seed: 7 }]));
  const text = PNG.sync.read(page(300, 200, [{ x: 40, y: top + 60, w: 200, h: 12, seed: 8 }]));
  for (let y = 0; y < 200; y++)
    for (let x = 0; x < 300; x++) {
      const i = (y * 300 + x) * 4;
      if (onBorder(top, x, y)) img.data.set([0xcb, 0xd5, 0xe1, 255], i);
      else if (y >= top + 60) img.data.set(text.data.subarray(i, i + 4), i);
    }
  return PNG.sync.write(img);
}
const block = (x: number): Block => ({ x, y: 50, w: 60, h: 40, seed: 3 });
const icon = (y: number, seed: number): Block => ({ x: 20, y, w: 24, h: 24, seed });
const glyph = (x: number): Block => ({ x, y: 20, w: 8, h: 8, seed: 6 });
const moved = (regions: Region[]) => regions.filter((r) => r.kind === "moved");

/** Magenta pixels (the overlay's changed paint) inside `box`. */
function redIn(overlay: Buffer, box: { x: number; y: number; w: number; h: number }): number {
  const img = PNG.sync.read(overlay);
  let red = 0;
  for (let y = box.y; y < box.y + box.h; y++)
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i] === 255 && img.data[i + 1] === 0 && img.data[i + 2] === 255) red++;
    }
  return red;
}

describe("moved blocks", () => {
  test("a gap that grows by 4 px: the rows below are one moved block, red is only the gap", () => {
    const d = measurePngs(page(200, 200, [header, body(60)]), page(200, 200, [header, body(64)]));
    const [m, ...more] = moved(d.regions);
    expect(more).toEqual([]);
    expect(m?.move).toMatchObject({ dx: 0, dy: 4 });
    expect(m?.why).toBe("moved down 4 px, content identical");
    expect(m && { ...m.move?.from }).toEqual(m && { x: m.x, y: m.y - 4, w: m.w, h: m.h });
    // The 4 rows the block vacated are all that changed, and none of the block is red.
    expect(d.changedPixels).toBeLessThanOrEqual(160 * 4);
    expect(d.changedPixels).toBeGreaterThan(0);
    expect(m && redIn(d.overlay, m)).toBe(0);
    expect(d.changed).toBe(true);
  });

  test("the same move when the shot grows by those 4 px", () => {
    const d = measurePngs(page(200, 200, [header, body(60)]), page(200, 204, [header, body(64)]));
    expect(moved(d.regions).map((r) => r.move && [r.move.dx, r.move.dy])).toEqual([[0, 4]]);
    expect(d.changedPixels).toBeLessThanOrEqual(160 * 4);
    expect(d.changed).toBe(true);
  });

  test("a block that moved right 12 px", () => {
    const d = measurePngs(page(200, 120, [header, block(40)]), page(200, 120, [header, block(52)]));
    expect(moved(d.regions).map((r) => r.move && [r.move.dx, r.move.dy])).toEqual([[12, 0]]);
    expect(moved(d.regions)[0]?.why).toBe("moved right 12 px, content identical");
    expect(d.changedPixels).toBeLessThanOrEqual(12 * 40);
  });

  test("a shot whose only difference is a moved block is still a change", () => {
    // A list gap 1 px larger: every changed pixel moved intact, and nothing is red.
    const dir = join(
      import.meta.dirname,
      "../../../bench/corpus-holdout/real-spacing-gap-1px-pricing",
    );
    const d = measurePngs(readFileSync(join(dir, "base.png")), readFileSync(join(dir, "head.png")));
    expect(d.changedPixels).toBe(0);
    expect(d.regions.map((r) => r.kind)).toEqual(["moved"]);
    expect(d.changed).toBe(true);
  });

  test("a bordered card whose blank rows look the same moved or not is still a move", () => {
    const d = measurePngs(card(30), card(34));
    expect(moved(d.regions).map((r) => r.move && [r.move.dx, r.move.dy])).toEqual([[0, 4]]);
    expect(d.changedPixels).toBeLessThanOrEqual(261 * 4);
  });

  test("content that is still at its source was copied, not moved", () => {
    // An icon swapped for a twin of one higher up: the twin is still there, so this is a change.
    const d = measurePngs(
      page(100, 120, [icon(10, 4), icon(70, 5)]),
      page(100, 120, [icon(10, 4), icon(70, 4)]),
    );
    expect(moved(d.regions)).toEqual([]);
    expect(d.regions.some((r) => r.kind === "change")).toBe(true);
  });

  test("a block smaller than 12 px on a side is not called a move", () => {
    const d = measurePngs(page(100, 50, [glyph(20)]), page(100, 50, [glyph(40)]));
    expect(moved(d.regions)).toEqual([]);
  });

  test("moveWords names the axis and the direction", () => {
    expect([moveWords(0, 4), moveWords(0, -2), moveWords(12, 0), moveWords(-1, 0)]).toEqual([
      "moved down 4 px",
      "moved up 2 px",
      "moved right 12 px",
      "moved left 1 px",
    ]);
  });
});
