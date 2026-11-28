import { type Actor, actorBuild, actorProject } from "#/db/actor";
import {
  type BaselineSnapshot,
  type PickFor,
  type SnapshotKey,
  baselineFor,
  pickOptions,
  selectBaselines,
  snapshotKeyOf,
} from "#/db/baselines";
import type { Db } from "#/db/db";
import type { DiffLocation } from "#/db/schema";
import { BASELINE_URL_TTL_MS } from "#/storage/signed";
import { fingerprint } from "./validate-native";
import { API_VERSION, imageUrl } from "./read";
import { BadRequest, object, parseNewBuild, parseSnapshotKey } from "./validate";

/**
 * The baselines a build's shots are measured against (ob 1727), for a CLI that diffs in CI. The
 * pick is the server's own (`db/baselines.ts`), the one finalise runs; the CLI is told it and
 * never picks for itself. A shot is diffed under its own options as uploaded, so only the
 * baseline's side is here: its image, the fingerprint it was rendered under and its ignore areas.
 */

export type BaselinesCtx = {
  db: Db;
  actor: Actor;
  origin: string;
  imageSecret: () => string;
};

/** A build holds at most this many shots worth asking about in one request. */
const MAX_KEYS = 2000;

/** A key, and the environment its shot was captured in when the CLI says (any since PS-283). */
type AskedKey = SnapshotKey & { envFingerprint: string | null };

function keysOf(body: unknown): AskedKey[] {
  const keys = object(body, "body").keys;
  if (!Array.isArray(keys) || keys.length > MAX_KEYS)
    throw new BadRequest(`keys must be an array of at most ${MAX_KEYS} snapshot keys`);
  return keys.map((k: unknown, i) => {
    const at = `keys[${i}].`;
    const sent = object(k, at).fingerprint;
    return {
      ...parseSnapshotKey(k, at),
      // Stored as finalise stores it, so the two compare as strings.
      envFingerprint:
        sent === undefined ? null : JSON.stringify(fingerprint(object(sent, `${at}fingerprint`))),
    };
  });
}

async function shotOf(ctx: BaselinesCtx, orgId: string, shot: BaselineSnapshot | undefined) {
  if (!shot) return null;
  return {
    id: shot.id,
    // Fetched when the run reaches this shot, which can be long after this reply.
    image_url: await imageUrl(ctx, orgId, shot.imageKey, BASELINE_URL_TTL_MS),
    fingerprint: JSON.parse(shot.envFingerprint),
    ignore: shot.ignore,
    // The sha256 of the baseline's PNG, so a CLI holding the same bytes skips the download;
    // null for a shot stored before the server hashed uploads.
    sha256: shot.imageSha256,
  };
}

async function reply(
  ctx: BaselinesCtx,
  owner: { orgId: string; diffLocation: DiffLocation },
  build: PickFor,
  keys: AskedKey[],
): Promise<Response> {
  const picked = await selectBaselines(
    ctx.db,
    build,
    new Set(keys.map(snapshotKeyOf)),
    pickOptions(build, owner.diffLocation === "ci"),
  );
  const baselines = await Promise.all(
    keys.map(async ({ envFingerprint, ...key }) => {
      // The pick finalise makes for a shot from this environment (`measureFromCi`); a CLI that
      // does not say gets the plain pick.
      const b = envFingerprint
        ? baselineFor(picked, { ...key, envFingerprint })
        : picked.byKey.get(snapshotKeyOf(key));
      return {
        key,
        baseline: await shotOf(ctx, owner.orgId, b?.shot),
        // The id of the shot holding an undecided change: a shot identical to `baseline` carries
        // it, and one that differs is measured against `accepted` instead (ob 1712).
        carry: b?.carry ?? null,
        accepted: b?.carry ? await shotOf(ctx, owner.orgId, b.accepted) : null,
      };
    }),
  );
  // The baseline build's shots that no key asked about (ob 1732): what this build would remove.
  const removed = picked.removed.map(({ name, platform, browser, viewport, theme }) => ({
    name,
    platform,
    browser,
    viewport,
    theme,
  }));
  return Response.json({
    api_version: API_VERSION,
    diff_location: owner.diffLocation,
    baselines,
    removed,
  });
}

/** `POST /api/v1/builds/:id/baselines`: the pick for an open build, the same one its finalise makes. */
export async function buildBaselines(
  ctx: BaselinesCtx,
  buildId: string,
  body: unknown,
): Promise<Response> {
  const { build, ...owner } = await actorBuild(ctx.db, ctx.actor, buildId);
  return reply(ctx, owner, build, keysOf(body));
}

/**
 * `POST /api/v1/baselines`: the pick a build at this commit would get now, with nothing created
 * (for `check` and flaky-shot retries). A CI token asks for its project; a personal token names one.
 */
export async function previewBaselines(
  ctx: BaselinesCtx,
  projectId: string,
  body: unknown,
): Promise<Response> {
  const project = await actorProject(ctx.db, ctx.actor, projectId);
  const git = parseNewBuild(body);
  const build: PickFor = {
    // No build has this id, so every build of the project is a candidate.
    id: "",
    projectId: project.id,
    createdAt: new Date(),
    branch: git.branch,
    mergeBaseSha: git.mergeBaseSha,
    ancestorShas: git.ancestorShas,
  };
  return reply(ctx, project, build, keysOf(body));
}
