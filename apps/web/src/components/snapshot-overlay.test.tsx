// @vitest-environment happy-dom
import { expect, test } from "vitest";
import type { DiffResult } from "#/db/diff-json";
import { render, screen } from "#/test/render";
import { SnapshotOverlay } from "./snapshot-overlay";

/**
 * The overlay's range (0 to 100) is the top layer's opacity (0 to 1): the diff image drawn over
 * Branch at that strength, and not drawn at all with no diff image. The range itself is driven in
 * `e2e/compare-view.spec.ts`, which leaves the style to this file.
 */

const result: DiffResult = {
  changedPixels: 200,
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
};

const overlay = (opacity: number, diffUrl: string | null = "/img/diff.png") =>
  render(
    <SnapshotOverlay
      name="hero"
      mainUrl="/img/main.png"
      branchUrl="/img/branch.png"
      diffUrl={diffUrl}
      result={result}
      highlight={false}
      scale="fit"
      crop={null}
      overlay={{ opacity, setOpacity: () => {} }}
    />,
  );

// The top layer is a decorative copy of the diff image; its test id is what names it.
test.each([
  [50, "0.5"],
  [20, "0.2"],
  [0, "0"],
  [100, "1"],
])("the range at %i draws the top layer at opacity %s", async (opacity, style) => {
  await overlay(opacity);
  expect(screen.getByTestId("overlay-top").style.opacity).toBe(style);
});

test("with no diff image there is no top layer", async () => {
  await overlay(50, null);
  expect(screen.queryByTestId("overlay-top")).toBeNull();
});
