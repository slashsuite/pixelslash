// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { must } from "#/test/must";
import { type BaseId, type BasesInput, basesOf } from "#/lib/viewer-bases";
import { FORMAT, MAIN, PREVIOUS, againstPrevious, input } from "#/lib/viewer-bases-test-kit";
import { render, screen } from "#/test/render";
import { SnapshotViewer, type ViewState } from "./snapshot-viewer";

/**
 * The left pane draws the base it is given and names it: main's baseline only when that is the
 * image, else the earlier build of the branch, and a carried shot opens on main with its boxes.
 * Which bases a shot has, which it opens on and their words are `lib/viewer-bases.test.ts`'s
 * tables; this proves the pane, the switch and the boxes follow them.
 */

const BRANCH = "/img/branch.png";

/** The view with `base` chosen on `snapshotId`, or nothing chosen. */
const viewOf = (base: { snapshotId: string; id: BaseId } | null): ViewState => ({
  mode: "side",
  onMode: () => {},
  scale: "fit",
  onScale: () => {},
  base,
  onBase: () => {},
});

function viewer(given: BasesInput, view: ViewState = viewOf(null)) {
  return render(
    <SnapshotViewer
      snapshotId="shot-2"
      bases={basesOf(given, FORMAT)}
      name="about"
      mainUrl={given.images.main}
      branchUrl={BRANCH}
      diffUrl={given.images.diff}
      result={given.snapshot.diffResult}
      removed={false}
      view={view}
      panel={null}
    />,
  );
}

// The pane's caption and the switch's summary have no role of their own: their test ids name them.
const leftLabel = () =>
  must(screen.getAllByTestId("pane-label")[0], "the left pane's label").textContent;
const summary = () => screen.getByTestId("base-summary").textContent;
const src = (alt: string) => screen.getByRole("img", { name: alt }).getAttribute("src");

describe("the shot viewer's left pane", () => {
  test("a carried shot opens on Against main: main's image, its boxes and its pixel count", async () => {
    await viewer(input({}));
    expect(leftLabel()).toMatch(/^Main \(baseline\)/);
    expect(src("about on main")).toBe(MAIN);
    expect(screen.queryByRole("img", { name: "about on the earlier build" })).toBeNull();
    // Two regions, drawn on each of the two panes, with no click on Highlight.
    expect(screen.getAllByRole("img", { name: "Measured regions" })).toHaveLength(2);
    // Each box is titled with its kind and size.
    expect(screen.getAllByText("change: 200 px")).toHaveLength(4);
    expect(summary()).toBe("400 changed px (8.0%) in 2 regions");
    expect(screen.getByText("Against main")).toBeTruthy();
    expect(screen.getByText("Against build 50d549b")).toBeTruthy();
  });

  test("a carried shot shown on its earlier build is labelled with that build, never Main", async () => {
    await viewer(input({}), viewOf({ snapshotId: "shot-2", id: "build" }));
    expect(leftLabel()).toMatch(/^Earlier build on this branch 50d549b/);
    expect(leftLabel()).not.toContain("Main");
    expect(src("about on the earlier build")).toBe(PREVIOUS);
    // Its own result is the empty one: identical bytes, nothing to box.
    expect(summary()).toBe("No change: identical bytes, not diffed.");
    expect(screen.queryAllByText(/^change:/)).toHaveLength(0);
  });

  test("a choice made on another shot does not carry over to this one", async () => {
    await viewer(input({}), viewOf({ snapshotId: "another-shot", id: "build" }));
    expect(src("about on main")).toBe(MAIN);
    expect(screen.getAllByRole("img", { name: "Measured regions" })).toHaveLength(2);
  });

  test("a shot with one base and a note has no switch, and shows the note", async () => {
    await viewer(input({ snapshot: { mainDiffStatus: null, mainDiffResult: null } }));
    expect(screen.queryByText("Against main")).toBeNull();
    expect(screen.getByTestId("base-note").textContent).toBe(
      "This shot was not measured against main.",
    );
  });

  test("main's side with no baseline image says there is none to compare with", async () => {
    await viewer(
      input({
        images: { main: PREVIOUS, mainBaseline: null, diff: null },
        snapshot: { mainDiffStatus: "new", mainDiffResult: null, diffResult: againstPrevious },
      }),
    );
    expect(leftLabel()).toMatch(/^Main \(baseline\)/);
    expect(screen.getByText("No baseline to compare with.")).toBeTruthy();
    expect(summary()).toBe("New against main: main has no such shot.");
  });
});
