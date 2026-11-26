import { describe, expect, test } from "vitest";
import { META, branch, ciProject, noDiff, run } from "./test-ci";
import { sha } from "./test-builds";
import { RED, shot } from "./test-shots";

/**
 * A project whose capture environment changed recovers on its next default-branch build, in CI as
 * on the server: once main is captured in the new environment, a branch build from it is measured
 * against that, not refused against the old environment's shot.
 */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const MOVED = { ...META.fingerprint, image: "sha256:new-image" };

describe("an environment change in a project that diffs in CI", () => {
  for (const where of ["ci", "server"] as const) {
    test(`main re-captured in the new environment is the next branch build's baseline (${where})`, async () => {
      const held = await ciProject();
      const token = where === "ci" ? held.acme.token : held.other.token;
      const deps = where === "ci" ? { ...held.deps, diff: noDiff } : held.deps;
      const go = (spec: Parameters<typeof run>[2]) => run(held, token, spec, deps);
      await go({ branch: "main", commit: sha(1), png: white });
      expect((await go(branch(2, white))).build?.status).toBe("passed");
      // The same pixels from the new image: the bytes, and so the hash, do not move.
      const recaptured = await go({
        branch: "main",
        commit: sha(5),
        png: white,
        fingerprint: MOVED,
      });
      expect(recaptured.build?.status).toBe("passed");
      const unchanged = await go({ ...branch(3, white), mergeBase: sha(5), fingerprint: MOVED });
      expect(unchanged.build).toMatchObject({ status: "passed", error: null });
      expect(unchanged.row).toMatchObject({
        diffStatus: "unchanged",
        baselineKey: recaptured.row.imageKey,
        rebaselineNeeded: false,
      });
      const changed = await go({ ...branch(4, red), mergeBase: sha(5), fingerprint: MOVED });
      // Against the branch's own previous shot, which matched main's re-captured one.
      expect(changed.build?.status).toBe("changes");
      expect(changed.row).toMatchObject({
        diffStatus: "changed",
        baselineKey: unchanged.row.imageKey,
      });
    });
  }
});
