// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { must } from "#/test/must";
import { fireEvent, render, screen, within } from "#/test/render";
import type { DiffResult } from "#/db/schema";
import { CompositionFocus, CompositionPanel, type Composition, findingsLine } from "./composition";
import { SnapshotViewer, type ViewState } from "./snapshot-viewer";

/**
 * A composition-only project's findings (the gaps and special cases a walk measured), as the shot
 * page draws and lists them: the two lists, the boxes on the Branch pane only, the link between a
 * box and its row, the boxes' own toggle with its legend, and the count on the build page's card.
 */

const composition: Composition = {
  library: "Hack Cove UI",
  gaps: [
    {
      kind: "class",
      selector: "#go",
      tag: "button",
      classes: ["mt-7"],
      style: null,
      box: { x: 10, y: 10, width: 10, height: 10 },
    },
  ],
  special: [
    {
      selector: "#logo",
      reason: "the brand mark is drawn by hand",
      box: { x: 0, y: 20, width: 20, height: 20 },
    },
  ],
};

/** A 40 x 40 px shot measured against an identical baseline: the boxes sit at quarters of it. */
const measured: DiffResult = {
  changedPixels: 0,
  antialiasedPixels: 0,
  ignoredPixels: 0,
  ignored: [],
  specks: { count: 0, pixels: 0 },
  regions: [],
  width: 40,
  height: 40,
  mainWidth: 40,
  mainHeight: 40,
  branchWidth: 40,
  branchHeight: 40,
  sizeChanged: false,
};

const view: ViewState = {
  mode: "side",
  onMode: () => {},
  scale: "fit",
  onScale: () => {},
  base: null,
  onBase: () => {},
};

/** The shot page's pieces in the order the route lays them out: the viewer, then the panel. */
async function mount(result: DiffResult | null) {
  const { user } = await render(
    <CompositionFocus>
      <SnapshotViewer
        snapshotId="s1"
        bases={null}
        name="hero"
        mainUrl="/main.png"
        branchUrl="/branch.png"
        diffUrl={null}
        result={result}
        removed={false}
        composition={composition}
        view={view}
        panel={null}
      />
      <CompositionPanel composition={composition} />
    </CompositionFocus>,
  );
  return user;
}

// The boxes are drawn over the image with no role of their own: their test ids name them.
const gapBox = () => screen.getByTestId("gap-box");
const specialBox = () => screen.getByTestId("special-box");
const legend = () => screen.queryByLabelText("Composition legend");
const toggle = () => screen.getByRole("button", { name: "Composition" });
/** The gap's row in the list under the shot: the element that carries the focus mark. */
const gapRow = (): HTMLElement => {
  const item = within(screen.getByLabelText("Hack Cove UI gaps")).getAllByRole("listitem")[0];
  const row = item?.firstElementChild;
  if (!(row instanceof HTMLElement)) throw new Error("no gap row");
  return row;
};

describe("a shot's composition findings on the shot page", () => {
  test("one gap and one special case are listed under the shot, each with its reason", async () => {
    await mount(measured);
    expect(screen.getByText("Hack Cove UI gaps on Branch (1)")).toBeTruthy();
    expect(screen.getByLabelText("Hack Cove UI gaps").textContent).toContain(
      "extra classes on a Hack Cove UI component: mt-7",
    );
    expect(screen.getByText("Special cases on Branch (1)")).toBeTruthy();
    expect(screen.getByLabelText("Special cases").textContent).toContain(
      "the brand mark is drawn by hand",
    );
  });

  test("the boxes are drawn once each, on the Branch pane, at their share of the measured size", async () => {
    await mount(measured);
    expect(screen.getAllByTestId("gap-box")).toHaveLength(1);
    expect(screen.getAllByTestId("special-box")).toHaveLength(1);
    expect(gapBox().getAttribute("title")).toBe(
      "#go: extra classes on a Hack Cove UI component: mt-7",
    );
    // 10 of 40 px in from the left and 10 wide: a quarter and a quarter.
    expect(gapBox().style.left).toBe("25%");
    expect(gapBox().style.width).toBe("25%");
    expect(gapBox().style.top).toBe("25%");
    expect(specialBox().style.top).toBe("50%");
    // Only the Branch pane carries them.
    const panes = screen.getAllByRole("figure");
    expect(panes).toHaveLength(2);
    const branch = must(
      panes.find((pane) => pane.contains(gapBox())),
      "the pane with the box",
    );
    expect(within(branch).getByText("Branch")).toBeTruthy();
  });

  test("a new shot, which nothing measured, has its boxes placed on the image's own size", async () => {
    await mount(null);
    // Nothing measured it, so no box can be placed until the image says how big it is.
    expect(screen.queryByTestId("gap-box")).toBeNull();
    const img = must(
      screen.getAllByRole("img").find((el) => el.getAttribute("src") === "/branch.png"),
      "the Branch image",
    );
    Object.defineProperty(img, "naturalWidth", { value: 40 });
    Object.defineProperty(img, "naturalHeight", { value: 40 });
    fireEvent.load(img);
    expect(screen.getAllByTestId("gap-box")).toHaveLength(1);
    expect(screen.getAllByTestId("special-box")).toHaveLength(1);
    expect(gapBox().style.left).toBe("25%");
  });

  test("hovering a box lights its row, and hovering a row lights its box", async () => {
    const user = await mount(measured);
    expect(gapRow().hasAttribute("data-focused")).toBe(false);
    await user.hover(gapBox());
    expect(gapRow().getAttribute("data-focused")).toBe("true");
    await user.unhover(gapBox());
    expect(gapRow().hasAttribute("data-focused")).toBe(false);

    const idle = gapBox().style.zIndex;
    await user.hover(gapRow());
    expect(gapBox().style.zIndex).toBe("1");
    expect(idle).not.toBe("1");
    await user.unhover(gapRow());
    expect(gapBox().style.zIndex).not.toBe("1");
  });

  test("the boxes have their own toggle, and a legend that counts both kinds while they are drawn", async () => {
    const user = await mount(measured);
    const shown = must(legend(), "the legend");
    expect(shown.textContent).toContain("Not from Hack Cove UI");
    expect(shown.textContent).toContain("Special case");
    expect(shown.textContent?.replace(/\D/g, "")).toBe("11");
    await user.click(toggle());
    expect(screen.queryByTestId("gap-box")).toBeNull();
    expect(screen.queryByTestId("special-box")).toBeNull();
    expect(legend()).toBeNull();
    await user.click(toggle());
    expect(screen.queryByTestId("gap-box")).not.toBeNull();
    expect(legend()).not.toBeNull();
  });
});

describe("the build page's card for a composition shot", () => {
  test("counts the gaps, and the special cases when there are any", () => {
    expect(findingsLine(composition)).toBe("1 gap not from Hack Cove UI · 1 special");
    expect(findingsLine({ ...composition, special: [] })).toBe("1 gap not from Hack Cove UI");
    expect(findingsLine({ ...composition, gaps: [...composition.gaps, ...composition.gaps] })).toBe(
      "2 gaps not from Hack Cove UI · 1 special",
    );
  });
});
