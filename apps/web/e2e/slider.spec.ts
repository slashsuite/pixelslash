import { expect, expectHydrated, open, test } from "./fixtures";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, uploadBuild } from "./api-upload";
import { dragOver } from "./draw";
import { showPanel } from "./snapshot-viewer";

/**
 * The side panel's disclosures and the slider (PS-265): Branch is drawn at Main's scale, the divider
 * starts halfway, follows a drag on the image, and its handle is a keyboard slider.
 */

test("Details and Tools start shut; the slider draws both shots at one scale, starts halfway, drags on the image and takes the keyboard", async ({
  page,
  provision,
}) => {
  const { token, projectId } = await provision({ org: "Slider Co", project: "slider" });
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: "hero", png: WHITE }]);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [{ name: "hero", png: CHANGED }],
  );

  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await page.getByTestId("snapshot-row").first().getByRole("link").click();
  await expect(page).toHaveURL(/\/snapshots\//);
  await expectHydrated(page);
  await showPanel(page);
  const range = page.getByLabel("Compare position");
  const handle = page.getByRole("slider", { name: "Divider" });
  let dragged = 0;

  await test.step("Details and Tools start shut and open on a click", async () => {
    // The side panel leads with the summary; Details and Tools start collapsed and open with a click.
    await expect(page.getByTestId("sizes")).toBeHidden();
    for (const name of ["Details", "Tools"]) {
      const toggle = page.getByRole("button", { name, exact: true });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
    }
    await expect(page.getByTestId("sizes")).toBeVisible();
    await expect(page.getByTestId("rerun-shot")).toBeVisible();
  });

  await test.step("the slider draws Branch at Main's scale, starts halfway, and a drag on the image moves the divider", async () => {
    await page.getByRole("radio", { name: "Slider" }).click();
    await expect(range).toHaveValue("50");
    await expect(handle).toHaveAttribute("aria-valuenow", "50");

    // At 50 the branch layer is as wide as the main one, not half of it.
    // No dogfood shot opens the slider, so no visual check sees a half-width Branch layer.
    const [main, branch] = await Promise.all([
      // oxlint-disable-next-line no-restricted-properties -- no visual shot shows the slider; this width is the only proof
      page.getByTestId("slider-main").boundingBox(),
      // oxlint-disable-next-line no-restricted-properties -- no visual shot shows the slider; this width is the only proof
      page.getByTestId("slider-branch").boundingBox(),
    ]);
    expect(main?.width).toBeGreaterThan(0);
    expect(branch?.width).toBeCloseTo(main?.width ?? 0, 0);

    // A drag on the image moves the divider to the pointer.
    await dragOver(page, page.getByTestId("slider-frame"), [0.5, 0.5], [0.8, 0.5]);
    dragged = Number(await handle.getAttribute("aria-valuenow"));
    expect(dragged).toBeGreaterThan(70);
    await expect(range).toHaveValue(String(dragged));
  });

  await test.step("the handle takes the keyboard", async () => {
    // The handle is in the tab order after the toolbar (a few stops on from the range), and the
    // arrows move it.
    await range.focus();
    await expect
      .poll(
        async () => {
          await page.keyboard.press("Tab");
          return handle.evaluate((el) => el === document.activeElement);
        },
        { intervals: [0] },
      )
      .toBe(true);
    await expect(handle).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(handle).toHaveAttribute("aria-valuenow", String(dragged - 1));
    await page.keyboard.press("Home");
    await expect(handle).toHaveAttribute("aria-valuenow", "0");
    await expect(range).toHaveValue("0");
  });
});
