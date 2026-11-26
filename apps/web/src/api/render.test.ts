import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { TAR_END, tarHeader, tarPadding } from "@slashsuite/pixelslash-engine/bundle-tar";
import { createProject } from "#/db/orgs";
import { errorRenderBuild } from "#/db/render-builds";
import { builds } from "#/db/schema";
import { issueCiToken } from "#/db/tokens";
import type { ApiDeps } from "./handler";
import { renderActor } from "./render";
import { renderToken } from "./render-token";
import { call, idOf, newBuild, setup, snapshotForm } from "./test-support";

const PLAN = { storybook: { include: ["ui-*"] }, viewports: [{ width: 1280, height: 720 }] };
const INDEX = { v: 5, entries: { "ui-card--default": { type: "story", id: "ui-card--default" } } };

/** A gzipped ustar of `files`, in order, as the CLI packs a bundle. */
async function gzTar(files: [string, string][]): Promise<Uint8Array<ArrayBuffer>> {
  const parts: BlobPart[] = [];
  for (const [path, text] of files) {
    const data = new TextEncoder().encode(text);
    parts.push(tarHeader(path, data.length), data, new Uint8Array(tarPadding(data.length)));
  }
  parts.push(TAR_END);
  const gz = new Blob(parts).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(gz).arrayBuffer());
}

const bundle = () =>
  gzTar([
    ["index.json", JSON.stringify(INDEX)],
    ["iframe.html", "<html></html>"],
  ]);

/** A server with a renderer whose job endpoint records what it is handed. */
async function renderingServer() {
  const held = await setup();
  const jobs: { buildId: string; token: string }[] = [];
  const deps: ApiDeps = {
    ...held.deps,
    render: {
      url: "http://renderer.test/jobs",
      fetch: async (_url, init) => {
        jobs.push(JSON.parse(typeof init.body === "string" ? init.body : "null"));
        return new Response(null, { status: 202 });
      },
    },
  };
  return { ...held, deps, jobs };
}

async function openBundleBuild(deps: ApiDeps, token: string) {
  const res = await call(
    deps,
    "POST /api/v1/builds",
    token,
    newBuild({ render: { kind: "bundle", plan: PLAN } }),
  );
  expect(res.status).toBe(201);
  return idOf(res);
}

const putBundle = async (deps: ApiDeps, id: string, token: string, gz: Uint8Array<ArrayBuffer>) =>
  call(deps, `PUT /api/v1/builds/${id}/bundle`, token, new Blob([gz]));

/** A bundle build sent and handed to the renderer: its id and the render token it was given. */
async function dispatched() {
  const server = await renderingServer();
  const { deps, acme, jobs } = server;
  const id = await openBundleBuild(deps, acme.token);
  expect((await putBundle(deps, id, acme.token, await bundle())).status).toBe(200);
  const fin = await call(
    deps,
    `POST /api/v1/builds/${id}/finalize`,
    acme.token,
    JSON.stringify({ render: true }),
  );
  expect(await fin.json()).toEqual({ id, status: "uploading" });
  const token = jobs[0]?.token ?? "";
  return { ...server, id, token };
}

const openBundle = (deps: ApiDeps, token: string) =>
  call(deps, "POST /api/v1/builds", token, newBuild({ render: { kind: "bundle", plan: PLAN } }));

describe("opening a bundle build", () => {
  test("is refused (409) by a server with no renderer, and on a project that diffs in CI", async () => {
    const plain = await setup();
    const none = await openBundle(plain.deps, plain.acme.token);
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({
      error: "this server does not render bundles; capture on the client",
    });
    const { db, deps, acme } = await renderingServer();
    const ci = await createProject(db, acme.user.id, acme.org.id, {
      name: "ci",
      diffLocation: "ci",
    });
    const { token } = await issueCiToken(db, acme.user.id, ci.id, "ci");
    const refused = await openBundle(deps, token);
    expect(refused.status).toBe(409);
    expect(await db.select().from(builds)).toHaveLength(0);
  });

  test("stores the plan; a malformed render or an oversize plan is refused", async () => {
    const { db, deps, acme } = await renderingServer();
    const id = await openBundleBuild(deps, acme.token);
    const [row] = await db.select().from(builds).where(eq(builds.id, id));
    expect(JSON.parse(row?.renderPlan ?? "null")).toEqual(PLAN);
    const open = (render: unknown) =>
      call(deps, "POST /api/v1/builds", acme.token, newBuild({ render }));
    expect((await open({ kind: "pages", plan: PLAN })).status).toBe(400);
    expect((await open({ kind: "bundle", plan: {} })).status).toBe(400);
    const big = { storybook: { include: ["x".repeat(70_000)] } };
    expect((await open({ kind: "bundle", plan: big })).status).toBe(422);
  });
});

describe("sending the bundle", () => {
  test("takes an archive that starts with its index and says how many stories it holds", async () => {
    const { deps, acme, blobs } = await renderingServer();
    const id = await openBundleBuild(deps, acme.token);
    const gz = await bundle();
    const res = await putBundle(deps, id, acme.token, gz);
    expect(await res.json()).toEqual({ id, stories: 1, bytes: gz.byteLength });
    expect([...blobs.data.keys()]).toEqual([`orgs/${acme.org.id}/builds/${id}/bundle.tar.gz`]);
  });

  test("refuses one without its index first, one that is not a gzipped tar, and one on a client build", async () => {
    const { deps, acme, blobs } = await renderingServer();
    const id = await openBundleBuild(deps, acme.token);
    const noIndex = await putBundle(deps, id, acme.token, await gzTar([["iframe.html", "x"]]));
    expect(noIndex.status).toBe(400);
    expect(await noIndex.json()).toMatchObject({ error: expect.stringMatching(/^bundle: /) });
    const junk = await putBundle(deps, id, acme.token, new Uint8Array([1, 2, 3]));
    expect(junk.status).toBe(400);
    const client = idOf(await call(deps, "POST /api/v1/builds", acme.token, newBuild()));
    expect((await putBundle(deps, await client, acme.token, await bundle())).status).toBe(400);
    expect(blobs.data.size).toBe(0);
  });

  test("a finalise for the renderer before the bundle is sent is refused, and nothing is dispatched", async () => {
    const { deps, acme, jobs } = await renderingServer();
    const id = await openBundleBuild(deps, acme.token);
    const fin = await call(
      deps,
      `POST /api/v1/builds/${id}/finalize`,
      acme.token,
      JSON.stringify({ render: true }),
    );
    expect(fin.status).toBe(400);
    expect(jobs).toEqual([]);
  });
});

describe("the render token", () => {
  test("is handed to the renderer for that build and reaches its plan and its bundle", async () => {
    const { deps, id, token } = await dispatched();
    expect(token).toBe(await renderToken("test-image-secret", id));
    const plan = await call(deps, `GET /api/v1/builds/${id}/render`, token);
    expect(await plan.json()).toEqual({ id, plan: PLAN });
    const gz = await call(deps, `GET /api/v1/builds/${id}/bundle`, token);
    expect(gz.headers.get("content-type")).toBe("application/gzip");
    expect(new Uint8Array(await gz.arrayBuffer())).toEqual(await bundle());
    // The upload asks its build's baselines first, as a client upload does.
    const picks = await call(
      deps,
      `POST /api/v1/builds/${id}/baselines`,
      token,
      JSON.stringify({ keys: [] }),
    );
    expect(await picks.json()).toMatchObject({ baselines: [] });
  });

  test("reaches only its own build's render paths; a CI token never reaches the renderer's", async () => {
    const { deps, acme, id, token } = await dispatched();
    const other = await openBundleBuild(deps, acme.token);
    expect((await call(deps, `GET /api/v1/builds/${other}/render`, token)).status).toBe(404);
    const picks = await call(
      deps,
      `POST /api/v1/builds/${other}/baselines`,
      token,
      JSON.stringify({ keys: [] }),
    );
    expect(picks.status).toBe(404);
    expect((await call(deps, `GET /api/v1/builds/${id}`, token)).status).toBe(404);
    expect((await call(deps, "GET /api/v1/projects", token)).status).toBe(404);
    expect((await call(deps, "POST /api/v1/builds", token, newBuild())).status).toBe(404);
    for (const path of [`GET /api/v1/builds/${id}/render`, `GET /api/v1/builds/${id}/bundle`])
      expect((await call(deps, path, acme.token)).status).toBe(404);
    const forged = `${token.slice(0, -2)}xx`;
    expect((await call(deps, `GET /api/v1/builds/${id}/render`, forged)).status).toBe(401);
  });

  test("stops working once the build is past its run, or older than an abandoned build", async () => {
    const { db, deps, id, token } = await dispatched();
    const later = Date.now() + 7 * 60 * 60 * 1000;
    expect(await renderActor(deps, token, later)).toBeNull();
    await db.update(builds).set({ status: "passed" }).where(eq(builds.id, id));
    expect((await call(deps, `GET /api/v1/builds/${id}/render`, token)).status).toBe(401);
  });

  test("the renderer's shots and finalise end the build as a client capture would, and drop the bundle", async () => {
    const { db, deps, blobs, id, token } = await dispatched();
    const put = await call(deps, `PUT /api/v1/builds/${id}/snapshots`, token, snapshotForm());
    expect(put.status).toBe(200);
    const fin = await call(
      deps,
      `POST /api/v1/builds/${id}/finalize`,
      token,
      JSON.stringify({ snapshots: 1 }),
    );
    expect(fin.status).toBe(200);
    const [row] = await db.select().from(builds).where(eq(builds.id, id));
    expect(row?.status).not.toBe("uploading");
    expect([...blobs.data.keys()].some((k) => k.endsWith("bundle.tar.gz"))).toBe(false);
  });

  test("a render error ends the build errored, naming why, and drops the bundle", async () => {
    const { db, deps, blobs, id, token } = await dispatched();
    const res = await call(
      deps,
      `POST /api/v1/builds/${id}/render-error`,
      token,
      JSON.stringify({ error: "story ui-card--default never settled" }),
    );
    expect(await res.json()).toEqual({ id, status: "errored" });
    const [row] = await db.select().from(builds).where(eq(builds.id, id));
    expect(row?.status).toBe("errored");
    expect(row?.error).toBe("render failed: story ui-card--default never settled");
    expect(blobs.data.size).toBe(0);
  });

  test("a render error that loses the race to the finalise changes nothing", async () => {
    const { db, id } = await dispatched();
    await db.update(builds).set({ status: "passed" }).where(eq(builds.id, id));
    expect(await errorRenderBuild(db, id, "render failed: late")).toBe(false);
    const [row] = await db.select().from(builds).where(eq(builds.id, id));
    expect(row).toMatchObject({ status: "passed", error: null });
  });
});

describe("a renderer that does not take the build", () => {
  test("answers the CLI's finalise 502 and leaves the build uploading", async () => {
    const { db, deps, acme } = await renderingServer();
    const down: ApiDeps = {
      ...deps,
      render: {
        url: "http://renderer.test/jobs",
        fetch: async () => new Response(null, { status: 503 }),
      },
    };
    const id = await openBundleBuild(down, acme.token);
    await putBundle(down, id, acme.token, await bundle());
    const fin = await call(
      down,
      `POST /api/v1/builds/${id}/finalize`,
      acme.token,
      JSON.stringify({ render: true }),
    );
    expect(fin.status).toBe(502);
    const [row] = await db.select().from(builds).where(eq(builds.id, id));
    expect(row?.status).toBe("uploading");
  });
});
