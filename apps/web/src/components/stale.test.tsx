// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest";
import type { SnapshotView } from "#/db/review";
import type { DiffResult } from "#/db/schema";
import type { StaleItem } from "#/lib/stale";
import { must } from "#/test/must";
import { render, screen } from "#/test/render";
import { snapshotView } from "#/test/snapshot-view";
import { toReviewText } from "./build-header";
import { measured } from "./shot-card";
import { StaleList } from "./stale";

// The shot card's flaky-shot badge imports a server function, which loads the Worker's env and session.
vi.mock("#/server/env", () => import("#/test/render").then((m) => m.serverEnv));
vi.mock("#/server/session", () => import("#/test/render").then((m) => m.serverSession));

/**
 * A stale native twin as the screens say it: the project page's list and the line on the native
 * shot itself. The badge on a twin row is `twins.test.tsx`'s. When a key goes stale and when it
 * clears is `db/stale.test.ts`.
 */

const item = (over: Partial<StaleItem> = {}): StaleItem => ({
  name: "Button/md-primary",
  theme: "dark",
  platform: "android",
  cause: {
    snapshotId: "web-9",
    buildId: "0123456789abcdef",
    projectId: "p1",
    projectName: "stale",
    acceptedBy: "E2E Octocat",
    acceptedAt: new Date("2026-11-03T10:00:00Z"),
  },
  shots: [
    {
      snapshotId: "android-1",
      buildId: "b2",
      projectId: "p1",
      device: "Pixel 8 API 35",
      viewport: "412x915",
    },
  ],
  ...over,
});

/** The list's one line per stale key. A row has no role of its own; its test id names it. */
const lines = () => screen.queryAllByTestId("stale-item");

describe("the project page's Stale list", () => {
  test("says which twin is stale, which build changed it, and who accepted it", async () => {
    await render(<StaleList items={[item()]} />);
    expect(lines()).toHaveLength(1);
    expect(
      screen.getByText(
        (_, el) =>
          el?.textContent ===
          "Button/md-primary dark on android is stale: web changed in build 01234567, accepted by E2E Octocat 2026-11-03",
      ),
    ).toBeTruthy();
  });

  test("the cause is a link to the build's web shot, named by the first eight characters", async () => {
    await render(<StaleList items={[item()]} />);
    expect(screen.getByRole("link", { name: "01234567" }).getAttribute("href")).toMatch(
      /\/builds\/0123456789abcdef\/snapshots\/web-9$/,
    );
  });

  test("offers the native shot a reviewer accepts", async () => {
    await render(<StaleList items={[item()]} />);
    expect(
      screen.getByRole("link", { name: "Review the android shot" }).getAttribute("href"),
    ).toMatch(/\/builds\/b2\/snapshots\/android-1$/);
  });

  test("several devices and sizes of one key are one line that says so", async () => {
    const shot = must(item().shots[0], "the fixture's shot");
    const two = item({ shots: [shot, { ...shot, snapshotId: "android-2", viewport: "800x1280" }] });
    await render(<StaleList items={[two]} />);
    expect(lines()).toHaveLength(1);
    expect(screen.getByText("2 devices and sizes")).toBeTruthy();
  });

  test("a project with nothing stale draws no list", async () => {
    await render(<StaleList items={[]} />);
    expect(lines()).toEqual([]);
    expect(screen.queryByRole("heading", { name: /Stale/ })).toBeNull();
  });
});

const result: DiffResult = {
  changedPixels: 0,
  antialiasedPixels: 0,
  ignoredPixels: 0,
  ignored: [],
  specks: { count: 0, pixels: 0 },
  regions: [],
  width: 412,
  height: 915,
  mainWidth: 412,
  mainHeight: 915,
  branchWidth: 412,
  branchHeight: 915,
  sizeChanged: false,
};

/** An unchanged, undecided android shot: the fields the line and the group read, the rest empty. */
const nativeShot = (over: Partial<SnapshotView> = {}): SnapshotView =>
  snapshotView({
    id: "android-1",
    name: "Button/md-primary",
    platform: "android",
    browser: "Pixel 8 API 35",
    scale: 2.625,
    viewport: "412x915",
    theme: "dark",
    tags: ["native"],
    diffStatus: "unchanged",
    imageKey: "android-1.png",
    diffResult: result,
    staleOf: "web-9",
    ...over,
  });

describe("the line on a stale native shot", () => {
  test("an unchanged shot of a stale key says nothing differs here and why it still needs a review", () => {
    expect(measured(nativeShot(), false)).toBe(
      "no change here; the web twin changed, so this native shot needs a review",
    );
  });

  test("once a person accepted it, it says plain no change", () => {
    expect(measured(nativeShot({ reviewState: "accepted" }), false)).toBe("no change");
  });

  test("an unchanged shot of a fresh key says plain no change", () => {
    expect(measured(nativeShot({ staleOf: null }), false)).toBe("no change");
  });
});

describe("the build header's count", () => {
  test("one shot waiting is worded 1 to review, none is worded nothing to review", () => {
    expect(toReviewText(false, 1)).toBe("1 to review");
    expect(toReviewText(false, 0)).toBe("nothing to review");
    expect(toReviewText(true, 3)).toBe("baseline set");
  });
});
