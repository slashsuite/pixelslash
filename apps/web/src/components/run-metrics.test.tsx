// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest";
import { branchWindow } from "#/db/run-metrics";
import { buildView } from "#/db/review";
import { must } from "#/test/must";
import { context, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { branchMetrics } from "#/lib/branch-metrics";
import { render, screen } from "#/test/render";
import { BranchMetrics } from "./branch-metrics";
import { BuildTimings } from "./build-timings";
import { Provenance } from "./provenance";

vi.mock("../../../../packages/engine/src/diff-module.bun.ts", () => import("#/test/diff-module"));

/**
 * Metrics in the review UI, from a real diffed build to the page: the build page's "This run"
 * card, the shot page's compare time and the branch page's window. The figures' words and
 * statistics are `lib/run-card`, `lib/run-metrics` and `lib/branch-metrics`' own tests; this
 * proves a build that went through the diff stores what the pages read, and the pages put it
 * where they say. The figures are read by their test ids: each is a number in a card whose label
 * the words tests already pin, and the id is what names which figure it is.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });

/** A store with main's build of two white shots and a work build that turns "hero" red. */
async function diffed() {
  const ctx = await context();
  await upload(ctx, {
    branch: "main",
    commit: sha(1),
    shots: [
      { name: "hero", png: white },
      { name: "ticker", png: white },
    ],
  });
  const work = await upload(ctx, {
    branch: "work",
    commit: sha(2),
    mergeBase: sha(1),
    ancestors: [sha(1)],
    shots: [
      { name: "hero", png: red },
      { name: "ticker", png: white },
    ],
  });
  return { ctx, view: await buildView(ctx.db, ctx.projectId, work.id) };
}

/** Draws the work build's "This run" card and opens it. */
async function runCard() {
  const { view } = await diffed();
  const { user } = await render(
    <BuildTimings
      build={view.build}
      shots={view.snapshots}
      defaultBranch="main"
      recaptures={null}
    />,
  );
  await user.click(screen.getByRole("button", { name: "This run" }));
}

const text = (id: string) => screen.getByTestId(id).textContent;

describe("a diffed build's page", () => {
  test("the run card states its wall time, counts and compare time, each with where it came from", async () => {
    await runCard();
    expect(text("run-wall-value")).toMatch(/\d/);
    expect(text("run-wall-source")).toContain("derived");
    expect(text("run-shots-value")).toBe("2");
    expect(text("run-compares-value")).toBe("1");
    // "ticker" is the same bytes as main: a shot of the build, and no compare ran.
    expect(text("run-cache-hits-value")).toBe("1");
    expect(text("run-unmeasured-value")).toBe("0");
    expect(text("run-compare-value")).toContain("2 snapshots · 1 compared");
    expect(text("run-compare-value")).toContain("p99 n/a (n = 1)");
    expect(text("run-compare-source")).toContain("stored by the server");
  });

  test.each(["run-auto-accepted", "run-recaptures", "run-tokens-explain", "run-no-timings"])(
    "a feature branch with no re-captures, no model and recorded timings draws no %s",
    async (id) => {
      await runCard();
      expect(screen.queryByTestId(id)).toBeNull();
    },
  );

  test("the diffed shot states who measured it and its compare time", async () => {
    const { view } = await diffed();
    const hero = must(
      view.snapshots.find((s) => s.name === "hero"),
      "the hero shot",
    );
    await render(<Provenance snapshot={hero} />);
    expect(text("measured-by")).toBe("PixelSlash server");
    expect(text("compare-time")).toMatch(/\d/);
  });
});

describe("the branch page's window", () => {
  test("states the builds, the wall time and the compare time with the n behind each, and draws no trend for one build", async () => {
    const { ctx } = await diffed();
    const metrics = branchMetrics(await branchWindow(ctx.db, ctx.projectId, "work"));
    await render(<BranchMetrics metrics={metrics} />);
    expect(text("branch-metrics-window")).toContain(
      "Over the branch's last 20 builds: 1 build here.",
    );
    expect(text("branch-metrics-wall")).toContain("(n = 1 finished build)");
    expect(text("branch-metrics-compare-time")).toContain("(n = 1 shot)");
    // One build is a value, not a trend.
    expect(screen.queryByTestId("branch-metrics-sparkline")).toBeNull();
    expect(screen.queryByTestId("branch-metrics-pair")).toBeNull();
  });
});
