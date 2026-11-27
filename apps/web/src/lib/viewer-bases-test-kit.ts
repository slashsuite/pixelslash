import type { BaselineBuild } from "#/db/baseline-build";
import type { DiffRegion, DiffResult } from "#/db/diff-json";
import { formatNumber, formatPercent } from "./format";
import type { BasesInput, Format } from "./viewer-bases";

/**
 * A feature-branch shot as the viewer's bases read it, shared by `viewer-bases.test.ts` (the rule)
 * and `components/snapshot-viewer.test.tsx` (the pane that draws it). By default it is carried
 * from an earlier build of its branch, identical to that build, and 400 px off main's baseline.
 */

export const MAIN = "/img/main-baseline.png";
export const PREVIOUS = "/img/previous-build.png";

export const FORMAT: Format = { number: formatNumber, percent: formatPercent };

const region = (x: number): DiffRegion => ({
  x,
  y: 4,
  w: 20,
  h: 10,
  changedPixels: 200,
  antialiasedPixels: 0,
  kind: "change",
});

export const result = (over: Partial<DiffResult>): DiffResult => ({
  changedPixels: 0,
  antialiasedPixels: 0,
  ignoredPixels: 0,
  ignored: [],
  specks: { count: 0, pixels: 0 },
  regions: [],
  width: 100,
  height: 50,
  mainWidth: 100,
  mainHeight: 50,
  branchWidth: 100,
  branchHeight: 50,
  sizeChanged: false,
  ...over,
});

/** Identical to the previous build; 400 px and two regions different from main. */
export const againstPrevious = result({ settledBy: "identical-bytes" });
export const againstMain = result({ changedPixels: 400, regions: [region(5), region(40)] });

const earlier: BaselineBuild = {
  snapshotId: "snap-1",
  buildId: "build-1",
  branch: "feat",
  commitSha: "50d549b1234",
  isDefaultBranch: false,
};
export const mainsBuild: BaselineBuild = { ...earlier, branch: "main", isDefaultBranch: true };

/** The carried shot, with these fields changed. */
export const input = (
  over: Omit<Partial<BasesInput>, "snapshot"> & { snapshot?: Partial<BasesInput["snapshot"]> },
): BasesInput => ({
  branch: "feat",
  baselineBuild: earlier,
  images: { main: PREVIOUS, mainBaseline: MAIN, diff: null },
  ...over,
  snapshot: {
    carriedFrom: "snap-1",
    diffResult: againstPrevious,
    mainDiffStatus: "changed",
    mainDiffResult: againstMain,
    ...over.snapshot,
  },
});
