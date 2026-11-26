import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { type Ctx, context, sha, upload } from "#/diff/test-builds";
import { shot } from "#/diff/test-shots";
import { builds } from "./schema";
import { recomputeVerdicts } from "./verdict";

/**
 * Stored verdicts written under an older rule are brought up to today's (PS-430): before PS-284 a
 * new shot did not wait, so a build with one still undecided could be stored `passed`.
 */

const white = shot();

async function statusOf(ctx: Ctx, id: string) {
  const [row] = await ctx.db
    .select({ status: builds.status })
    .from(builds)
    .where(eq(builds.id, id));
  return row?.status;
}

async function setStatus(ctx: Ctx, id: string, status: "passed" | "errored") {
  await ctx.db.update(builds).set({ status }).where(eq(builds.id, id));
}

/** Main, then a branch build with a new shot nobody has decided, stored as the old rule left it. */
async function passedUnderOldRule() {
  const ctx = await context();
  const main = await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
  const branch = await upload(ctx, {
    branch: "feat",
    commit: sha(2),
    mergeBase: sha(1),
    shots: [{ png: white }, { png: white, name: "added" }],
  });
  expect(branch.status).toBe("changes");
  await setStatus(ctx, branch.id, "passed");
  return { ctx, main, branch };
}

describe("recomputing stored verdicts", () => {
  test("a dry run lists the build that waits on a new shot and writes nothing", async () => {
    const { ctx, branch } = await passedUnderOldRule();
    expect(await recomputeVerdicts(ctx.db, { apply: false })).toEqual([
      { buildId: branch.id, from: "passed", to: "changes" },
    ]);
    expect(await statusOf(ctx, branch.id)).toBe("passed");
  });

  test("applied, it moves the build to changes, and a second run changes nothing", async () => {
    const { ctx, main, branch } = await passedUnderOldRule();
    await recomputeVerdicts(ctx.db, { apply: true });
    expect(await statusOf(ctx, branch.id)).toBe("changes");
    expect(await statusOf(ctx, main.id)).toBe("passed");
    expect(await recomputeVerdicts(ctx.db, { apply: true })).toEqual([]);
    expect(await recomputeVerdicts(ctx.db, { apply: false })).toEqual([]);
  });

  test("an errored build is a run's and is left alone", async () => {
    const { ctx, branch } = await passedUnderOldRule();
    await setStatus(ctx, branch.id, "errored");
    expect(await recomputeVerdicts(ctx.db, { apply: true })).toEqual([]);
    expect(await statusOf(ctx, branch.id)).toBe("errored");
  });
});
