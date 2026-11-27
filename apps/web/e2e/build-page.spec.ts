import { expect, open, test } from "./fixtures";
import { SHA_MAIN, SHA_WORK, uploadBuild } from "./api-upload";
import { openRunCard } from "./build-workspace";
import { png } from "./png";

/**
 * The build page puts the work first (PS-419): the changed shots come before the run's diagnostics,
 * on the first screen, and "This run" is folded until it is opened. The summary's lead (three
 * sentences, eight links) is `components/build-summary-lead.test.tsx`'s, a thumbnail's 16:10 crop
 * is `lib/thumb-crop.test.ts`'s, and the phone's width is the page loop's (`pages.spec.ts`).
 */

const NAMES = ["page-01", "page-02", "page-03"];
const MAIN = png(400, 1600);
// A thin, wide change deep in the page: a strip of red on a tall shot.
const BRANCH = png(400, 1600, [{ x: 0, y: 800, w: 400, h: 6, rgb: [220, 30, 30] }]);

test("the changed shots come first, and the run's diagnostics are folded until opened", async ({
  page,
  provision,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { token, projectId } = await provision({ org: "Build Page Co", project: "buildpage" });
  await uploadBuild(
    token,
    { branch: "main", commitSha: SHA_MAIN },
    NAMES.map((name) => ({ name, png: MAIN })),
  );
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    NAMES.map((name) => ({ name, png: BRANCH })),
  );
  const run = page.getByTestId("run-disclosure").getByRole("button", { name: "This run" });

  await test.step("the first changed shot is on the first screen, above the run", async () => {
    await open(page, `/projects/${projectId}/builds/${buildId}`);
    const first = page.getByRole("link", { name: /Page 01/ });
    await expect(first).toBeInViewport();
    const before = await first.evaluate((row) => {
      const block = document.querySelector('[data-testid="run-disclosure"]');
      if (!block) throw new Error("no run block");
      return (block.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
    });
    expect(before, "the first changed shot precedes the run block").toBe(true);
  });

  await test.step("This run is folded, and opens on a click", async () => {
    await expect(run).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("build-timings")).toBeHidden();
    await openRunCard(page);
    await expect(run).toHaveAttribute("aria-expanded", "true");
  });
});
