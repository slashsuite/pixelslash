import { expect, open, test } from "./fixtures";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, uploadBuild } from "./api-upload";

/**
 * A busy project's main builds pass one after another with nothing to review. Each run of them
 * keeps its newest build in the list and folds the rest behind a line that says how many; a build
 * with work to review is never folded, and the line opens the run in place. What each row and card
 * shows, and the status a stale `passed` build reads, is `components/builds-list.test.tsx`'s;
 * which builds fold is `lib/build-folds.test.ts`'s; the phone's width is the page loop's.
 */

const SHOTS = [
  { name: "hero", png: WHITE },
  { name: "ticker", png: WHITE },
  { name: "footer", png: WHITE },
];

test("a run of auto-accepted main builds folds behind one line, and opens in place", async ({
  page,
  provision,
}) => {
  const { projectId, token } = await provision({ org: "List Co", project: "list" });
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, SHOTS);
  await uploadBuild(
    token,
    {
      branch: "feature/a-long-branch-name",
      commitSha: SHA_WORK,
      mergeBaseSha: SHA_MAIN,
      ancestorShas: [SHA_MAIN],
    },
    [{ name: "hero", png: CHANGED }, ...SHOTS.slice(1)],
  );
  // Three more main builds, newest last, each the same as main's accepted shots.
  for (const sha of ["c", "d", "e"])
    await uploadBuild(token, { branch: "main", commitSha: sha.repeat(40) }, SHOTS);

  await page.setViewportSize({ width: 1280, height: 800 });
  const table = page.getByRole("table", { name: "Builds" });
  const rows = table.getByTestId("build-row");
  const fold = table.getByTestId("build-fold");
  const toggle = fold.getByRole("button");

  await test.step("the project page folds main's two quiet builds", async () => {
    await open(page, `/projects/${projectId}`);
    // Newest first: main e, the fold (d, c), the feature build, then main a, alone past the feature.
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("e".repeat(7));
    await expect(rows.nth(1)).toContainText("feature/a-long-branch-name");
    await expect(rows.nth(2)).toContainText("a".repeat(7));
    await expect(fold).toHaveCount(1);
    await expect(fold).toContainText("2 more main builds, auto-accepted");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  await test.step("Show opens the run under its line, Hide folds it again", async () => {
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveText("Hide");
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(1)).toContainText("d".repeat(7));
    await expect(rows.nth(2)).toContainText("c".repeat(7));
    await toggle.click();
    await expect(rows).toHaveCount(3);
  });
});
