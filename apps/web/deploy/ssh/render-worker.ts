/**
 * The self-host's bundle renderer (`docs/storybook-bundle-render.md`, sections 3 and 4): a
 * loopback listener the review app hands each bundle build to (`RENDER_URL`), and a queue that
 * renders one build at a time with the engine's `renderBundle`, the same capture code a client
 * runs. It holds no secret: each job carries the build-scoped token the server minted for it, and
 * every request it makes goes to its own `RENDER_API`, never to an address a job names.
 *
 *   POST /jobs  { buildId, token }  -> 202, queued; 400 a malformed job; 503 the queue is full
 *   GET /health                     -> 200 { queued, rendering }
 *
 * `RENDER_HOST` (default 127.0.0.1) and `RENDER_PORT` (default 3100) are where it listens,
 * `RENDER_API` (default http://127.0.0.1:3000) the review app it speaks to, `RENDER_SCRATCH` the
 * directory each job's bundle and shots go in (default the temp dir), and `RENDER_CONCURRENCY` the
 * most shots a job takes at once. `pixelslash-render.service` runs it; `apps/web/README.md`, "Run
 * it on the Proxmox server", says how it is turned on.
 */
import {
  type RenderJob,
  type RenderOptions,
  type RenderOutcome,
  renderBundle,
} from "@slashsuite/pixelslash-engine";

/** More builds than this waiting is a renderer that has fallen behind: the next is refused. */
export const MAX_QUEUED = 50;

type Render = (job: RenderJob) => Promise<RenderOutcome>;
type Log = (line: string) => void;

const isJob = (v: unknown): v is RenderJob =>
  typeof v === "object" &&
  v !== null &&
  "buildId" in v &&
  "token" in v &&
  typeof v.buildId === "string" &&
  typeof v.token === "string" &&
  v.buildId.length > 0 &&
  v.token.length > 0;

/** The queue and its listener's handler; `render` is the engine's, or a test's. */
export function renderWorker(render: Render, log: Log) {
  const queue: RenderJob[] = [];
  let rendering: string | null = null;
  let idle: Promise<void> = Promise.resolve();

  async function drain(): Promise<void> {
    for (let job = queue.shift(); job; job = queue.shift()) {
      rendering = job.buildId;
      const started = Date.now();
      // A throw here is the renderer's own bug: renderBundle reports a render's failure itself.
      const outcome = await render(job).catch((e: unknown): RenderOutcome => ({
        ok: false,
        error: String(e),
      }));
      const took = `${((Date.now() - started) / 1000).toFixed(1)} s`;
      log(
        outcome.ok
          ? `render ${job.buildId}: ${outcome.snapshots} shots in ${took}`
          : `render ${job.buildId}: failed in ${took}: ${outcome.error.split("\n")[0] ?? ""}`,
      );
      rendering = null;
    }
  }

  async function take(request: Request): Promise<Response> {
    const job: unknown = await request.json().catch(() => null);
    if (!isJob(job))
      return Response.json({ error: "a job is { buildId, token }" }, { status: 400 });
    if (queue.length >= MAX_QUEUED)
      return Response.json({ error: "the render queue is full" }, { status: 503 });
    queue.push(job);
    if (rendering === null && queue.length === 1) idle = drain();
    return Response.json({ queued: queue.length }, { status: 202 });
  }

  async function handle(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/jobs") return take(request);
    if (request.method === "GET" && pathname === "/health")
      return Response.json({ queued: queue.length, rendering });
    return new Response(null, { status: 404 });
  }

  /** Resolves once every job taken so far has rendered. */
  const settled = () => idle;

  return { handle, settled };
}

const log: Log = (line) => process.stdout.write(`${line}\n`);
const warn = (line: string) => process.stderr.write(`${line}\n`);

const positive = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

if (import.meta.main) {
  const env = process.env;
  const opts: RenderOptions = {
    server: env["RENDER_API"] ?? "http://127.0.0.1:3000",
    scratch: env["RENDER_SCRATCH"],
    maxConcurrency: positive(env["RENDER_CONCURRENCY"]),
  };
  const worker = renderWorker((job) => renderBundle(job, opts, { warn }), log);
  const server = Bun.serve({
    hostname: env["RENDER_HOST"] ?? "127.0.0.1",
    port: positive(env["RENDER_PORT"]) ?? 3100,
    fetch: worker.handle,
  });
  log(`pixelslash-render on ${server.url.href}, rendering against ${opts.server}`);
}
