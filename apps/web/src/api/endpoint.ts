import { type Actor, actorBuild } from "#/db/actor";
import type { Build } from "#/db/builds";
import type { Db } from "#/db/db";
import type { ProcessDeps } from "#/diff/process";
import type { DiffLocation } from "#/db/schema";
import type { CheckRunDeps } from "#/github/check-run";
import type { RateLimiter } from "#/server/rate-limit";
import type { ServerTimer } from "#/server/server-timing";
import type { BlobStore } from "#/storage/blobs";
import type { RenderDispatch } from "./render";

/** What the API is handed: the shapes `handler.ts` and the endpoint modules share. */

export type ApiDeps = {
  db: Db;
  store: BlobStore;
  /** Signs the image URLs the read API returns; read only when one is. */
  imageSecret: () => string;
  /** The oldest CLI (`x.y.z`) this server takes; unset takes any. */
  minCliVersion?: string | undefined;
  /** The engine's diff for finalise; a test passes one that throws (ob 1727). */
  diff?: ProcessDeps["diff"];
  /** The self-host's pixel limit for finalise's diff, `DIFF_LIMIT_MPX`; unset admits every shot. */
  diffLimitMpx?: ProcessDeps["diffLimitMpx"];
  /** Where a finalised build's changed shots go to be explained (ob 1875). */
  explainQueue?: ProcessDeps["explainQueue"];
  /** `MODEL_KEY_SECRET`, which opens the project's stored model key (ob 1786). */
  modelKeySecret?: ProcessDeps["modelKeySecret"];
  /** Where a project made through the API diffs (ob 1787). */
  defaultDiffLocation: () => DiffLocation;
  /** The GitHub App and public URL a finalised build's commit status is synced with (PS-23); unset syncs none. */
  checkRuns?: Omit<CheckRunDeps, "db">;
  /** Counts requests per token, or per client IP when the token is refused (PS-250); unset counts none. */
  rateLimit?: RateLimiter | undefined;
  /** Where a bundle build is handed to be rendered (`RENDER_URL`); unset refuses bundle builds. */
  render?: RenderDispatch | undefined;
};

/** `rendering` is the build a render token names: the request is the renderer's. */
export type Ctx = ApiDeps & {
  actor: Actor;
  request: Request;
  timer: ServerTimer;
  rendering?: string;
};

/**
 * One endpoint. `upload` marks the endpoints from before the read API (ob 1729): their errors stay
 * `{error: "…"}`, which the shipped CLI reads, and their replies carry no `api_version`. Every
 * other endpoint answers errors as `{error: {code, message}}`.
 */
export type Endpoint = {
  method: "GET" | "POST" | "PUT";
  path: string;
  upload?: true;
  run: (ctx: Ctx, params: string[]) => Promise<Response>;
};

/** The org a build's blobs live in, and where its project diffs. */
export type BuildOwner = { orgId: string; diffLocation: DiffLocation };

export const json = (body: unknown, status = 200) => Response.json(body, { status });
export const fail = (status: number, error: string) => json({ error }, status);

export const at = (params: string[], i: number) => params[i] ?? "";

export async function withBuild(
  ctx: Ctx,
  buildId: string,
  run: (build: Build, owner: BuildOwner) => Promise<Response>,
): Promise<Response> {
  const { build, ...owner } = await ctx.timer.time("build", () =>
    actorBuild(ctx.db, ctx.actor, buildId),
  );
  return run(build, owner);
}

/** A route whose `:id` is a build the token reaches, run with the build and its owner. */
export const onBuild =
  (run: (ctx: Ctx, build: Build, owner: BuildOwner) => Promise<Response>): Endpoint["run"] =>
  (ctx, p) =>
    withBuild(ctx, at(p, 0), (build, owner) => run(ctx, build, owner));

/** The `:param` values when `path` fits the pattern, else null. */
export function match(pattern: string, path: string[]): string[] | null {
  const want = pattern.split("/").filter(Boolean);
  if (want.length !== path.length) return null;
  const params: string[] = [];
  for (const [i, part] of want.entries()) {
    const got = path[i] ?? "";
    if (part.startsWith(":")) {
      if (!got) return null;
      try {
        params.push(decodeURIComponent(got));
      } catch {
        return null;
      }
    } else if (part !== got) return null;
  }
  return params;
}
