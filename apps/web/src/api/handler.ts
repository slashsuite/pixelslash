import { actorUser } from "#/db/actor";
import { buildProject, projectIdOf, skippedBuild } from "./build-target";
import { type Build, createBuild, finaliseBuild, putSnapshot } from "#/db/builds";
import { putHeldSnapshots } from "#/db/held-snapshots";
import { processBuild } from "#/diff/process";
import { syncCheckRuns } from "#/github/check-run";
import { overApiLimit, retryAfter } from "#/server/rate-limit";
import { ServerTimer, withServerTiming } from "#/server/server-timing";
import { type BlobStore, orgBlobs } from "#/storage/blobs";
import { endAbandoned } from "./abandoned";
import { bearer } from "./authorize";
import { snapshotForm } from "./snapshot-form";
import { parseBatch } from "./validate-batch";
import { createProjectByName } from "./project-create";
import { listFlakes, resolveProjectFlake } from "./flakes";
import { getParity } from "./parity";
import { listStale } from "./stale";
import { type BaselinesCtx, buildBaselines, previewBaselines } from "./baselines";
import {
  type ReadCtx,
  buildUrl,
  getBuild,
  getSnapshot,
  listBuilds,
  listDetectionFlags,
  listProjects,
  markDetectionFlagExported,
} from "./read";
import { putProjectTwin } from "./twins-link";
import { acceptBuild, reviewShot } from "./review";
import { jsonBody } from "./json-body";
import { BadRequest, object, parseFinalise, parseNewBuild } from "./validate";
import { knownImages } from "./known";
import { belowMinimum } from "./cli-version";
import { errorOf, failWith } from "./api-error";
import {
  dispatchRender,
  dropBundle,
  parseRender,
  reaches,
  renderRefusal,
  tokenActor,
} from "./render";
import { RENDER_ENDPOINTS } from "./render-endpoints";
import {
  type ApiDeps,
  type BuildOwner,
  type Ctx,
  type Endpoint,
  at,
  fail,
  json,
  match,
  onBuild,
  withBuild,
} from "./endpoint";

export type { ApiDeps } from "./endpoint";

/** `skipped: true`: the build stands for a run that captured nothing on purpose. */
function skippedOf(body: unknown): boolean {
  const skipped = object(body, "body").skipped;
  if (skipped !== undefined && typeof skipped !== "boolean")
    throw new BadRequest("skipped must be a boolean");
  return skipped === true;
}

/**
 * A CLI that diffs says so with `clientDiff: true`, and is told where its project diffs. One that
 * does not say so cannot send results, so a `ci` project refuses it before any shot is uploaded
 * (ob 1727).
 */
async function startBuild(ctx: Ctx): Promise<Response> {
  const body = await jsonBody(ctx.request);
  const input = parseNewBuild(body);
  const project = await buildProject(ctx.db, ctx.actor, body);
  if (skippedOf(body)) {
    const made = await skippedBuild(ctx.db, project.id, input);
    if (made.skipped && ctx.checkRuns)
      await syncCheckRuns({ db: ctx.db, ...ctx.checkRuns }, [made.id]);
    return json({ ...made, diffLocation: project.diffLocation }, made.skipped ? 201 : 200);
  }
  const renderPlan = parseRender(body);
  const refused = renderPlan === null ? null : renderRefusal(ctx, project.diffLocation);
  if (refused) return fail(409, refused);
  if (
    renderPlan === null &&
    project.diffLocation === "ci" &&
    object(body, "body").clientDiff !== true
  )
    return fail(426, "this project diffs in CI; upgrade the CLI");
  const id = await createBuild(ctx.db, project.id, { ...input, renderPlan });
  await endAbandoned(ctx, project.id);
  return json({ id, diffLocation: project.diffLocation }, 201);
}

async function addSnapshot(ctx: Ctx, build: Build, owner: BuildOwner): Promise<Response> {
  const sent = await ctx.timer.time("form", () => snapshotForm(ctx.request, owner));
  const blobs = orgBlobs(ctx.store, owner.orgId);
  return json(await putSnapshot({ db: ctx.db, blobs, timer: ctx.timer }, build, sent));
}

/** Shots whose PNGs the project holds, registered together (many in one request); see `putHeldSnapshots`. */
async function addHeldSnapshots(ctx: Ctx, build: Build): Promise<Response> {
  const sent = parseBatch(await jsonBody(ctx.request));
  return json(await putHeldSnapshots({ db: ctx.db, timer: ctx.timer }, build, sent));
}

async function closeBuild(ctx: Ctx, build: Build, owner: BuildOwner): Promise<Response> {
  const body = await jsonBody(ctx.request);
  // A bundle build's CLI finalises with `{render: true}`: the renderer sends the shots, then the count.
  if (!ctx.rendering && object(body, "body").render === true)
    return dispatchRender(ctx, build, owner);
  const { orgId } = owner;
  const { snapshots, timings } = parseFinalise(body);
  if (ctx.rendering) await dropBundle(ctx, build, owner);
  const done = await ctx.timer.time("finalise", () =>
    finaliseBuild(ctx.db, build, snapshots, timings),
  );
  // The diff runs here, in the request: inline for beta, no Queue (the map's server diff). One
  // whole-page change at 1280x4000 fits the 30 s CPU limit; several do not, and processBuild stops
  // before the limit and ends the build `errored` with a reason that names it, so the reply carries
  // `error`, and `unmeasured` counts the shots still to measure. A finalise sent again resumes: it keeps
  // what was measured and diffs the rest (ob 1645), which the CLI does by itself while `unmeasured` falls.
  // A kill by the runtime itself is not caught here; the build reads `processing` until it is older than
  // STALE_PROCESSING_MS, and a finalise sent again after that re-runs it (ob 1545). So does one sent
  // after `errored`.
  // The model's explanations are not in it: they are queued once the verdict is written (ob 1875).
  const blobs = orgBlobs(ctx.store, orgId);
  const { db, diff, diffLimitMpx, explainQueue, modelKeySecret } = ctx;
  // The commit status says `pending` while the diff runs, then the verdict (PS-23); neither call
  // can fail the finalise.
  const sync = () =>
    ctx.timer.time("sync", async () => {
      if (ctx.checkRuns) await syncCheckRuns({ db, ...ctx.checkRuns }, [done.id]);
    });
  await sync();
  const result = await processBuild(
    { db, blobs, diff, diffLimitMpx, explainQueue, modelKeySecret, timer: ctx.timer },
    done,
  );
  await sync();
  return json({
    id: done.id,
    status: result.status,
    error: result.error,
    unmeasured: result.unmeasured,
    // For a CLI to point at an errored build (PS-228); absent from a server from before it.
    web_url: buildUrl({ origin: new URL(ctx.request.url).origin }, done.projectId, done.id),
  });
}

/** Who the token is: a person's login, a CI token's project, or an org token's org. What the CLI and MCP check a token with. */
async function me(ctx: Ctx): Promise<Response> {
  if (ctx.actor.kind === "ci") return json({ kind: "ci", projectId: ctx.actor.projectId });
  if (ctx.actor.kind === "org-ci") return json({ kind: "org-ci", orgId: ctx.actor.orgId });
  return json({ kind: "user", user: await actorUser(ctx.db, ctx.actor.userId) });
}

const reads = (ctx: Ctx): ReadCtx & { store: BlobStore } => ({
  db: ctx.db,
  store: ctx.store,
  actor: ctx.actor,
  origin: new URL(ctx.request.url).origin,
  imageSecret: ctx.imageSecret,
  query: new URL(ctx.request.url).searchParams,
});

/** A route whose one `:id` goes to a read with the token's actor. */
const byId =
  (read: (ctx: ReturnType<typeof reads>, id: string) => Promise<Response>): Endpoint["run"] =>
  (ctx, p) =>
    read(reads(ctx), at(p, 0));

const picks = (ctx: Ctx): BaselinesCtx => ({
  db: ctx.db,
  actor: ctx.actor,
  origin: new URL(ctx.request.url).origin,
  imageSecret: ctx.imageSecret,
});

/** The read-only pick: a CI token's own project, or the one a personal token names. */
async function preview(ctx: Ctx): Promise<Response> {
  const body = await jsonBody(ctx.request);
  return previewBaselines(picks(ctx), projectIdOf(body, ctx.actor), body);
}

/** Every endpoint the API has. The API table in docs/cli.md is checked against this list. */
export const ENDPOINTS: readonly Endpoint[] = [
  { method: "GET", path: "/api/v1/me", upload: true, run: (ctx) => me(ctx) },
  { method: "POST", path: "/api/v1/builds", upload: true, run: (ctx) => startBuild(ctx) },
  { method: "PUT", path: "/api/v1/builds/:id/snapshots", upload: true, run: onBuild(addSnapshot) },
  {
    method: "POST",
    path: "/api/v1/builds/:id/snapshots/batch",
    upload: true,
    run: onBuild((ctx, build) => addHeldSnapshots(ctx, build)),
  },
  {
    method: "POST",
    path: "/api/v1/builds/:id/known",
    upload: true,
    run: (ctx, p) =>
      withBuild(ctx, at(p, 0), async (build) =>
        json(await knownImages(ctx.db, build.projectId, await jsonBody(ctx.request))),
      ),
  },
  { method: "POST", path: "/api/v1/builds/:id/finalize", upload: true, run: onBuild(closeBuild) },
  ...RENDER_ENDPOINTS,
  {
    method: "POST",
    path: "/api/v1/builds/:id/baselines",
    run: async (ctx, p) => buildBaselines(picks(ctx), at(p, 0), await jsonBody(ctx.request)),
  },
  { method: "POST", path: "/api/v1/baselines", run: (ctx) => preview(ctx) },
  { method: "GET", path: "/api/v1/projects", run: (ctx) => listProjects(reads(ctx)) },
  {
    method: "POST",
    path: "/api/v1/projects",
    run: async (ctx) =>
      createProjectByName(
        { ...reads(ctx), defaultDiffLocation: ctx.defaultDiffLocation },
        await jsonBody(ctx.request),
      ),
  },
  {
    method: "PUT",
    path: "/api/v1/projects/:id/twin",
    run: async (ctx, p) => putProjectTwin(reads(ctx), at(p, 0), await jsonBody(ctx.request)),
  },
  { method: "GET", path: "/api/v1/projects/:id/builds", run: byId(listBuilds) },
  { method: "GET", path: "/api/v1/projects/:id/detection-flags", run: byId(listDetectionFlags) },
  {
    method: "POST",
    path: "/api/v1/detection-flags/:id/exported",
    run: byId(markDetectionFlagExported),
  },
  { method: "GET", path: "/api/v1/projects/:id/flakes", run: byId(listFlakes) },
  { method: "GET", path: "/api/v1/projects/:id/stale", run: byId(listStale) },
  {
    method: "POST",
    path: "/api/v1/flakes/:id/resolve",
    run: async (ctx, p) => resolveProjectFlake(reads(ctx), at(p, 0), await jsonBody(ctx.request)),
  },
  { method: "GET", path: "/api/v1/builds/:id", run: byId(getBuild) },
  { method: "GET", path: "/api/v1/builds/:id/parity", run: byId(getParity) },
  { method: "GET", path: "/api/v1/snapshots/:id", run: byId(getSnapshot) },
  { method: "POST", path: "/api/v1/snapshots/:id/review", run: reviewShot },
  { method: "POST", path: "/api/v1/builds/:id/accept-all", run: acceptBuild },
];

type Hit = { endpoint: Endpoint; params: string[] };

/** Why a matched request is not run: no such path, a path without that method, or out of the token's reach. */
function miss(
  hit: Hit | undefined,
  pathFits: boolean,
  rendering: string | undefined,
): "absent" | "method" | "unreached" | null {
  if (!hit) return pathFits ? "method" : "absent";
  return reaches(`${hit.endpoint.method} ${hit.endpoint.path}`, hit.params, rendering)
    ? null
    : "unreached";
}

const missFailure = (missed: string | null) =>
  missed === "method"
    ? { status: 405, code: "method_not_allowed", message: "method not allowed" }
    : { status: 404, code: "not_found", message: "not found" };

/**
 * The API, `/api/v1/…`, as a plain Request → Response so tests and the Worker route share it.
 * `authorize` turns the token into an actor: a CI token reaches its one project, an org (`psorg_`)
 * token every project of its org, a personal (`psu_`) token every project of its user's orgs. A project, build or shot the actor cannot reach
 * is a 404, never a 403, and nothing an upload writes leaves that project's org. The endpoints and
 * their replies are in `ENDPOINTS` and the "API" section of docs/cli.md.
 */
export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
  const timer = new ServerTimer();
  return withServerTiming(await route(request, deps, timer), timer);
}

/** The endpoints whose path fits the request, the one whose method does too, and whether it is an upload's. */
function endpointOf(request: Request) {
  const path = new URL(request.url).pathname.split("/").filter(Boolean);
  const fits = ENDPOINTS.flatMap((e) => {
    const params = match(e.path, path);
    return params ? [{ endpoint: e, params }] : [];
  });
  const hit = fits.find(({ endpoint }) => endpoint.method === request.method);
  return { fits, hit, upload: (hit ?? fits[0])?.endpoint.upload === true };
}

/** The token's actor (and the build a render token names), and whether it is over the rate limit. */
async function authenticate(deps: ApiDeps, request: Request) {
  const who = await tokenActor(deps, request);
  return {
    ...who,
    limited: await overApiLimit(deps.rateLimit, request, who.actor && bearer(request)),
  };
}

async function route(request: Request, deps: ApiDeps, timer: ServerTimer): Promise<Response> {
  const { fits, hit, upload } = endpointOf(request);
  if (belowMinimum(request, deps.minCliVersion))
    return failWith(upload, {
      status: 426,
      code: "cli_outdated",
      message: `upgrade the CLI: this server needs pixelslash ${deps.minCliVersion} or newer`,
    });
  const { actor, rendering, limited } = await timer.time("auth", () => authenticate(deps, request));
  if (limited)
    return retryAfter(
      failWith(upload, {
        status: 429,
        code: "rate_limited",
        message: "too many requests: wait a minute and try again",
      }),
    );
  if (!actor)
    return failWith(upload, {
      status: 401,
      code: "unauthorized",
      message: "missing, wrong, expired or revoked token",
    });
  const missed = miss(hit, fits.length > 0, rendering);
  if (missed || !hit) return failWith(upload && missed !== "absent", missFailure(missed));
  try {
    const ctx: Ctx = { ...deps, actor, request, timer, ...(rendering ? { rendering } : {}) };
    return await hit.endpoint.run(ctx, hit.params);
  } catch (e) {
    return failWith(upload, errorOf(e));
  }
}
