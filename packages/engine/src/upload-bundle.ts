import { bundleSecrets, packBundle, readBundleIndex } from "./bundle-archive.ts";
import { renderPlan } from "./bundle-plan.ts";
import { UploadError, UsageError } from "./errors.ts";
import { type GitContext, gitContext } from "./git.ts";
import { isHttpUrl } from "./routes.ts";
import { type Client, isObj, send } from "./upload-client.ts";
import { type UploadDeps, type UploadOptions, openBuild } from "./upload.ts";

/** `upload --bundle`: a static Storybook build sent for the server to render, with the config it renders by. */
export type BundleUploadOptions = Omit<UploadOptions, "dir" | "flakeRetries" | "timings"> & {
  /** The directory `build-storybook` wrote: `index.json` and the bundle. */
  bundle: string;
  /** The config as written (`loadRawConfig`): the plan is read from it. */
  config: unknown;
};

export type BundleUploadResult = {
  buildId: string;
  git: GitContext;
  stories: number;
  files: number;
  /** The archive's size as sent, gzipped. */
  bytes: number;
};

function clientFor(opts: BundleUploadOptions, deps: BundleDeps, warn: Client["warn"]): Client {
  return {
    fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
    base: opts.server.replace(/\/+$/, ""),
    token: opts.token,
    warn,
    sleep: deps.sleep ?? ((ms) => Bun.sleep(ms)),
  };
}

/** Everything checked and packed before a request is made: the index, the plan, the archive. */
async function prepare(opts: BundleUploadOptions, warn: Client["warn"]) {
  await readBundleIndex(opts.bundle);
  const { plan, notes } = renderPlan(opts.config);
  for (const note of notes) warn(note);
  for (const found of await bundleSecrets(opts.bundle))
    warn(`warning: bundle: ${found}; the bundle is stored on the server, so check it`);
  return { plan, packed: await packBundle(opts.bundle) };
}

type BundleDeps = Omit<UploadDeps, "recapture" | "recaptureConcurrency" | "reused" | "describe">;

/**
 * Send a Storybook build for the server to render (`docs/storybook-bundle-render.md`): the index
 * is read and the plan checked before anything is sent, so a directory that is not a build, or a
 * config the renderer cannot run, fails here by name. Then a build is opened with the plan, the
 * archive is sent to it, and the finalise hands it to the renderer. No PNG is sent; the build
 * stays `uploading` while the server renders, and `--wait` follows it as it follows any build.
 */
export async function uploadBundle(
  opts: BundleUploadOptions,
  deps: BundleDeps = {},
): Promise<BundleUploadResult> {
  if (!isHttpUrl(opts.server))
    throw new UsageError(`server must be an http(s) URL: ${opts.server}`);
  const warn = deps.warn ?? (() => {});
  const { plan, packed } = await prepare(opts, warn);
  const client = clientFor(opts, deps, warn);
  const git = await gitContext({ ...opts.git, env: deps.env ?? process.env, warn });
  const { id } = await openBuild(client, git, opts, { render: { kind: "bundle", plan } });
  Object.assign(deps.progress ?? {}, { opened: true, buildId: id, total: packed.stories });
  await send(client, {
    step: "upload bundle",
    method: "PUT",
    path: `/api/v1/builds/${id}/bundle`,
    body: packed.gz,
    contentType: "application/gzip",
  });
  const done = await send(client, {
    step: "finalize",
    method: "POST",
    path: `/api/v1/builds/${id}/finalize`,
    body: JSON.stringify({ render: true }),
  });
  if (isObj(done) && done.status === "errored")
    throw new UploadError(
      `upload failed: build ${id} errored on the server: ${String(done.error)}`,
    );
  if (deps.progress) deps.progress.finalised = true;
  return {
    buildId: id,
    git,
    stories: packed.stories,
    files: packed.files,
    bytes: packed.gz.length,
  };
}
