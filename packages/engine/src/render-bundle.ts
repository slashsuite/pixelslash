import { mkdtemp, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { unpackBundle } from "./bundle-archive.ts";
import { planConfig } from "./bundle-plan.ts";
import { captureInto } from "./capture-into.ts";
import { UploadError } from "./errors.ts";
import type { FetchLike } from "./figma.ts";
import { recapture } from "./recapture.ts";
import { serveBundle } from "./bundle-serve.ts";
import { type SnapshotDeps, openCaptureSession } from "./snapshot.ts";
import { buildTimings, captureFacts, loadNow } from "./timings.ts";
import { type Client, isObj, send, sendBytes } from "./upload-client.ts";
import { uploadIntoBuild } from "./upload.ts";

/** One render: the build the CLI opened, and the build-scoped token the server minted for it. */
export type RenderJob = { buildId: string; token: string };

export type RenderOptions = {
  /** The API the renderer speaks to: its own setting, never one a job names. */
  server: string;
  /** Where each job's bundle and shots go, one fresh directory per job, removed after. Default: the temp dir. */
  scratch?: string | undefined;
  /**
   * How many shots a job takes at once (`renderConcurrency`). Default: the CPUs the renderer has.
   */
  concurrency?: number | undefined;
};

export type RenderDeps = Pick<SnapshotDeps, "env" | "listFonts"> & {
  fetch?: FetchLike;
  warn?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

export type RenderOutcome = { ok: true; snapshots: number } | { ok: false; error: string };

/**
 * How many shots a render takes at once: the renderer's own count (`own`, default the CPUs it has),
 * or the plan's `concurrency` when that asks for fewer. Not the client's load-based default
 * (`defaultConcurrency`): a renderer in a container sees its host's load average, so on a busy
 * host that default is one shot at a time, whatever the container has to spare. A plan never takes
 * more than the renderer gives, since it was written for the uploader's machine, not this one.
 */
export function renderConcurrency(
  asked: number | undefined,
  own: number = availableParallelism(),
): number {
  return Math.max(1, Math.min(asked ?? own, own));
}

/** The longest error a render reports: the shots that failed are named, one a line. */
const MAX_ERROR = 4000;

/** A build id as the server makes them: no path a job could steer elsewhere. */
const BUILD_ID = /^[\w-]{1,64}$/;

/**
 * Render one bundle build (`docs/storybook-bundle-render.md`, section 4): fetch its plan and its
 * bundle, serve the bundle on loopback, capture it with the same code a client capture runs, and
 * send the shots into the build, which then diffs as any server build does. A failure is sent to
 * the build as its render error, so it ends `errored` naming why; the job's directory is removed
 * whatever happens. Every request goes to `opts.server` with the job's token, nowhere else.
 */
export async function renderBundle(
  job: RenderJob,
  opts: RenderOptions,
  deps: RenderDeps = {},
): Promise<RenderOutcome> {
  if (!BUILD_ID.test(job.buildId)) return { ok: false, error: "render: not a build id" };
  const client = clientFor(job, opts, deps);
  const work = await mkdtemp(join(opts.scratch ?? tmpdir(), "pixelslash-render-"));
  try {
    const snapshots = await renderInto(client, job, work, { opts, deps });
    return { ok: true, snapshots };
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR);
    await reportTo(client, job, error);
    return { ok: false, error };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * End a build `errored` with `error` as its render error, without rendering it: the renderer gives
 * up on a build it was stopped under too often. Resolves false only when the server could not be
 * reached, so the report is worth sending again; a report that does not get through is warned of.
 */
export async function reportRenderError(
  job: RenderJob,
  opts: RenderOptions,
  error: string,
  deps: RenderDeps = {},
): Promise<boolean> {
  // No server takes a malformed id: there is nothing to send again.
  if (!BUILD_ID.test(job.buildId)) return true;
  return reportTo(clientFor(job, opts, deps), job, error.slice(0, MAX_ERROR));
}

function clientFor(job: RenderJob, opts: RenderOptions, deps: RenderDeps): Client {
  return {
    fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
    base: opts.server.replace(/\/+$/, ""),
    token: job.token,
    warn: deps.warn ?? (() => {}),
    sleep: deps.sleep ?? ((ms) => Bun.sleep(ms)),
  };
}

/** Whether the server answered: a refusal (a 4xx) is an answer too, and sending it again changes nothing. */
async function reportTo(client: Client, job: RenderJob, error: string): Promise<boolean> {
  return send(client, {
    step: "render error",
    method: "POST",
    path: `/api/v1/builds/${job.buildId}/render-error`,
    body: JSON.stringify({ error }),
  }).then(
    () => true,
    (sent: unknown) => {
      client.warn(`render: ${job.buildId}: the error was not reported: ${String(sent)}`);
      return sent instanceof UploadError && sent.status !== undefined && sent.status < 500;
    },
  );
}

async function renderInto(
  client: Client,
  job: RenderJob,
  work: string,
  { opts, deps }: { opts: RenderOptions; deps: RenderDeps },
): Promise<number> {
  const { warn } = client;
  const path = `/api/v1/builds/${job.buildId}`;
  const started = performance.now();
  const loadStart = loadNow();
  const reply = await send(client, { step: "render plan", method: "GET", path: `${path}/render` });
  if (!isObj(reply) || !isObj(reply.plan)) throw new UploadError("render: the server sent no plan");
  const gz = await sendBytes(client, { step: "bundle", method: "GET", path: `${path}/bundle` });
  const site = join(work, "bundle");
  const out = join(work, "shots");
  await unpackBundle(new Uint8Array(gz), site);
  const served = serveBundle(site);
  try {
    const config = planConfig(reply.plan, served.url);
    const concurrency = renderConcurrency(config.concurrency, opts.concurrency);
    const session = await openCaptureSession(config, { ...deps, warn });
    try {
      const result = await captureInto(session, out, concurrency, { reuse: true, warn });
      const timings = buildTimings(
        started,
        result.shots,
        session.browserLaunchMs,
        captureFacts(result, loadStart),
      );
      const sent = await uploadIntoBuild(
        {
          dir: out,
          server: client.base,
          token: job.token,
          build: { id: job.buildId, diffLocation: "server" },
          flakeRetries: config.flake.retries,
          timings,
        },
        {
          fetch: client.fetch,
          warn,
          sleep: client.sleep,
          recapture: (e) => recapture(session, e),
          recaptureConcurrency: concurrency,
          reused: result.reused,
        },
      );
      return sent.snapshots;
    } finally {
      await session.close();
    }
  } finally {
    await served.stop();
  }
}
