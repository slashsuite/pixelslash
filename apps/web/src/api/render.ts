import { and, eq } from "drizzle-orm";
import { BundleError, checkBundleStart } from "@slashsuite/pixelslash-engine/bundle-tar";
import { ABANDONED_AFTER_MS } from "#/db/abandoned";
import type { Actor } from "#/db/actor";
import type { Build } from "#/db/builds";
import type { Db } from "#/db/db";
import { builds } from "#/db/schema";
import { type CheckRunDeps, syncCheckRuns } from "#/github/check-run";
import { type BlobStore, orgBlobs } from "#/storage/blobs";
import { BadRequest, Unprocessable, bad } from "./errors";
import { jsonBody } from "./json-body";
import { authorize, bearer } from "./authorize";
import { isRenderToken, renderToken, renderTokenBuild } from "./render-token";
import { object } from "./validate";

/**
 * A Storybook bundle rendered on the server (`docs/storybook-bundle-render.md`). The CLI opens a
 * build with a render plan, sends the bundle to it and finalises with `{render: true}`; the server
 * hands the build to its renderer with a token for that one build, and the renderer fetches the
 * plan and the bundle, captures, and sends the shots through the same upload endpoints a client
 * capture uses. The build reads `uploading` until the renderer finalises it.
 */

/** Where finalise hands a bundle build: the renderer's job endpoint (`RENDER_URL`). */
export type RenderDispatch = {
  url: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
};

/** The largest bundle archive taken, gzipped. */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
/** The largest render plan taken, as JSON: the engine refuses a bigger one before it sends it. */
export const MAX_PLAN_BYTES = 64 * 1024;
/** The longest render error kept. */
const MAX_RENDER_ERROR = 4000;

type RenderCtx = {
  db: Db;
  store: BlobStore;
  request: Request;
  imageSecret: () => string;
  render?: RenderDispatch | undefined;
  checkRuns?: Omit<CheckRunDeps, "db"> | undefined;
};
type Owner = { orgId: string };

const json = (body: unknown, status = 200) => Response.json(body, { status });
const bundleKey = (buildId: string) => `builds/${buildId}/bundle.tar.gz`;

/**
 * The create-build body's `render`: absent for a client capture, else `{kind: "bundle", plan}`,
 * returned as the plan's JSON. The plan is the renderer's to check (`planConfig`), as it is the
 * renderer that runs it; here it is only bounded.
 */
export function parseRender(body: unknown): string | null {
  const render = object(body, "body").render;
  if (render === undefined || render === null) return null;
  const { kind, plan } = object(render, "render");
  if (kind !== "bundle") bad("render.kind", 'must be "bundle"');
  const { storybook } = object(plan, "render.plan");
  object(storybook, "render.plan.storybook");
  const text = JSON.stringify(plan);
  if (new TextEncoder().encode(text).length > MAX_PLAN_BYTES)
    throw new Unprocessable(`render.plan is over ${MAX_PLAN_BYTES} bytes`);
  return text;
}

/** Why a bundle build cannot be opened here, or null when it can. */
export function renderRefusal(ctx: RenderCtx, diffLocation: string): string | null {
  if (!ctx.render) return "this server does not render bundles; capture on the client";
  if (diffLocation !== "server")
    return "a bundle build needs a project that diffs on the server; this one diffs in CI";
  return null;
}

function bundleBuild(build: Build): string {
  if (build.renderPlan === null)
    throw new BadRequest("this build was not opened to render a bundle");
  return build.renderPlan;
}

function uploading(build: Build): void {
  if (build.status !== "uploading") throw new BadRequest(`build is ${build.status}, not uploading`);
}

/** `PUT /builds/:id/bundle`: the archive, checked from its first entry, stored with the build. */
export async function putBundle(ctx: RenderCtx, build: Build, { orgId }: Owner) {
  bundleBuild(build);
  uploading(build);
  const declared = Number(ctx.request.headers.get("content-length") ?? 0);
  if (declared > MAX_BUNDLE_BYTES)
    throw new Unprocessable(`bundle is over ${MAX_BUNDLE_BYTES} bytes`);
  const buf = await ctx.request.arrayBuffer();
  if (buf.byteLength > MAX_BUNDLE_BYTES)
    throw new Unprocessable(`bundle is over ${MAX_BUNDLE_BYTES} bytes`);
  let stories: number;
  try {
    ({ stories } = await checkBundleStart(new Uint8Array(buf)));
  } catch (e) {
    if (e instanceof BundleError) throw new BadRequest(`bundle: ${e.message}`);
    throw new BadRequest(
      `bundle: not a gzipped tar (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  await orgBlobs(ctx.store, orgId).put(bundleKey(build.id), buf, "application/gzip");
  return json({ id: build.id, stories, bytes: buf.byteLength });
}

/** `GET /builds/:id/bundle`: the archive, for the renderer. */
export async function getBundle(ctx: RenderCtx, build: Build, { orgId }: Owner) {
  bundleBuild(build);
  const body = await orgBlobs(ctx.store, orgId).get(bundleKey(build.id));
  if (!body) throw new BadRequest("the build has no bundle");
  return new Response(body, { headers: { "content-type": "application/gzip" } });
}

/** `GET /builds/:id/render`: the plan the renderer captures by. */
export function getRenderPlan(build: Build): Response {
  const plan: unknown = JSON.parse(bundleBuild(build));
  return json({ id: build.id, plan });
}

/**
 * Finalise with `{render: true}`: the build, which must hold its bundle, goes to the renderer with
 * a token for it. The reply says `uploading`; the renderer's own finalise moves it on.
 */
export async function dispatchRender(ctx: RenderCtx, build: Build, { orgId }: Owner) {
  bundleBuild(build);
  uploading(build);
  const held = await orgBlobs(ctx.store, orgId).get(bundleKey(build.id));
  if (!held) throw new BadRequest("send the bundle before finalising a bundle build");
  await held.cancel();
  if (!ctx.render) throw new BadRequest("this server does not render bundles");
  const token = await renderToken(ctx.imageSecret(), build.id);
  const send = ctx.render.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const res = await send(ctx.render.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ buildId: build.id, token }),
  }).catch((e: unknown) => new Response(String(e), { status: 599 }));
  if (!res.ok) return json({ error: `the renderer did not take the build (${res.status})` }, 502);
  return json({ id: build.id, status: "uploading" });
}

/** `POST /builds/:id/render-error`: the renderer ends the build `errored`, naming why. */
export async function renderError(ctx: RenderCtx, build: Build, { orgId }: Owner) {
  bundleBuild(build);
  const { error } = object(await jsonBody(ctx.request), "body");
  if (typeof error !== "string" || error.trim() === "") bad("error", "must be a message");
  const message = `render failed: ${error.trim()}`.slice(0, MAX_RENDER_ERROR);
  await ctx.db
    .update(builds)
    .set({ status: "errored", error: message })
    .where(and(eq(builds.id, build.id), eq(builds.status, "uploading")));
  await orgBlobs(ctx.store, orgId).delete(bundleKey(build.id));
  if (ctx.checkRuns) await syncCheckRuns({ db: ctx.db, ...ctx.checkRuns }, [build.id]);
  return json({ id: build.id, status: "errored" });
}

/** The bundle is the renderer's input only: once its shots are in, it goes. */
export async function dropBundle(ctx: RenderCtx, build: Build, { orgId }: Owner) {
  if (build.renderPlan !== null) await orgBlobs(ctx.store, orgId).delete(bundleKey(build.id));
}

/** What a render token may call, each on its own build only. */
const RENDER_PATHS = new Set([
  "POST /api/v1/builds/:id/baselines",
  "PUT /api/v1/builds/:id/snapshots",
  "POST /api/v1/builds/:id/snapshots/batch",
  "POST /api/v1/builds/:id/known",
  "POST /api/v1/builds/:id/finalize",
  "GET /api/v1/builds/:id/bundle",
  "GET /api/v1/builds/:id/render",
  "POST /api/v1/builds/:id/render-error",
]);

/** Paths only a render token calls. */
export const RENDERER_ONLY = new Set([
  "GET /api/v1/builds/:id/bundle",
  "GET /api/v1/builds/:id/render",
  "POST /api/v1/builds/:id/render-error",
]);

/**
 * Whether the request's token may call this endpoint: a render token only its `RENDER_PATHS` on its
 * own build, any other token everything but what only the renderer calls. A refusal is a 404, as
 * for any row the token cannot reach.
 */
export function reaches(
  endpoint: string,
  params: string[],
  rendering: string | undefined,
): boolean {
  if (rendering === undefined) return !RENDERER_ONLY.has(endpoint);
  return RENDER_PATHS.has(endpoint) && params[0] === rendering;
}

/** The request's actor: a render token's (`renderActor`) or, for any other, what `authorize` makes. */
export async function tokenActor(
  deps: { db: Db; imageSecret: () => string },
  request: Request,
): Promise<{ actor: Actor | null; rendering?: string }> {
  const token = bearer(request);
  if (token === null || !isRenderToken(token))
    return { actor: await authorize({ db: deps.db, request }) };
  const render = await renderActor(deps, token);
  return render ? { actor: render.actor, rendering: render.buildId } : { actor: null };
}

/**
 * The actor a render token acts as: its build's project, as a CI token would, while that build is
 * a bundle build still in its run (not past its verdict, not older than an abandoned build). The
 * route then keeps it to `RENDER_PATHS` on that one build.
 */
export async function renderActor(
  deps: { db: Db; imageSecret: () => string },
  token: string,
  now = Date.now(),
): Promise<{ actor: Actor; buildId: string } | null> {
  const buildId = await renderTokenBuild(deps.imageSecret(), token);
  if (!buildId) return null;
  const [row] = await deps.db
    .select({
      projectId: builds.projectId,
      status: builds.status,
      plan: builds.renderPlan,
      at: builds.createdAt,
    })
    .from(builds)
    .where(eq(builds.id, buildId));
  if (!row || row.plan === null || now - row.at.getTime() > ABANDONED_AFTER_MS) return null;
  if (!["uploading", "processing", "errored"].includes(row.status)) return null;
  return { actor: { kind: "ci", projectId: row.projectId }, buildId };
}
