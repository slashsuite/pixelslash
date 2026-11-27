// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import {
  MANIFEST_NOTICE,
  type ParityPairView,
  type ParityShotColumn,
  type ParityView,
  missingColumn,
  pairSideOf,
  physicalSize,
  similarityText,
} from "#/lib/parity-view";
import { render, screen } from "#/test/render";
import { ParityBody } from "./parity-view";

/**
 * The parity view's screen: the columns in order with a missing platform named, the links, and how
 * a pair reads. What the columns hold and what the metrics say is `api/parity.test.ts`; the size,
 * scale and hint words are `lib/parity-view.test.ts`'s.
 */

const source = { kind: "build", commitSha: null } as const;

function shotColumn(
  over: Partial<ParityShotColumn> & Pick<ParityShotColumn, "platform" | "snapshotId">,
): ParityShotColumn {
  const device = { web: null, android: "Pixel 8 API 35", ios: "iPhone 15" }[over.platform];
  const size = over.platform === "web" ? { width: 160, height: 120 } : { width: 480, height: 360 };
  const scale = over.platform === "web" ? null : 3;
  return {
    kind: "shot",
    device,
    viewport: over.platform === "web" ? "1280x720" : "412x915",
    label: device ? `${over.platform} · ${device}` : "web",
    source,
    scale,
    size,
    physical: physicalSize(size, scale),
    imageUrl: `/img/${over.snapshotId}`,
    stale: null,
    hasMetrics: true,
    similarity: null,
    buildId: "b1",
    projectId: "p1",
    projectName: "parity",
    ...over,
  };
}

const web = shotColumn({ platform: "web", snapshotId: "web-1" });
const android = shotColumn({
  platform: "android",
  snapshotId: "android-1",
  similarity: { against: null, score: 0.93, text: similarityText(0.93) },
});
const ios = shotColumn({ platform: "ios", snapshotId: "ios-1", hasMetrics: false });

const heightPair: ParityPairView = {
  a: pairSideOf(web),
  b: pairSideOf(android),
  status: "drift",
  lacks: [],
  mismatches: ["button height 40 web vs 44 android"],
  declared: [],
  tolerance: null,
};

const view = (columns: ParityView["columns"], pairs: ParityPairView[]): ParityView => ({
  name: "Button/primary",
  theme: "dark",
  columns,
  metrics: { manifest: false, notice: MANIFEST_NOTICE, pairs, rawColumns: [], raw: [] },
});

const href = (name: string) => screen.getByRole("link", { name }).getAttribute("href");

/** The platforms the columns are headed by, in the order drawn. */
const platforms = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

describe("the parity view with a web and an android shot", () => {
  const two = view([web, android, missingColumn("Button/primary", "dark", "ios")], [heightPair]);

  test("draws web then android at one physical size, then the platform with no shot, saying so", async () => {
    await render(<ParityBody view={two} />);
    expect(platforms()).toEqual(["web", "android", "ios"]);
    expect(screen.getByText("no ios twin")).toBeTruthy();
    expect(screen.getByText("Button/primary dark has no ios twin")).toBeTruthy();
    expect(screen.getByText("160 × 120 px at 3x")).toBeTruthy();
  });

  test("each column links to that shot's own review page", async () => {
    await render(<ParityBody view={two} />);
    expect(href("android · Pixel 8 API 35")).toMatch(/\/builds\/b1\/snapshots\/android-1$/);
    expect(href("web")).toMatch(/\/builds\/b1\/snapshots\/web-1$/);
  });
});

describe("the parity view with all three platforms", () => {
  const notMeasured: ParityPairView = {
    a: pairSideOf(web),
    b: pairSideOf(ios),
    status: "not_measured",
    lacks: ["ios"],
    mismatches: [],
    declared: [],
    tolerance: null,
  };

  test("a pair with a shot that has no metrics file reads not measured, never drift", async () => {
    await render(<ParityBody view={view([web, android, ios], [heightPair, notMeasured])} />);
    expect(screen.getByText("not measured: no metrics file on ios")).toBeTruthy();
  });
});

describe("an unlinked shot's parity view", () => {
  test("names every platform that has no shot, in the Unlinked list's words", async () => {
    await render(
      <ParityBody
        view={view(
          [
            missingColumn("Button/loading", "dark", "web"),
            missingColumn("Button/loading", "dark", "android"),
            ios,
          ],
          [],
        )}
      />,
    );
    expect(screen.getByText("Button/loading dark has no web twin")).toBeTruthy();
    expect(screen.getByText("Button/loading dark has no android twin")).toBeTruthy();
    expect(screen.getByText("Only one platform has a shot here: nothing to compare.")).toBeTruthy();
  });
});
