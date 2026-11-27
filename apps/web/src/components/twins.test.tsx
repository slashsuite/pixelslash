// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { render, screen } from "#/test/render";
import { type BuildTwins, type Twin, type TwinEntry, noTwins, twinEntryOf } from "#/lib/twins";
import { TwinsRow, UnlinkedShots } from "./twins";

/**
 * The Twins row of a shot's side panel and the build page's Unlinked list: what each names, how
 * many rows it draws, and where its links go. Which shots are twins is `db/twins.test.ts`.
 */

const android: Twin = {
  snapshotId: "android-1",
  platform: "android",
  device: "Pixel 8 API 35",
  viewport: "412x915",
  projectId: "p1",
  projectName: "app",
  buildId: "b1",
  source: { kind: "build", commitSha: null },
  hasMetrics: false,
  stale: null,
};

const entry = (over: Partial<TwinEntry> = {}): TwinEntry => ({
  snapshotId: "web-1",
  name: "Button/primary",
  theme: "dark",
  platform: "web",
  device: null,
  viewport: "1280x720",
  hasMetrics: false,
  stale: null,
  twins: [android],
  missing: [],
  ...over,
});

const unlinkedEntry = entry({
  snapshotId: "android-2",
  name: "Button/loading",
  platform: "android",
  device: "Pixel 8 API 35",
  twins: [],
  missing: ["web"],
});

const href = (name: string | RegExp) => screen.getByRole("link", { name }).getAttribute("href");
const row = (of: TwinEntry | null) => render(<TwinsRow projectId="p1" buildId="b1" entry={of} />);
const list = (of: BuildTwins) => render(<UnlinkedShots projectId="p1" buildId="b1" twins={of} />);

describe("the Twins row of the side panel", () => {
  test("lists the twin labelled by platform and device, with where it was found", async () => {
    await row(entry());
    expect(screen.getByRole("heading", { name: "Twins" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "android · Pixel 8 API 35" })).toBeTruthy();
    expect(screen.getByText("412x915 · same build")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Compare platforms" })).toBeTruthy();
  });

  test("the twin is a link to its own shot", async () => {
    await row(entry());
    expect(href("android · Pixel 8 API 35")).toMatch(
      /\/projects\/p1\/builds\/b1\/snapshots\/android-1$/,
    );
  });

  test("the android shot's row links back to the web shot", async () => {
    const back: Twin = {
      ...android,
      snapshotId: "web-1",
      platform: "web",
      device: null,
      viewport: "1280x720",
    };
    await row(entry({ snapshotId: "android-1", platform: "android", twins: [back] }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("1280x720 · same build")).toBeTruthy();
    expect(href("web")).toMatch(/\/snapshots\/web-1$/);
  });

  test("a platform with no shot under the key is named, not hidden", async () => {
    await row(entry({ missing: ["ios"] }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("No ios twin")).toBeTruthy();
  });

  test("a stale twin carries the badge and who accepted the web change", async () => {
    const stale = {
      snapshotId: "web-9",
      buildId: "b9",
      projectId: "p1",
      projectName: "app",
      acceptedBy: "E2E Octocat",
      acceptedAt: new Date("2026-11-03T10:00:00Z"),
    };
    await row(entry({ twins: [{ ...android, stale }] }));
    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getByText("web changed, accepted by E2E Octocat 2026-11-03")).toBeTruthy();
  });

  test("a fresh twin carries no badge", async () => {
    await row(entry());
    expect(screen.queryByText("Stale")).toBeNull();
  });

  test("a build with no other platform in play has no row and no Compare platforms link", async () => {
    const none = noTwins();
    expect(twinEntryOf(none, "web-1")).toBeNull();
    await row(twinEntryOf(none, "web-1"));
    expect(screen.queryByRole("heading", { name: "Twins" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Compare platforms" })).toBeNull();
  });
});

describe("the Unlinked list of the build page", () => {
  const twins: BuildTwins = { twinProject: null, linked: [entry()], unlinked: [unlinkedEntry] };

  test("names the shot that has no twin, and only that one", async () => {
    await list(twins);
    expect(screen.getByRole("heading", { name: "Unlinked" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Button/loading dark has no web twin" })).toBeTruthy();
    expect(screen.queryByText(/Button\/primary/)).toBeNull();
  });

  test("each unlinked shot opens the shot and the parity view of its key", async () => {
    await list(twins);
    expect(href("Button/loading dark has no web twin")).toMatch(/\/snapshots\/android-2$/);
    const compare = decodeURIComponent(String(href("Compare platforms")));
    expect(compare).toMatch(/\/parity\?/);
    expect(compare).toContain("name");
    expect(compare).toContain("Button/loading");
  });

  test.each<[string, BuildTwins]>([
    ["a web-only build", noTwins()],
    ["a build whose every shot is linked", { twinProject: null, linked: [entry()], unlinked: [] }],
  ])("%s has no Unlinked list and no Compare platforms link", async (_, of) => {
    await list(of);
    expect(screen.queryByRole("heading", { name: "Unlinked" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Compare platforms" })).toBeNull();
  });
});
