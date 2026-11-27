// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest";
import { buildView } from "#/db/review";
import { context, sha, upload, type Shot } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { render, screen } from "#/test/render";
import { BuildSummary } from "./build-summary";

// happy-dom's URL cannot find the engine's diff.wasm; the diff runs here (`#/test/diff-module`).
vi.mock("../../../../packages/engine/src/diff-module.bun.ts", () => import("#/test/diff-module"));
// The Regenerate button's server function loads the Worker's env and session: the render seam.
vi.mock("#/server/env", () => import("#/test/render").then((m) => m.serverEnv));
vi.mock("#/server/session", () => import("#/test/render").then((m) => m.serverSession));

/**
 * The build page's AI summary card when the model wrote no sentence: past the limit it says why, and
 * with no model it says `skip: no judge` and offers nothing to regenerate. A summary is never
 * invented. The card is drawn from a real build, diffed by the server. Where the limit falls is
 * `tooManyChanges`'s table (`ai/summary-limit.test.ts`).
 */

const white = shot();
const changed = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });

/** Main and a branch of `count` shots of one name each, every branch shot changed. */
async function changedBuild(count: number, modelConfigured: boolean) {
  const ctx = await context();
  const names = Array.from({ length: count }, (_, i) => `page-${i}`);
  const spec = (png: Shot["png"]): Shot[] => names.map((name) => ({ name, png }));
  await upload(ctx, { branch: "main", commit: sha(1), shots: spec(white) });
  const build = await upload(ctx, {
    branch: "work",
    commit: sha(2),
    mergeBase: sha(1),
    ancestors: [sha(1)],
    shots: spec(changed),
  });
  const view = await buildView(ctx.db, ctx.projectId, build.id);
  await render(
    <BuildSummary
      projectId={ctx.projectId}
      build={view.build}
      snapshots={view.snapshots}
      modelConfigured={modelConfigured}
      pending={false}
    />,
  );
  return view.build.status;
}

const regenerate = () => screen.queryByRole("button", { name: "Regenerate" });

describe("a summary the model did not write", () => {
  test("a build with 10 changed shots gets no summary, says why, and offers no Regenerate", async () => {
    await changedBuild(10, true);
    expect(
      screen.getByText(
        "No AI summary: 10 changed shots (summaries are made for builds with fewer than 10).",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("skip: no judge.")).toBeNull();
    expect(screen.queryAllByTestId("summary-sentence")).toEqual([]);
    expect(regenerate()).toBeNull();
  });

  test("a build under the limit still gets a summary slot: 9 changed shots are not told 'no summary'", async () => {
    await changedBuild(9, true);
    expect(screen.queryByText(/^No AI summary/)).toBeNull();
    expect(regenerate()).toBeTruthy();
  });

  test("with no model a changed shot is plain pixels: the summary says skip, and offers nothing to regenerate", async () => {
    expect(await changedBuild(1, false)).toBe("changes");
    expect(screen.getByText("skip: no judge.")).toBeTruthy();
    expect(screen.queryAllByTestId("summary-sentence")).toEqual([]);
    expect(regenerate()).toBeNull();
  });
});
