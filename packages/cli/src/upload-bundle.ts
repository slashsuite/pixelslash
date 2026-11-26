import { resolve } from "node:path";
import {
  type UploadDeps,
  UsageError,
  findConfigIfAny,
  loadRawConfig,
  uploadBundle,
} from "@slashsuite/pixelslash-engine";
import { prNumber, readFlagPairs } from "./args.ts";
import { enterStage, uploadProgress } from "./failure.ts";
import { connect } from "./remote.ts";
import type { Io } from "./run.ts";
import { follow, waitOptions } from "./status.ts";
import { readBrief } from "./upload-brief.ts";
import { UPLOAD_FLAGS, failedUpload, resolveTarget } from "./upload.ts";

/**
 * `pixelslash upload --bundle DIR`: send a static Storybook build, and the config it is rendered
 * by, for the server to render (`docs/storybook-bundle-render.md`). Nothing is captured here and
 * nothing is written into DIR (the next upload would pack it); `status` finds the build by its
 * commit, and `--wait` follows it as `upload DIR --wait` does.
 */
export async function uploadBundleRun(argv: string[], io: Io, deps: UploadDeps): Promise<number> {
  const [dir, ...rest] = argv;
  if (!dir || dir.startsWith("--")) throw new UsageError("--bundle needs a Storybook build DIR");
  const {
    timeout,
    interval,
    brief: briefFile,
    "brief-text": briefText,
    ...flags
  } = readFlagPairs(
    rest.filter((a) => a !== "--wait"),
    [...UPLOAD_FLAGS, "timeout", "interval", "brief", "brief-text"],
  );
  if (flags["flake-retries"] !== undefined)
    throw new UsageError(
      "--flake-retries does not go with --bundle: set flake.retries in the config",
    );
  const wait = waitOptions(rest.includes("--wait"), { timeout, interval });
  const cwd = deps.cwd ?? process.cwd();
  const brief = await readBrief(briefFile, briefText, cwd);
  const path = findConfigIfAny(flags.config, cwd);
  if (!path) throw new UsageError("--bundle needs a config with a storybook block (--config FILE)");
  const config = await loadRawConfig(path);
  const warn = (m: string) => io.stderr.write(`${m}\n`);
  const progress = uploadProgress();
  enterStage("upload");
  let id: string;
  try {
    const target = await resolveTarget(flags, deps, cwd);
    const result = await uploadBundle(
      {
        bundle: resolve(cwd, dir),
        config,
        server: target.server,
        token: target.token,
        projectId: target.projectId,
        subproject: target.subproject,
        brief,
        git: { cwd, baseBranch: target.baseBranch, branch: flags.branch, pr: prNumber(flags.pr) },
      },
      { ...deps, warn, progress },
    );
    const { commitSha, branch } = result.git;
    io.stdout.write(
      `pixelslash: sent a bundle of ${result.stories} stories (${result.files} files, ${result.bytes} bytes); the server renders it\n`,
    );
    io.stdout.write(`build: ${result.buildId} (${commitSha.slice(0, 7)} on ${branch})\n`);
    id = result.buildId;
  } catch (e) {
    throw failedUpload(e, progress);
  }
  if (!wait) return 0;
  const remote = await connect(flags, { ...deps, cwd });
  return follow({ remote, id, wait, json: false }, io, deps);
}
