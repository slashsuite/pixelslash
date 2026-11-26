import { eq } from "drizzle-orm";
import type { Db } from "#/db/db";
import type { Build } from "#/db/builds";
import { isMarker } from "#/db/markers";
import { snapshots } from "#/db/schema";
import type { ProjectOfBuild } from "./build-writes";

/**
 * The last check before a verdict (PS-282): a build never claims one on shots it did not measure
 * (invariant 1). A shot left with no result, a write lost to a run that raced this one, errors the
 * build so a re-run measures it. A branch shot whose baseline came from another environment was
 * compared with nothing, so a verdict on it would say "no visual changes" about pixels nobody
 * looked at, and the next build would take it as a baseline: it errors the build too, naming what
 * moved. The default branch is exempt, since its shots are accepted and become the new baseline.
 */

type Unmeasured = Pick<
  typeof snapshots.$inferSelect,
  "diffStatus" | "rebaselineNeeded" | "envFingerprint" | "baselineSnapshotId"
>;

const FIELDS = ["image", "browser", "fonts", "platform", "device", "scale"] as const;

/** Shots captured in another environment than their baselines: what the upload held, not a fault. */
export class UnmeasuredError extends Error {
  override name = "UnmeasuredError";
}

/**
 * Every failed shot was already reported on its own, or deliberately not (`DiffRefusedError`), so
 * this roll-up is a duplicate and `reportBuildFailure` skips it (PS-328).
 */
export class ShotsUnmeasuredError extends Error {
  override name = "ShotsUnmeasuredError";
}

function fieldsOf(fingerprint: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fingerprint);
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/** An environment in full, e.g. `image sha256:a, browser chromium 148, fonts sha256:f`. */
function environment(fingerprint: string): string {
  const fields = fieldsOf(fingerprint);
  const named = FIELDS.filter((field) => fields[field] !== undefined).map(
    (field) => `${field} ${fields[field]}`,
  );
  return named.length > 0 ? named.join(", ") : "no fingerprint";
}

async function fingerprintOf(db: Db, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [row] = await db
    .select({ envFingerprint: snapshots.envFingerprint })
    .from(snapshots)
    .where(eq(snapshots.id, id));
  return row?.envFingerprint ?? null;
}

/**
 * Why a branch build was refused (PS-590): both environments in full, so the two can be told apart
 * without the fields that moved being guessed at, and the way to keep them equal.
 */
async function uncomparedReason(db: Db, held: number, rebaselined: Unmeasured[]) {
  const [first] = rebaselined;
  const baseline = await fingerprintOf(db, first?.baselineSnapshotId ?? null);
  const both =
    first && baseline
      ? ` This build: ${environment(first.envFingerprint)}. Its baseline: ${environment(baseline)}.`
      : "";
  return (
    `${rebaselined.length} of ${held} shots were captured in another environment than their ` +
    `baselines, so they were not compared.${both} Upload from CI or the pinned capture image, so ` +
    `every build is captured in the same environment; to move the project to this environment, ` +
    `upload the default branch from it, then rebase this branch onto that commit and upload it again`
  );
}

/** Throws, naming why, when the build holds a shot a verdict would claim without measuring it. */
export async function assertMeasured(db: Db, build: Build, project: ProjectOfBuild): Promise<void> {
  const rows: Unmeasured[] = await db
    .select({
      diffStatus: snapshots.diffStatus,
      rebaselineNeeded: snapshots.rebaselineNeeded,
      envFingerprint: snapshots.envFingerprint,
      baselineSnapshotId: snapshots.baselineSnapshotId,
    })
    .from(snapshots)
    .where(eq(snapshots.buildId, build.id));
  const held = rows.filter((row) => !isMarker(row)).length;
  const none = rows.filter((row) => row.diffStatus === null && !row.rebaselineNeeded).length;
  if (none > 0) throw new Error(`${none} of ${held} shots have no result; re-run this build`);
  if (build.branch === project.defaultBranch) return;
  const rebaselined = rows.filter((row) => row.diffStatus === null && row.rebaselineNeeded);
  if (rebaselined.length > 0)
    throw new UnmeasuredError(await uncomparedReason(db, held, rebaselined));
}
