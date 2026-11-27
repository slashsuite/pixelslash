// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AiSummarySentence } from "#/db/diff-json";
import { buildView } from "#/db/review";
import { context, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { render } from "#/test/render";
import { BuildSummary } from "./build-summary";

// happy-dom's URL cannot find the engine's diff.wasm; the diff runs here (`#/test/diff-module`).
vi.mock("../../../../packages/engine/src/diff-module.bun.ts", () => import("#/test/diff-module"));
// The Regenerate button's server function reads the Worker's env, which a test has none of.
vi.mock("#/server/model", () => ({ regenerateBuildSummary: vi.fn<() => Promise<never>>() }));

/**
 * The build page's AI summary is a lead, not the page (PS-419): three sentences and a button for
 * the rest, and eight shot links after a sentence and a button for the others. Drawn from a real
 * build of twelve changed shots, with a stored summary that names them. That a link's label stays
 * on one line, and how the lead looks, is the visual job's.
 */

const sentence = (text: string, shots: string[]): AiSummarySentence => ({ text, shots });

const NAMES = Array.from({ length: 12 }, (_, i) => `page-${String(i + 1).padStart(2, "0")}`);

async function lead() {
  const ctx = await context();
  const white = shot();
  const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
  await upload(ctx, {
    branch: "main",
    commit: sha(1),
    shots: NAMES.map((name) => ({ name, png: white })),
  });
  const build = await upload(ctx, {
    branch: "work",
    commit: sha(2),
    mergeBase: sha(1),
    ancestors: [sha(1)],
    shots: NAMES.map((name) => ({ name, png: red })),
  });
  const view = await buildView(ctx.db, ctx.projectId, build.id);
  const ids = view.snapshots.map((s) => s.id);
  const aiSummary = {
    model: "test-model",
    at: Date.now(),
    sentences: [
      sentence("Every page moved a thin strip down the middle.", ids),
      sentence("The first page is the clearest case.", ids.slice(0, 1)),
      sentence("The second page matches it.", ids.slice(1, 2)),
      sentence("The third page matches it too.", ids.slice(2, 3)),
      sentence("The fourth page is the same again.", ids.slice(3, 4)),
    ],
  };
  const { user } = await render(
    <BuildSummary
      projectId={ctx.projectId}
      build={{ ...view.build, aiSummary }}
      snapshots={view.snapshots}
      modelConfigured
      pending={false}
    />,
  );
  return user;
}

afterEach(cleanup);

const sentences = () => screen.getAllByTestId("summary-sentence");
const links = (el: HTMLElement) => within(el).queryAllByTestId("summary-shot-link");

describe("the AI summary's lead", () => {
  test("shows three sentences, and the rest on a click", async () => {
    const user = await lead();
    expect(sentences()).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Show all 5 sentences" }));
    expect(sentences()).toHaveLength(5);
    expect(screen.queryByRole("button", { name: /^Show all/ })).toBeNull();
  });

  test("shows eight links after a sentence, and the other four on a click", async () => {
    const user = await lead();
    const [first] = sentences();
    if (!first) throw new Error("no sentence");
    expect(links(first)).toHaveLength(8);
    await user.click(within(first).getByRole("button", { name: "+4 more" }));
    expect(links(first)).toHaveLength(12);
    expect(within(first).queryByRole("button", { name: /more$/ })).toBeNull();
  });
});
