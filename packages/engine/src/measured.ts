import type { DiffOptions, IgnoreRect, PixelDiff } from "./diff.ts";
import type { Raster } from "./diff-probe.ts";
import { findMoves } from "./moved.ts";
import { findRegions, type BlobBoxes, type DiffField, type Region } from "./regions.ts";
import { labelShifts } from "./shift.ts";
import { clearsFloors } from "./summary.ts";
import { colourDelta, MAX_YIQ_DELTA } from "./yiq.ts";

/** Measured on bench/corpus: keeps every real change there except one-level colour steps (ob 1485). */
export const DEFAULT_THRESHOLD = 0.01;

/** What the pixel loop counted, and the field it classified the overlap into. */
export type Counts = {
  changedPixels: number;
  antialiased: number;
  ignoredPixels: number;
  ignored: IgnoreRect[];
  field: DiffField;
};

/** The regions with `shift` labels applied; none when the sizes differ (there is no common grid). */
function labelRegions(regions: Region[], a: Raster, b: Raster, options: DiffOptions): Region[] {
  if (a.width !== b.width || a.height !== b.height) return regions;
  return labelShifts(
    regions,
    {
      main: a.data,
      branch: b.data,
      width: a.width,
      height: a.height,
      maxDelta: maxDeltaOf(options),
      delta: (ia, ib) => colourDelta(a.data, ia, b.data, ib),
    },
    options,
  );
}

/** The threshold as the squared colour distance the pixel loop compares against. */
function maxDeltaOf(options: DiffOptions): number {
  return MAX_YIQ_DELTA * (options.threshold ?? DEFAULT_THRESHOLD) ** 2;
}

/**
 * Everything after the pixel loop but the encode: regions, moved blocks, shift labels and floors.
 * The moved blocks are cleared from `counts.field` and from `overlay` in place, so the overlay is
 * encoded after this, never before. The WASM diff runs the loop and the blob pass itself (`blobs`).
 * Frees nothing: the buffers are the caller's.
 */
export function measure(
  [a, b]: [Raster, Raster],
  overlay: Raster,
  { changedPixels, antialiased, ignoredPixels, ignored, field }: Counts,
  { options = {}, blobs }: { options?: DiffOptions; blobs?: BlobBoxes | undefined },
): Omit<PixelDiff, "overlay"> {
  const found = findRegions(field, options, blobs);
  const label = (regions: Region[]) => labelRegions(regions, a, b, options);
  const moves = findMoves(
    { ...found, regions: label(found.regions) },
    { main: a, branch: b, field, overlay, maxDelta: maxDeltaOf(options) },
    options,
    label,
  );
  // The ratio floor is a share of what was measured: ignored pixels are not part of the denominator.
  const measured = field.width * field.height - ignoredPixels;
  const sizeChanged = a.width !== b.width || a.height !== b.height;
  const regions = [...moves.found.regions, ...moves.moved];
  const changed = sizeChanged || clearsFloors(regions, measured, options);
  return {
    changed,
    ignoredPixels,
    ignored,
    changedPixels: changedPixels - moves.changed,
    antialiased: antialiased - moves.antialiased,
    regions,
    specks: moves.found.specks,
    settledBy: "measured",
    width: overlay.width,
    height: overlay.height,
    mainWidth: a.width,
    mainHeight: a.height,
    branchWidth: b.width,
    branchHeight: b.height,
  };
}

/** The measured diff with its encoded overlay, in the key order the stored results were made in. */
export function withOverlay(
  {
    width,
    height,
    mainWidth,
    mainHeight,
    branchWidth,
    branchHeight,
    ...rest
  }: Omit<PixelDiff, "overlay">,
  overlay: Buffer,
): PixelDiff & { overlay: Buffer } {
  return { ...rest, overlay, width, height, mainWidth, mainHeight, branchWidth, branchHeight };
}
