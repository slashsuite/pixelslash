import type { Page } from "@playwright/test";
import { expect, open, test } from "./fixtures";
import { SHA_MAIN, SHA_WORK, uploadBuild } from "./api-upload";
import { png } from "./png";
import { highlightToggle } from "./snapshot-viewer";

/**
 * The compare view of one changed shot, on a wide screen: the counters, the highlight that starts
 * off, the mode picker across a theme toggle, the overlay's opacity range, and the side panel that
 * folds away at Fit, side by side, and comes back for a flag. How each part looks is the visual
 * job's; the overlay's opacity style is `snapshot-overlay.test.tsx`'s. The phone width is the page
 * loop's (`pages.spec.ts`).
 */

const MAIN = png(1300, 500);
const BRANCH = png(1300, 500, [{ x: 100, y: 100, w: 400, h: 200, rgb: [220, 30, 30] }]);

const radioOf = (page: Page) => (name: string) => page.getByRole("radio", { name, exact: true });

/** At Fit, side by side, the panel folds away behind its toggle; anywhere else it is always there. */
async function panelFoldsAtFit(page: Page) {
  const radio = radioOf(page);
  const panel = page.getByRole("complementary", { name: "Review panel" });
  const panelToggle = page.getByRole("button", { name: "Side panel", exact: true });
  await radio("Side by side").click();
  await radio("Fit").click();
  await expect(panel).toHaveCount(0);
  await expect(panelToggle).toHaveAttribute("aria-pressed", "false");
  await panelToggle.click();
  await expect(panel).toBeVisible();
  await expect(panelToggle).toHaveAttribute("aria-pressed", "true");
  await panelToggle.click();
  await expect(panel).toHaveCount(0);
  // Off Fit, or off side by side, the panel is always there and there is nothing to toggle.
  await radio("1:1").click();
  await expect(panel).toBeVisible();
  await expect(panelToggle).toHaveCount(0);
  await radio("Fit").click();
  await expect(panel).toHaveCount(0);
  await radio("Overlay").click();
  await expect(panel).toBeVisible();
  await radio("Side by side").click();
  await expect(panel).toHaveCount(0);
}

test("review one changed shot: counters, highlight, modes, overlay, the folding panel and a flag", async ({
  page,
  provision,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { token, projectId } = await provision({ org: "Compare Co", project: "compare" });
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [
    { name: "hero", png: MAIN },
    { name: "footer", png: MAIN },
  ]);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [
      { name: "hero", png: BRANCH },
      { name: "footer", png: MAIN },
    ],
  );
  const radio = radioOf(page);
  const panel = page.getByRole("complementary", { name: "Review panel" });
  const panelToggle = page.getByRole("button", { name: "Side panel", exact: true });
  const theme = page.getByRole("button", { name: /^Switch to (dark|light) theme$/ });

  await test.step("open the changed shot from its build", async () => {
    await open(page, `/projects/${projectId}/builds/${buildId}`);
    await page.getByRole("link", { name: /hero/i }).first().click();
    await expect(page).toHaveURL(/\/snapshots\//);
    await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
    await expect(page.getByText("change 1 of 1", { exact: true })).toBeVisible();
    await expect(page.getByText("shot 1 of 2", { exact: true })).toBeVisible();
  });

  await test.step("the panel states the share of changed pixels", async () => {
    // At Fit, side by side, the panel starts folded: open it, read the share, fold it again.
    await panelToggle.click();
    // 400 x 200 changed px of the 1300 x 500 compared area: 12.3%.
    await expect(panel.getByTestId("changed-px")).toHaveText(/^[\d,]+ \(12\.3%\)$/);
    await panelToggle.click();
    await expect(panel).toHaveCount(0);
  });

  await test.step("the highlight starts off and turns on", async () => {
    const highlight = highlightToggle(page);
    await expect(highlight).toHaveAttribute("aria-pressed", "false");
    await expect(highlight).toHaveText("Highlight off");
    await expect(page.getByRole("img", { name: "Measured regions" })).toHaveCount(0);
    await highlight.click();
    await expect(highlight).toHaveAttribute("aria-pressed", "true");
    await expect(highlight).toHaveText("Highlight on");
  });

  await test.step("the chosen mode stays checked, also across a theme toggle", async () => {
    for (const mode of ["Slider", "Overlay", "Side by side"]) {
      await radio(mode).click();
      await expect(radio(mode)).toHaveAttribute("aria-checked", "true");
      for (const other of ["Side by side", "Overlay", "Slider"].filter((m) => m !== mode))
        await expect(radio(other)).toHaveAttribute("aria-checked", "false");
      await theme.click();
      await expect(radio(mode)).toHaveAttribute("aria-checked", "true");
      await theme.click();
      await expect(radio(mode)).toHaveAttribute("aria-checked", "true");
    }
  });

  await test.step("the overlay's opacity range starts at half and takes a value", async () => {
    await radio("Overlay").click();
    const range = page.getByLabel("Overlay opacity");
    await expect(range).toHaveValue("50");
    await range.fill("20");
    await expect(range).toHaveValue("20");
  });

  await test.step("at Fit, side by side, the panel folds away behind its toggle", async () => {
    await panelFoldsAtFit(page);
  });

  await test.step("flagging a detection opens the folded panel for its form", async () => {
    await page.getByRole("button", { name: "Flag detection" }).click();
    await expect(panel).toBeVisible();
    await expect(panelToggle).toBeDisabled();
  });
});
