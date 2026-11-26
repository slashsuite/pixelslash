/**
 * The retention sweep from the command line (PS-239), for a self-host: it reads the D1 and R2 state
 * Miniflare keeps on disk, prints what the sweep would delete and the bytes, and deletes only when
 * told to with `--apply`. A dry run is the default and changes nothing. A self-host fires no cron,
 * so this is its sweep.
 *
 *   bun deploy/retention.ts                              # list the orphaned images only
 *   bun deploy/retention.ts --days 30                    # and what a 30-day branch window would delete
 *   bun deploy/retention.ts --days 30 --main-days 365    # and the default branch's past a year
 *   bun deploy/retention.ts --days 30 --limit 100        # the oldest 100 builds only
 *   bun deploy/retention.ts --days 30 --apply            # delete it
 *
 * The listing has three parts, each on its own: main builds, branch builds and orphaned images.
 * `--days` defaults to `PIXELSLASH_RETENTION_DAYS` and `--main-days` to
 * `PIXELSLASH_RETENTION_MAIN_DAYS`; a window with neither stays off, so no build goes by accident.
 * The orphaned images (no shot names them, put over a day ago) are listed every run. `--persist-to` is the Miniflare state directory (`.../state/v3`), by default
 * `$PIXELSLASH_DATA_DIR/state/v3` (the Docker self-host) or `.wrangler/state/v3` (the LAN one). Stop
 * the server first when applying: a build uploaded while the sweep runs is its own risk, see
 * apps/web/README.md, "Retention". It needs the built Worker's `wrangler.json` for the database and
 * bucket names, the same as `serve.ts`.
 */
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/d1";
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { OrphanPlan } from "../src/db/orphans.ts";
import { sweepOrphans } from "../src/db/orphans.ts";
import type { PlannedBuild, RetentionPlan, WindowPlan } from "../src/db/retention.ts";
import { sweepRetention } from "../src/db/retention.ts";
import { formatBytes } from "../src/lib/format.ts";
import { orphanSummary, retentionDaysOf, sweepSummary } from "../src/lib/retention.ts";
import { orgSweepBlobs, r2SweepStore } from "../src/storage/blobs.ts";
import { readConfig } from "./ssh/serve.ts";

const WEB_ROOT = resolve(import.meta.dirname, "..");

export type Args = {
  days: number | undefined;
  mainDays: number | undefined;
  limit: number | undefined;
  apply: boolean;
  persistTo: string;
};

const USAGE =
  "usage: bun deploy/retention.ts [--days N] [--main-days N] [--limit N] [--persist-to DIR] [--dry-run | --apply]";

/** A flag's value as a whole number above 0, or the message for it. */
function count(flag: string, raw: string): number {
  const found = retentionDaysOf(raw);
  if (found === undefined) throw new Error(`${flag} must be a whole number above 0, got ${raw}`);
  return found;
}

const VALUE_FLAGS = new Set(["--days", "--main-days", "--limit", "--persist-to"]);

/** The flags as typed: the ones that take a value, and `--apply` / `--dry-run`. */
function readFlags(argv: string[]) {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const rest = [...argv];
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    if (arg === "--apply" || arg === "--dry-run") switches.add(arg);
    else if (VALUE_FLAGS.has(arg)) {
      const raw = rest.shift();
      if (raw === undefined) throw new Error(`${arg} needs a value\n${USAGE}`);
      values.set(arg, raw);
    } else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  return { values, switches };
}

/** The Miniflare state directory: the flag, else the Docker self-host's data dir, else the LAN one's. */
export function stateDir(flag: string | undefined, dataDir: string | undefined): string {
  if (flag) return resolve(flag);
  return dataDir ? join(dataDir, "state/v3") : join(WEB_ROOT, ".wrangler/state/v3");
}

/** The command line and environment as options; throws a message for anything it cannot take. */
export function parseArgs(argv: string[], env: Record<string, string | undefined>): Args {
  const { values, switches } = readFlags(argv);
  if (switches.has("--apply") && switches.has("--dry-run"))
    throw new Error("--apply and --dry-run contradict each other");
  const windowFrom = (flag: string, name: string) => {
    const typed = values.get(flag);
    return typed === undefined ? retentionDaysOf(env[name]) : count(flag, typed);
  };
  const typedLimit = values.get("--limit");
  return {
    days: windowFrom("--days", "PIXELSLASH_RETENTION_DAYS"),
    mainDays: windowFrom("--main-days", "PIXELSLASH_RETENTION_MAIN_DAYS"),
    limit: typedLimit === undefined ? undefined : count("--limit", typedLimit),
    apply: switches.has("--apply"),
    persistTo: stateDir(values.get("--persist-to"), env["PIXELSLASH_DATA_DIR"]),
  };
}

const buildLine = (build: PlannedBuild) => {
  const bytes = build.blobs.reduce((sum, blob) => sum + blob.size, 0);
  const day = build.createdAt.toISOString().slice(0, 10);
  return `  ${build.id}  ${day}  ${build.branch}  ${build.blobs.length} blobs  ${formatBytes(bytes)}`;
};

/** One window's part: its head line, then each build past it, oldest first. */
function windowPart(name: string, plan: WindowPlan | null, builds: PlannedBuild[]): string[] {
  const head = plan
    ? `${name} builds: ${builds.length} past ${plan.cutoff.toISOString()} (${plan.days} days)`
    : `${name} builds: window off`;
  return [head, ...builds.map(buildLine)];
}

/**
 * Three parts, each on its own: main builds, then branch builds (each oldest first, with its blobs
 * and bytes), then the orphaned images; what was kept is said under the part it was kept from.
 */
const NO_PLAN: RetentionPlan = {
  main: null,
  branch: null,
  expired: [],
  keptCurrent: [],
  keptReferenced: [],
};

/** `line` when `n` is above 0, else nothing. */
const when = (n: number, line: string) => (n ? [line] : []);

export function listing(given: RetentionPlan | null, orphans: OrphanPlan): string[] {
  const plan = given ?? NO_PLAN;
  const past = (window: string) => plan.expired.filter((b) => b.window === window);
  const current = plan.keptCurrent.length;
  const referenced = plan.keptReferenced.length;
  const lines = [
    ...windowPart("main", plan.main, past("main")),
    ...when(current, `  ${current} kept: the newest, or holding a current baseline`),
    ...windowPart("branch", plan.branch, past("branch")),
    ...when(referenced, `${referenced} past a window kept: a build that stays points at them`),
  ];
  const bytes = orphans.orphans.reduce((sum, o) => sum + o.size, 0);
  lines.push(`orphaned images: ${orphans.orphans.length}, ${formatBytes(bytes)}`);
  lines.push(...orphans.orphans.map((o) => `  ${o.orgId}  ${o.key}  ${formatBytes(o.size)}`));
  return lines;
}

/** Miniflare over the self-host's persisted state, with its D1 as `DB` and its R2 as `BLOBS`. */
export function openState(persistTo: string): Miniflare {
  const config = readConfig();
  return new Miniflare(
    convertV4MiniflareOptions({
      log: new Log(LogLevel.WARN),
      telemetry: { enabled: false },
      cf: false,
      resourcePersistencePath: persistTo,
      resourceTmpPath: join(persistTo, "../tmp"),
      workers: [
        {
          name: "pixelslash-retention",
          modules: true,
          script: "export default {}",
          compatibilityDate: config.compatibility_date,
          d1Databases: { DB: { id: config.d1_databases?.[0]?.["database_id"] ?? "" } },
          r2Buckets: { BLOBS: { id: config.r2_buckets?.[0]?.["bucket_name"] ?? "" } },
        },
      ],
    }),
  );
}

/** The build sweep, or null when both windows are off. */
function buildSweep(
  args: Args,
  db: Parameters<typeof sweepRetention>[0],
  storeFor: Parameters<typeof sweepRetention>[1],
  now: Date,
) {
  if (args.days === undefined && args.mainDays === undefined) return Promise.resolve(null);
  return sweepRetention(db, storeFor, {
    days: args.days,
    mainDays: args.mainDays,
    now,
    dryRun: !args.apply,
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  });
}

async function main(args: Args): Promise<void> {
  const mf = openState(args.persistTo);
  try {
    const store = r2SweepStore((await mf.getBindings<{ BLOBS: R2Bucket }>()).BLOBS);
    const db = drizzle(await mf.getD1Database("DB"));
    const storeFor = (orgId: string) => orgSweepBlobs(store, orgId);
    const now = new Date();
    const retention = await buildSweep(args, db, storeFor, now);
    const orphans = await sweepOrphans(db, storeFor, { now, dryRun: !args.apply });
    for (const line of listing(retention?.plan ?? null, orphans.plan))
      process.stdout.write(`${line}\n`);
    if (retention) process.stdout.write(`${sweepSummary(retention.plan, retention.result)}\n`);
    process.stdout.write(`${orphanSummary(orphans.plan, orphans.result)}\n`);
    const any = (retention?.plan.expired.length ?? 0) + orphans.plan.orphans.length;
    if (!args.apply && any) process.stdout.write("nothing deleted: pass --apply\n");
  } finally {
    await mf.dispose();
  }
}

if (import.meta.main) {
  try {
    await main(parseArgs(process.argv.slice(2), process.env));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
