import type { DiffResult } from "#/db/schema";

/**
 * A diff's `change` regions (the boxes painted red) and its `moved` ones (blocks that moved
 * intact). Both make a shot changed; a line that counts only the boxes says a moves-only shot
 * changed in 0 boxes.
 */
export function regionCounts(result: Pick<DiffResult, "regions">): {
  boxes: number;
  moved: number;
} {
  let boxes = 0;
  let moved = 0;
  for (const region of result.regions) {
    if (region.kind === "change") boxes++;
    else if (region.kind === "moved") moved++;
  }
  return { boxes, moved };
}

/** `" · 2 moved intact"`, or nothing when no block moved. */
export function movedSuffix(moved: number): string {
  return moved > 0 ? ` · ${moved} moved intact` : "";
}
