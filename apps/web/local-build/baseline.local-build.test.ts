import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";
import { builds, snapshots } from "#/db/schema";
import { png } from "../e2e/png";
import { buildIdOf, cliUpload, db, removeTemps, seed, tempDir, withoutTiming } from "./harness";

/**
 * Which build a branch build is measured against, through the real CLI in a real git checkout:
 * the merge-base build on the default branch, after main moved too (PS-703, uislash #235), and the
 * refusal, in full, when the branch was captured in another environment (PS-590).
 */

afterAll(removeTemps);

const NARROW = png(40, 40, [{ x: 4, y: 4, w: 10, h: 10, rgb: [30, 30, 220] }]);
// Main's own change, as uislash's 982a166 widened a checkbox.
const WIDE = png(40, 40, [{ x: 4, y: 4, w: 22, h: 10, rgb: [30, 30, 220] }]);
const FINGERPRINT = { image: "version:local-build", browser: "chromium 1", fonts: "sha256:f" };

const GIT_ENV = {
  GIT_AUTHOR_NAME: "local-build",
  GIT_AUTHOR_EMAIL: "local-build@example.invalid",
  GIT_COMMITTER_NAME: "local-build",
  GIT_COMMITTER_EMAIL: "local-build@example.invalid",
};

/** A git checkout of its own, so the test sets the merge-base the CLI reads. */
function checkout() {
  const dir = tempDir("ps-local-build-git-");
  const git = (...args: string[]) => {
    const res = spawnSync("git", args, {
      cwd: dir,
      env: { ...process.env, ...GIT_ENV },
      encoding: "utf8",
    });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
    return res.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  return git;
}

/** A shot dir of one shot. */
function shots(image: Buffer, fingerprint = FINGERPRINT) {
  const dir = tempDir("ps-local-build-shots-");
  mkdirSync(join(dir, "forms"));
  writeFileSync(join(dir, "forms/desktop.png"), image);
  const entry = {
    name: "forms-checkbox-checked",
    path: "/",
    variant: {
      name: "desktop",
      browser: "chromium",
      viewport: { width: 40, height: 40 },
      theme: "light",
    },
    tags: [],
    file: "forms/desktop.png",
    fingerprint,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: 1, snapshots: [entry] }));
  return dir;
}

async function shotOf(buildId: string) {
  const [row] = await db()
    .select({
      imageKey: snapshots.imageKey,
      baselineKey: snapshots.baselineKey,
      diffStatus: snapshots.diffStatus,
      status: builds.status,
      error: builds.error,
    })
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .where(eq(snapshots.buildId, buildId));
  if (!row) throw new Error(`no shot in build ${buildId}`);
  return row;
}

describe("a branch build's baseline, through the CLI", () => {
  test("a branch rebased after main moved is measured against main's new build (uislash #235)", async () => {
    const { token } = await seed();
    const git = checkout();
    const upload = async (dir: string, branch: string) => {
      const res = cliUpload(dir, token, branch, git("rev-parse", "--show-toplevel"));
      expect({ code: res.code, stderr: withoutTiming(res.stderr) }).toEqual({
        code: 0,
        stderr: "",
      });
      return shotOf(buildIdOf(res.stdout));
    };

    git("commit", "-q", "--allow-empty", "-m", "a");
    await upload(shots(NARROW), "main");
    // The PR's first build, before main moved: nothing changed.
    git("checkout", "-q", "-b", "pr");
    git("commit", "-q", "--allow-empty", "-m", "pr");
    expect(await upload(shots(NARROW), "pr")).toMatchObject({ status: "passed" });
    // Main merges its own change, and its build is accepted.
    git("checkout", "-q", "main");
    git("commit", "-q", "--allow-empty", "-m", "widen the checkbox");
    const main = await upload(shots(WIDE), "main");
    expect(main.status).toBe("passed");
    // The PR rebased onto it shows main's change again only if it is measured against the wrong build.
    git("checkout", "-q", "pr");
    git("rebase", "-q", "main");
    expect(await upload(shots(WIDE), "pr")).toMatchObject({
      status: "passed",
      diffStatus: "unchanged",
      baselineKey: main.imageKey,
    });
  });

  test("a branch build from another environment fails the upload, naming both and the way out", async () => {
    const { token } = await seed();
    const git = checkout();
    const root = git("rev-parse", "--show-toplevel");
    git("commit", "-q", "--allow-empty", "-m", "a");
    expect(cliUpload(shots(NARROW), token, "main", root).code).toBe(0);
    git("checkout", "-q", "-b", "laptop");
    git("commit", "-q", "--allow-empty", "-m", "b");
    const refused = cliUpload(
      shots(NARROW, { ...FINGERPRINT, fonts: "sha256:laptop" }),
      token,
      "laptop",
      root,
    );
    expect(refused.code).toBe(1);
    const said = withoutTiming(refused.stderr);
    expect(said).toContain("UPLOAD FAILED:");
    expect(said).toContain(
      "This build: image version:local-build, browser chromium 1, fonts sha256:laptop. " +
        "Its baseline: image version:local-build, browser chromium 1, fonts sha256:f.",
    );
    expect(said).toContain("Upload from CI or the pinned capture image");
  });
});
