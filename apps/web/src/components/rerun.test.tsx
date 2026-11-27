// @vitest-environment happy-dom
import { diffPngs } from "@slashsuite/pixelslash-engine/diff";
import { expect, test, vi } from "vitest";
import { getBuild } from "#/db/builds";
import { type Ctx, context, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { render, screen, signInTo, waitFor } from "#/test/render";
import { BuildError } from "./build-error";

/**
 * The build page's "Re-run errored shots" (ob 1738) with its server function running against a
 * seeded store: a build whose diff threw on one shot is errored, the button measures that shot
 * again, and the reloaded build has its verdict. Which shots a re-run measures is
 * `diff/process-rerun.test.ts`'s; this proves the control drives it and the page reloads.
 */

const held = vi.hoisted(() => ({ store: undefined as unknown }));

// happy-dom's URL cannot find the engine's diff.wasm; the diff runs here (`#/test/diff-module`).
vi.mock("../../../../packages/engine/src/diff-module.bun.ts", () => import("#/test/diff-module"));

vi.mock("#/server/env", async () => ({
  ...(await import("#/test/render")).serverEnv,
  blobStore: () => held.store,
  syncChecks: async () => {},
  diffLimitMpx: () => undefined,
  modelKeySecret: () => undefined,
  explainQueue: () => undefined,
}));
vi.mock("#/server/session", () => import("#/test/render").then((m) => m.serverSession));
vi.mock("#/server/rerun", async (actual) => {
  const fns = await actual<typeof import("#/server/rerun")>();
  const { bindServerFn } = await import("#/test/render");
  const { rerunFor } = await import("#/server/rerun-for");
  return { ...fns, rerunBuildShots: bindServerFn(fns.rerunInput, rerunFor) };
});

/** Main of two white shots, then a branch that changes one, its diff throwing on the first shot. */
async function erroredBuild(ctx: Ctx) {
  const white = shot();
  const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
  await upload(ctx, {
    branch: "main",
    commit: sha(1),
    shots: [
      { name: "hero", png: white },
      { name: "ticker", png: white },
    ],
  });
  let calls = 0;
  const diff: typeof diffPngs = (...args) => {
    if (++calls === 1) throw new Error("PNG does not decode");
    return diffPngs(...args);
  };
  return upload(
    ctx,
    {
      branch: "work",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [
        { name: "hero", png: red },
        { name: "ticker", png: white },
      ],
    },
    { diff },
  );
}

type Loaded = { projectId: string; buildId: string; status: string; error: string | null };

/** The route's loader: the build as the store has it now, so a reload reads the re-run's verdict. */
const loadBuild =
  (ctx: Ctx) =>
  async ({ params }: { params: Record<string, string | undefined> }): Promise<Loaded> => {
    const build = await getBuild(ctx.db, params["projectId"] ?? "", params["buildId"] ?? "");
    return {
      projectId: build.projectId,
      buildId: build.id,
      status: build.status,
      error: build.error,
    };
  };

/** The build page's status and its real error callout, which holds the Re-run button. */
function BuildStatus({ data }: { data: Loaded }) {
  return (
    <>
      <p data-testid="build-status">{data.status}</p>
      <BuildError
        project={{ id: data.projectId, diffLocation: "server" }}
        build={{ id: data.buildId, status: data.status, error: data.error }}
      />
    </>
  );
}

test("an errored build's shots are re-run from its page, and the build gets its verdict", async () => {
  const ctx = await signInTo(await context());
  held.store = ctx.deps.store;
  const errored = await erroredBuild(ctx);
  expect(errored.status).toBe("errored");

  const { user } = await render(
    {
      path: "/projects/$projectId/builds/$buildId",
      loader: loadBuild(ctx),
      component: BuildStatus,
    },
    { url: `/projects/${ctx.projectId}/builds/${errored.id}` },
  );
  expect(screen.getByTestId("build-status").textContent).toBe("errored");
  expect(screen.getByText(/could not be measured/)).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Re-run errored shots" }));
  await waitFor(() => expect(screen.getByTestId("build-status").textContent).toBe("changes"));
  expect(screen.queryByRole("button", { name: "Re-run errored shots" })).toBeNull();
  expect(screen.queryByText(/could not be measured/)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});
