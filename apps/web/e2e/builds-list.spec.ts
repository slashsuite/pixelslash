import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Provision, expect, open, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, uploadBuild } from "./api-upload";
import { sql } from "./d1";

/**
 * The project's builds list (PS-420): on a phone every field of a build is on the card, and a
 * build stored as `passed` that still has shots to review does not read "passed" beside them.
 */

const WEB = fileURLToPath(new URL("..", import.meta.url));
/** Screens kept outside the wiped e2e state, for the PR. */
const SHOTS = process.env["PS_SHOT_DIR"] ?? join(WEB, ".wrangler/e2e/shots");

async function capture(page: Page, name: string) {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

async function seed(provision: Provision) {
  const { token, projectId } = await provision({ org: "List Co", project: "list" });
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [
    { name: "hero", png: WHITE },
    { name: "ticker", png: WHITE },
    { name: "footer", png: WHITE },
  ]);
  const staleId = await uploadBuild(
    token,
    {
      branch: "feature/a-long-branch-name",
      commitSha: SHA_WORK,
      mergeBaseSha: SHA_MAIN,
      ancestorShas: [SHA_MAIN],
      prNumber: 12,
    },
    [
      { name: "hero", png: CHANGED },
      { name: "ticker", png: CHANGED },
      { name: "footer", png: WHITE },
      { name: "banner", png: CHANGED },
    ],
  );
  // The shape of a build written under an older verdict rule: work to review, status `passed`.
  sql(`UPDATE builds SET status = 'passed' WHERE id = '${staleId}'`);
  return { projectId, token };
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("every field of a build is on its card, inside the viewport", async ({
    page,
    provision,
  }) => {
    const { projectId } = await seed(provision);
    await open(page, `/projects/${projectId}`);

    const card = page.getByTestId("build-card").first();
    await expect(card).toBeVisible();
    const inView = async (testId: string) => {
      const box = await card.getByTestId(testId).boundingBox();
      expect(box, testId).not.toBeNull();
      expect(box?.x ?? -1, testId).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 999), testId).toBeLessThanOrEqual(390);
    };
    for (const testId of ["build-status", "snapshot-mix", "to-review", "rel-time"]) {
      await expect(card.getByTestId(testId)).toBeVisible();
      await inView(testId);
    }
    await expect(card.getByTestId("build-status")).toHaveText("changes");
    await expect(card).not.toContainText("passed");
    await expect(card).toContainText("feature/a-long-branch-name");
    await expect(card).toContainText("PR #12");

    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.inner);

    // The table is not drawn at this width, so the phone is not looking at a cut copy of it.
    await expect(page.getByTestId("build-row").first()).toBeHidden();

    // The bar's legend, the sha and PR captions and the links are all body size or larger.
    const textSizes = await card.evaluate((root) => {
      const found = new Set<number>();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.trim() && node.parentElement)
          found.add(parseFloat(getComputedStyle(node.parentElement).fontSize));
      }
      return [...found];
    });
    for (const size of textSizes) expect(size).toBeGreaterThanOrEqual(12);

    await capture(page, "list-phone");
  });
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`on a desktop, ${scheme}`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 800 } });

    test("a build with work to review does not read passed", async ({ page, provision }) => {
      const { projectId } = await seed(provision);
      await open(page, `/projects/${projectId}`);

      const row = page.getByTestId("build-row").first();
      await expect(row.getByTestId("to-review")).toHaveText(/^[1-9]\d* to review$/);
      await expect(row.getByTestId("build-status")).toHaveText("changes");
      await expect(row).not.toContainText("passed");
      await expect(page.getByTestId("build-card").first()).toBeHidden();

      await capture(page, `list-${scheme}`);
    });
  });
}

/**
 * A busy project's main builds pass one after another with nothing to review. Each run of them
 * keeps its newest build in the list and folds the rest behind a line that says how many; a build
 * with work to review is never folded, and the line opens the run in place.
 */
test("a run of auto-accepted main builds folds behind one line", async ({ page, provision }) => {
  const { projectId, token } = await seed(provision);
  const shots = [
    { name: "hero", png: WHITE },
    { name: "ticker", png: WHITE },
    { name: "footer", png: WHITE },
  ];
  // Three more main builds, newest last, each the same as main's accepted shots.
  for (const sha of ["c", "d", "e"])
    await uploadBuild(token, { branch: "main", commitSha: sha.repeat(40) }, shots);

  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, `/projects/${projectId}`);
  // Newest first: main e, the fold (d, c), the feature build, then main a, alone past the feature.
  const rows = page.getByTestId("build-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("e".repeat(7));
  await expect(rows.nth(1)).toContainText("feature/a-long-branch-name");
  await expect(rows.nth(2)).toContainText("a".repeat(7));
  const fold = page.getByRole("table").getByTestId("build-fold");
  await expect(fold).toHaveCount(1);
  await expect(fold).toContainText("2 more main builds, auto-accepted");

  const toggle = fold.getByTestId("build-fold-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveText("Hide");
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(1)).toContainText("d".repeat(7));
  await expect(rows.nth(2)).toContainText("c".repeat(7));
  await toggle.click();
  await expect(rows).toHaveCount(3);
});
