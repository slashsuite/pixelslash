/**
 * The self-host's bundle renderer (`docs/storybook-bundle-render.md`, sections 3 and 4): a
 * loopback listener the review app hands each bundle build to (`RENDER_URL`), and a queue that
 * renders up to `RENDER_BUILDS` builds at once, in the order they came, with the engine's
 * `renderBundle`, the same capture code a client runs. It holds no secret: each job carries the build-scoped token the server minted for it, and
 * every request it makes goes to its own `RENDER_API`, never to an address a job names.
 *
 *   POST /jobs  { buildId, token }  -> 202, queued; 400 a malformed job; 415 not sent as JSON;
 *                                      503 the queue is full
 *   GET /health                     -> 200 { queued, rendering: [buildId, ...] }
 *
 * A restart loses no build. `RENDER_QUEUE` names a file (mode 600) that holds the queue and the
 * builds being rendered, written on every change; a new worker renders them again, in order. A stop
 * (SIGTERM) lets the builds being rendered finish, starts no other and keeps taking jobs into the
 * file, then exits, so a deploy's restart waits for the renders rather than dropping them. A build the
 * worker was killed under (a crash, the memory limit, a stop that ran out of time) is started again,
 * at most `MAX_STARTS` times in all; after that it is ended `errored`, naming why, since it may be
 * what kills the renderer.
 *
 * `RENDER_HOST` (default 127.0.0.1) and `RENDER_PORT` (default 3100) are where it listens,
 * `RENDER_API` (default http://127.0.0.1:3000) the review app it speaks to, `RENDER_SCRATCH` the
 * directory each job's bundle and shots go in (default the temp dir), `RENDER_BUILDS` how many builds
 * it renders at once (default 1), `RENDER_CONCURRENCY` how many shots a job takes at once (default
 * the CPUs the renderer has, at most ten; a plan may ask for fewer), and `RENDER_QUEUE` the queue's
 * file (unset: the queue is in memory only).
 * `pixelslash-render.service` runs it; `apps/web/README.md`, "Run it on the Proxmox server", says
 * how it is turned on.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  type RenderJob,
  type RenderOptions,
  type RenderOutcome,
  renderBundle,
  reportRenderError,
} from "@slashsuite/pixelslash-engine";

/** More builds than this waiting is a renderer that has fallen behind: the next is refused. */
export const MAX_QUEUED = 50;
/** How many times one build is started before a worker that keeps dying under it gives up on it. */
export const MAX_STARTS = 3;

type Render = (job: RenderJob) => Promise<RenderOutcome>;
type Log = (line: string) => void;

/** A job as the queue's file keeps it: how many times its render has been started. */
export type Kept = RenderJob & { starts: number };

/** Where the queue outlives the process: what `load` returns is what the last `save` wrote. */
export type QueueStore = { load(): Kept[]; save(jobs: Kept[]): void };

type WorkerOptions = {
  store?: QueueStore;
  /** How many builds render at once (default 1). */
  builds?: number;
  /** End a build `errored` with this render error, without rendering it; false: try at the next start. */
  giveUp?: (job: RenderJob, error: string) => Promise<boolean>;
};

const isJob = (v: unknown): v is RenderJob =>
  typeof v === "object" &&
  v !== null &&
  "buildId" in v &&
  "token" in v &&
  typeof v.buildId === "string" &&
  typeof v.token === "string" &&
  v.buildId.length > 0 &&
  v.token.length > 0;

const isKept = (v: unknown): v is Kept =>
  isJob(v) &&
  "starts" in v &&
  typeof v.starts === "number" &&
  Number.isInteger(v.starts) &&
  v.starts >= 0;

/** The queue in a file, replaced whole on each save; a file that cannot be read is an empty queue. */
export function fileStore(path: string, warn: Log): QueueStore {
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return [];
      }
      try {
        const jobs: unknown = JSON.parse(text);
        if (Array.isArray(jobs) && jobs.every(isKept)) return jobs;
      } catch {
        // Not JSON: reported below.
      }
      warn(
        `the render queue in ${path} is not one this worker wrote: starting with an empty queue`,
      );
      return [];
    },
    save(jobs) {
      // Written beside it and renamed over it, so a kill mid-write leaves the last whole queue.
      const next = `${path}.next`;
      try {
        writeFileSync(next, JSON.stringify(jobs), { mode: 0o600 });
        renameSync(next, path);
      } catch (e) {
        warn(`the render queue was not saved to ${path}: ${String(e)}`);
      }
    },
  };
}

const kept = ({ buildId, token, starts }: Kept): Kept => ({ buildId, token, starts });

/** The log line for one finished render. */
function rendered(job: RenderJob, outcome: RenderOutcome, started: number): string {
  const took = `${((Date.now() - started) / 1000).toFixed(1)} s`;
  return outcome.ok
    ? `render ${job.buildId}: ${outcome.snapshots} shots in ${took}`
    : `render ${job.buildId}: failed in ${took}: ${outcome.error.split("\n")[0] ?? ""}`;
}

/** Report each spent build's error, keeping it in `spent` (and so in the store) until the server has it. */
async function giveUpOn(
  spent: Kept[],
  giveUp: WorkerOptions["giveUp"],
  log: Log,
  save: () => void,
): Promise<void> {
  for (const job of spent.slice()) {
    const error = `the renderer stopped ${job.starts} times while rendering this build (a crash or its memory limit); send the build again`;
    log(`render ${job.buildId}: given up: ${error}`);
    if (!((await giveUp?.(job, error)) ?? true)) continue;
    spent.splice(spent.indexOf(job), 1);
    save();
  }
}

/**
 * Runs `run` on up to `limit` jobs at once. `fill` takes jobs from `next` while fewer than `limit`
 * run, and runs again as each one ends; `settled` resolves once none is running.
 */
function pool(limit: number, next: () => Kept | undefined, run: (job: Kept) => Promise<void>) {
  const live = new Set<Promise<void>>();
  const take = () => (live.size < limit ? next() : undefined);
  const fill = (): void => {
    for (let job = take(); job; job = take()) {
      const done: Promise<void> = run(job).then(() => {
        live.delete(done);
        fill();
      });
      live.add(done);
    }
  };
  const settled = async (): Promise<void> => {
    while (live.size > 0) await Promise.all(live);
  };
  return { fill, settled };
}

/** The queue and its listener's handler; `render` is the engine's, or a test's. */
export function renderWorker(
  render: Render,
  log: Log,
  { store, giveUp, builds = 1 }: WorkerOptions = {},
) {
  const queue: Kept[] = [];
  /** Builds given up on whose render error has not reached the server yet. */
  const spent: Kept[] = [];
  /** The builds being rendered, in the order they started. */
  const current: Kept[] = [];
  let stopping = false;
  let reported: Promise<void> = Promise.resolve();

  const save = () => store?.save([...current, ...queue, ...spent].map(kept));

  /**
   * The next build to start, if one may start now. A build started before (left by a worker that
   * was killed) renders alone: two builds at once both count a kill, and the one that did not cause
   * it must not run out of starts beside the one that did.
   */
  function next(): Kept | undefined {
    const head = queue[0];
    if (stopping || !head) return undefined;
    if (current.some((job) => job.starts > 1) || (head.starts > 0 && current.length > 0))
      return undefined;
    return queue.shift();
  }

  const { fill: kick, settled } = pool(builds, next, async (job) => {
    job.starts += 1;
    current.push(job);
    save();
    const started = Date.now();
    // A throw here is the renderer's own bug: renderBundle reports a render's failure itself.
    const outcome = await render(job).catch((e: unknown): RenderOutcome => ({
      ok: false,
      error: String(e),
    }));
    log(rendered(job, outcome, started));
    current.splice(current.indexOf(job), 1);
    save();
  });

  async function take(request: Request): Promise<Response> {
    // The bundle's own script runs on this loopback too. A page cannot send this content type to
    // another origin without a preflight, which this listener never answers, so it cannot queue jobs.
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
      return Response.json({ error: "a job is sent as application/json" }, { status: 415 });
    const job: unknown = await request.json().catch(() => null);
    if (!isJob(job))
      return Response.json({ error: "a job is { buildId, token }" }, { status: 400 });
    // A finalise the CLI retried after a lost reply hands the same build again: it is taken once.
    if ([...current, ...queue].some((q) => q.buildId === job.buildId))
      return Response.json({ queued: queue.length }, { status: 202 });
    if (queue.length >= MAX_QUEUED)
      return Response.json({ error: "the render queue is full" }, { status: 503 });
    queue.push({ buildId: job.buildId, token: job.token, starts: 0 });
    save();
    kick();
    return Response.json({ queued: queue.length }, { status: 202 });
  }

  /** The builds being rendered, in the order they started. */
  const rendering = () => current.map((job) => job.buildId);

  async function handle(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/jobs") return take(request);
    if (request.method === "GET" && pathname === "/health")
      return Response.json({ queued: queue.length, rendering: rendering() });
    return new Response(null, { status: 404 });
  }

  /**
   * Take up what the last worker left in the store: each build again, in order, except one already
   * started `MAX_STARTS` times, which is ended `errored` instead and kept in the store until the
   * server has that. Resolves once those are reported.
   */
  async function resume(): Promise<void> {
    const left = store?.load() ?? [];
    spent.push(...left.filter((job) => job.starts >= MAX_STARTS).map(kept));
    queue.push(...left.filter((job) => job.starts < MAX_STARTS).map(kept));
    if (left.length > 0)
      log(
        `resumed ${queue.length} build(s) left by the last worker: ${queue.map((j) => j.buildId).join(", ")}`,
      );
    save();
    kick();
    reported = giveUpOn(spent, giveUp, log, save);
    await reported;
  }

  /** Start no other build; resolves once those being rendered, and any give-up report, are done. */
  function stop(): Promise<void> {
    stopping = true;
    return Promise.all([settled(), reported]).then(() => {});
  }

  return { handle, settled, resume, stop, rendering, queued: () => queue.length };
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
    concurrency: positive(env["RENDER_CONCURRENCY"]),
  };
  const queueFile = env["RENDER_QUEUE"];
  const builds = positive(env["RENDER_BUILDS"]) ?? 1;
  const worker = renderWorker((job) => renderBundle(job, opts, { warn }), log, {
    builds,
    ...(queueFile ? { store: fileStore(queueFile, warn) } : {}),
    giveUp: (job, error) => reportRenderError(job, opts, error, { warn }),
  });
  // Before the listener opens: a job taken first would be saved over the queue the last worker left.
  void worker.resume();
  const server = Bun.serve({
    hostname: env["RENDER_HOST"] ?? "127.0.0.1",
    port: positive(env["RENDER_PORT"]) ?? 3100,
    fetch: worker.handle,
  });
  log(
    `pixelslash-render on ${server.url.href}, rendering against ${opts.server}, ${builds} build(s) at once`,
  );
  if (!queueFile) warn("RENDER_QUEUE is not set: a restart drops the builds queued here");
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    const rendering = worker.rendering();
    log(
      rendering.length > 0
        ? `stopping once ${rendering.length === 1 ? "build" : "builds"} ${rendering.join(", ")} ${rendering.length === 1 ? "is" : "are"} rendered; ${worker.queued()} queued for the next start`
        : `stopping; ${worker.queued()} queued for the next start`,
    );
    // It still takes jobs into the queue's file until it exits.
    void worker.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
