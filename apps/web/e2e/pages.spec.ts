import type { Page } from "@playwright/test";
import { expect, expectHydrated, open, test } from "./fixtures";
import { SHA_MAIN, SHA_WORK, uploadBuild } from "./api-upload";
import { openRunCard } from "./build-workspace";
import { sql } from "./d1";
import { png } from "./png";

/**
 * The page loop, run by the `phone` project only (playwright.config.ts): every route of the app is
 * opened once at a phone's width, and none scrolls sideways. It is the one measurement the browser
 * layer keeps (docs/testing.md): what each page shows is proved lower, its look by the visual job.
 *
 * The seed is the case that widens a page: a tall shot with a thin change, a 1300 px shot, a shot
 * with a long name that a summary link must cut, and a branch build carried over from the one
 * before it, so the shot page shows its "Compared with" switch. The parity page is left out: it
 * needs the same key shot on web, Android and iOS, and no browser test opened it before this loop.
 */

const SHA_NEXT = "c".repeat(40);
const LONG = "a-very-long-component-name-for-one-shot-that-keeps-going-and-going-and-going";
// Nine, so the summary's first sentence has more links than it shows ("+1 more").
const TALL = [...Array.from({ length: 8 }, (_, i) => `page-${i + 1}`), LONG];
const shots = (tall: Buffer, wide: Buffer) => [
  ...TALL.map((name) => ({ name, png: tall })),
  { name: "hero", png: wide },
];
const MAIN = shots(png(400, 1600), png(1300, 500));
const WORK = shots(
  png(400, 1600, [{ x: 0, y: 800, w: 400, h: 6, rgb: [220, 30, 30] }]),
  png(1300, 500, [{ x: 100, y: 100, w: 400, h: 200, rgb: [220, 30, 30] }]),
);

/** How far the page reaches past the viewport's width: 0 or less when nothing scrolls sideways. */
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function fits(page: Page, what: string) {
  expect(await overflow(page), `${what} scrolls sideways`).toBeLessThanOrEqual(0);
}

test("every page fits a phone's width, with its folded parts opened", async ({
  page,
  provision,
}) => {
  const { orgId, token, projectId } = await provision({ org: "Pages Co", project: "pages" });
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, MAIN);
  const work = { branch: "work", mergeBaseSha: SHA_MAIN };
  await uploadBuild(token, { ...work, commitSha: SHA_WORK, ancestorShas: [SHA_MAIN] }, WORK);
  // The same pixels again, before anything was decided: every shot is carried.
  const buildId = await uploadBuild(
    token,
    { ...work, commitSha: SHA_NEXT, ancestorShas: [SHA_WORK, SHA_MAIN] },
    WORK,
  );
  const build = `/projects/${projectId}/builds/${buildId}`;

  await test.step("the build page, its summary and its run card opened", async () => {
    await open(page, build);
    const links = page.getByRole("link", { name: /hero/i });
    const ids = await page
      .getByTestId("snapshot-row")
      .getByRole("link")
      .evaluateAll((all) => all.map((a) => a.getAttribute("href")?.split("/").pop() ?? ""));
    expect(ids).toHaveLength(TALL.length + 1);
    const summary = {
      model: "e2e-model",
      at: Date.now(),
      sentences: [
        { text: "Every page moved a strip.", shots: ids },
        { text: "The first page is the clearest.", shots: ids.slice(0, 1) },
        { text: "The second matches it.", shots: ids.slice(1, 2) },
        { text: "The third matches it too.", shots: ids.slice(2, 3) },
      ],
    };
    sql(`UPDATE builds SET ai_summary = '${JSON.stringify(summary)}' WHERE id = '${buildId}'`);
    await open(page, build);
    await fits(page, "the build page");
    await page.getByRole("button", { name: /show all/i }).click();
    await page.getByRole("button", { name: /more$/ }).first().click();
    await openRunCard(page);
    await fits(page, "the build page opened out");
    await expect(links.first()).toBeVisible();
  });

  await test.step("the snapshot page in every mode and scale", async () => {
    await page.getByTestId("snapshot-row").filter({ hasText: /hero/i }).getByRole("link").click();
    await expect(page).toHaveURL(/\/snapshots\//);
    await expectHydrated(page);
    await expect(page.getByRole("radiogroup", { name: "Compared with" })).toBeVisible();
    await fits(page, "the snapshot page");
    for (const name of ["Overlay", "Slider", "Side by side", "1:1", "Zoom to change", "Fit"]) {
      await page.getByRole("radio", { name, exact: true }).click();
      await fits(page, `the snapshot page at ${name}`);
    }
  });

  const routes: [string, string][] = [
    ["the home page", "/"],
    ["the org's projects", `/orgs?org=${orgId}`],
    ["the org's members", `/orgs?org=${orgId}&tab=members`],
    ["the org's tokens", `/orgs?org=${orgId}&tab=tokens`],
    ["the org's model", `/orgs?org=${orgId}&tab=model`],
    ["the org's timings", `/orgs?org=${orgId}&tab=timings`],
    ["the project page", `/projects/${projectId}`],
    ["the project settings", `/projects/${projectId}/settings`],
    ["the project's flakes", `/projects/${projectId}/flakes`],
    ["the branch page", `/projects/${projectId}/branches/work`],
    ["the commit page", `/projects/${projectId}/commits/${SHA_NEXT}`],
    ["the user settings", "/settings"],
    ["the operator page", "/_admin"],
  ];
  for (const [what, path] of routes) {
    await test.step(what, async () => {
      const response = await open(page, path);
      expect(response?.status(), what).toBe(200);
      await fits(page, what);
    });
  }
});
