/**
 * Recompute every finished build's stored verdict under today's rule (PS-430), for a self-host: it
 * reads the D1 state Miniflare keeps on disk, lists each build whose stored verdict differs (id, from,
 * to), and writes only when told to with `--apply`. A dry run is the default. Running it twice
 * changes nothing the second time. `--persist-to` is as in `retention.ts`.
 *
 *   bun deploy/recompute-verdicts.ts             # list what would change
 *   bun deploy/recompute-verdicts.ts --apply     # write it
 */
import { drizzle } from "drizzle-orm/d1";
import { recomputeVerdicts } from "../src/db/verdict.ts";
import { openState, stateDir } from "./retention.ts";

export type Args = { apply: boolean; persistTo: string };

const USAGE = "usage: bun deploy/recompute-verdicts.ts [--persist-to DIR] [--dry-run | --apply]";

/** The command line and environment as options; throws a message for anything it cannot take. */
export function parseArgs(argv: string[], env: Record<string, string | undefined>): Args {
  let apply = false;
  let dryRun = false;
  let persistTo: string | undefined;
  const rest = [...argv];
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--persist-to") {
      persistTo = rest.shift();
      if (persistTo === undefined) throw new Error(`--persist-to needs a value\n${USAGE}`);
    } else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  if (apply && dryRun) throw new Error("--apply and --dry-run contradict each other");
  return { apply, persistTo: stateDir(persistTo, env["PIXELSLASH_DATA_DIR"]) };
}

async function main(args: Args): Promise<void> {
  const mf = openState(args.persistTo);
  try {
    const stale = await recomputeVerdicts(drizzle(await mf.getD1Database("DB")), args);
    for (const { buildId, from, to } of stale)
      process.stdout.write(`${buildId}  ${from} -> ${to}\n`);
    const verb = args.apply ? "recomputed" : "would recompute";
    process.stdout.write(`${verb} ${stale.length} build verdicts\n`);
    if (!args.apply && stale.length) process.stdout.write("nothing written: pass --apply\n");
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
