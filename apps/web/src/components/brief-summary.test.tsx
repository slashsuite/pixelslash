// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest";
import { branchView } from "#/db/branch-view";
import { buildView } from "#/db/review";
import { context, sha, upload } from "#/diff/test-builds";
import { card, red, stubModel, white, withModel } from "#/ai/summary-test-kit";
import { render, screen } from "#/test/render";
import { BuildSummary } from "./build-summary";

// happy-dom's URL cannot find the engine's diff.wasm; the diff runs here (`#/test/diff-module`).
vi.mock("../../../../packages/engine/src/diff-module.bun.ts", () => import("#/test/diff-module"));
// The Regenerate button's server function loads the Worker's env and session: the render seam.
vi.mock("#/server/env", () => import("#/test/render").then((m) => m.serverEnv));
vi.mock("#/server/session", () => import("#/test/render").then((m) => m.serverSession));

/**
 * A build's brief (PS-232) in the build page's summary: the model's sentences, then its closing
 * read of whether the changes match the brief, and which model wrote it. The brief decides nothing:
 * the build waits on a person as it would without one. The summary is written by a stubbed model
 * after a real diff; the prompt and the answer's parsing are `ai/summary-brief.test.ts`.
 */

const BRIEF = "Nudge the **hero** text.\n<b>Not bold</b>";
const ANSWER = [
  "The hero's text edges moved by a sub-pixel. [C1]",
  "Brief: the hero changed as the brief says; nothing it describes is missing. [C1]",
].join("\n");

async function draw(
  build: Awaited<ReturnType<typeof upload>>,
  ctx: Awaited<ReturnType<typeof context>>,
) {
  const view = await buildView(ctx.db, ctx.projectId, build.id);
  await render(
    <BuildSummary
      projectId={ctx.projectId}
      build={view.build}
      snapshots={view.snapshots}
      modelConfigured
      pending={false}
    />,
  );
}

describe("a summary read against the brief", () => {
  test("states the model's sentence, then whether the changes match, and says it was read against the brief", async () => {
    const ctx = await context();
    await withModel(ctx);
    const stub = stubModel(() => ANSWER);
    await upload(ctx, { branch: "main", commit: sha(1), shots: card(white) });
    const build = await upload(
      ctx,
      {
        branch: "work",
        commit: sha(2),
        mergeBase: sha(1),
        ancestors: [sha(1)],
        shots: card(red),
        brief: BRIEF,
      },
      { modelFetch: stub.modelFetch },
    );
    // The brief decides nothing: the build waits on a person as it would without one.
    expect(build.status).toBe("changes");
    expect(build.brief).toBe(BRIEF);

    // The branch page draws the brief of the branch's newest build.
    expect((await branchView(ctx.db, ctx.projectId, "work"))?.build.brief).toBe(BRIEF);

    await draw(build, ctx);
    // The card's lines are plain text with no role of their own; their test ids name them.
    expect(screen.getByText(/The hero's text edges moved by a sub-pixel\./)).toBeTruthy();
    expect(screen.getByTestId("summary-match").textContent).toMatch(
      /^Against the brief: the hero changed as the brief says; nothing it describes is missing\./,
    );
    expect(screen.getByTestId("summary-model").textContent).toMatch(
      /local-qwen.* · read against the brief$/,
    );
  });

  test("a brief with nothing changed is no match: the page says there was nothing to read against it", async () => {
    const ctx = await context();
    await withModel(ctx);
    await upload(ctx, { branch: "main", commit: sha(1), shots: card(white) });
    const build = await upload(
      ctx,
      {
        branch: "same",
        commit: sha(3),
        mergeBase: sha(1),
        ancestors: [sha(1)],
        shots: card(white),
        brief: "Change nothing.",
      },
      { modelFetch: stubModel().modelFetch },
    );
    await draw(build, ctx);
    expect(screen.queryByTestId("summary-match")).toBeNull();
    expect(screen.getByTestId("summary-counts").textContent).toMatch(
      /^Nothing changed, so there is nothing to read against the brief\./,
    );
  });
});
