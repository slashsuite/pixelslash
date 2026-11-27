import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { DiffResult } from "#/db/diff-json";
import { SnapshotOverlay } from "./snapshot-overlay";

/**
 * The overlay's range (0 to 100) is the top layer's opacity (0 to 1): the diff image drawn over
 * Branch at that strength, and not drawn at all with no diff image.
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

const html = (opacity: number, diffUrl: string | null = "/img/diff.png") =>
  renderToStaticMarkup(
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

/** The style of the top layer, or null when it is not drawn. */
const top = (out: string) => /<img[^>]*data-testid="overlay-top"[^>]*>/.exec(out)?.[0] ?? null;

test.each([
  [50, "opacity:0.5"],
  [20, "opacity:0.2"],
  [0, "opacity:0"],
  [100, "opacity:1"],
])("the range at %i draws the top layer at %s", (opacity, style) => {
  expect(top(html(opacity))).toContain(style);
});

test("with no diff image there is no top layer", () => {
  expect(top(html(50, null))).toBeNull();
});
