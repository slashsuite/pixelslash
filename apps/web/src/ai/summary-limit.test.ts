import { expect, test } from "vitest";
import { getBuild } from "#/db/builds";
import { TEST_MODEL_KEY_SECRET as SECRET } from "#/test/store";
import { type Shot, context, rows } from "#/diff/test-builds";
import type { ModelFetch } from "./model";
import { red, stubModel, themedBuild, withModel } from "./summary-test-kit";
import { summarizeBuild } from "./summary";

/** The reasoning-model ceiling and the 10-change cap on a build's summary (ob 1833). */

const changedPages = (n: number): Shot[] =>
  Array.from({ length: n }, (_, i) => ({ name: `page-${i}`, png: red }));

/** `inner`, recording the body of every call it is given. */
function recordingBodies(inner: ModelFetch) {
  const bodies: string[] = [];
  const modelFetch: ModelFetch = async (url, init) => {
    bodies.push(typeof init.body === "string" ? init.body : "");
    return inner(url, init);
  };
  return { bodies, modelFetch };
}

test("both calls carry the reasoning-model ceiling (ob 1833)", async () => {
  const ctx = await context();
  await withModel(ctx);
  const { bodies, modelFetch } = recordingBodies(stubModel().modelFetch);
  await themedBuild(ctx, modelFetch);
  const region = bodies.filter((b) => b.includes("image_url"));
  const summary = bodies.filter((b) => !b.includes("image_url"));
  expect(region.length).toBeGreaterThan(0);
  expect(summary).toHaveLength(1);
  for (const body of [...region, ...summary])
    expect(JSON.parse(body)).toMatchObject({ max_tokens: 4000 });
});

test("a build of 9 changed shots is summarised: only changed shots count, not new or removed (ob 1833)", async () => {
  // 3 card themes + 6 pages = 9 changed shots.
  const nine = await context();
  await withModel(nine);
  const small = stubModel();
  const summarised = await themedBuild(nine, small.modelFetch, changedPages(6));
  expect((await rows(nine, summarised)).filter((r) => r.diffStatus === "changed")).toHaveLength(9);
  expect(small.summaries()).toHaveLength(1);
  expect(summarised.aiSummary).not.toBeNull();
});

test("a build of 10 changed shots asks no summary, stores none and still labels its regions (ob 1833)", async () => {
  // 3 card themes + 7 pages = 10 changed shots.
  const ten = await context();
  await withModel(ten);
  const big = stubModel();
  const build = await themedBuild(ten, big.modelFetch, changedPages(7));
  const changed = (await rows(ten, build)).filter((r) => r.diffStatus === "changed");
  expect(changed).toHaveLength(10);
  expect(big.summaries()).toHaveLength(0);
  expect(build.aiSummary).toBeNull();
  expect(changed.filter((r) => r.aiReview !== null)).not.toHaveLength(0);

  // Regenerate on it makes no call.
  const again = stubModel();
  expect(
    await summarizeBuild(
      { db: ten.db, modelFetch: again.modelFetch, modelKeySecret: SECRET },
      await getBuild(ten.db, ten.projectId, build.id),
    ),
  ).toBe(false);
  expect(again.summaries()).toHaveLength(0);
});
