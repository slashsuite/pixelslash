import { SIGNED_OUT, expect, open, test } from "./fixtures";

/**
 * A visitor on a light system picks dark with the toggle, and the choice outlives a reload with the
 * class already in the server's HTML, so the page never flashes light. Which theme the script in
 * <head> picks for a cookie and a system is `lib/theme.test.ts`'s.
 */

test.use({ storageState: SIGNED_OUT, colorScheme: "light" });

const DARK_HTML = /<html[^>]*class="(?:[^"]* )?dark[ "]/;

test("a visitor's theme choice survives a reload, rendered by the server", async ({ page }) => {
  const html = page.locator("html");
  const toggle = page.getByRole("button", { name: /^Switch to (dark|light) theme$/ });

  await test.step("a light system starts light", async () => {
    await open(page, "/");
    await expect(toggle).toBeEnabled();
    await expect(html).not.toHaveClass(/dark/);
    await expect(toggle).toHaveAccessibleName("Switch to dark theme");
    // No theme cookie until the visitor picks one: the server rendered the page and set none.
    expect((await page.context().cookies()).map((c) => c.name)).not.toContain("ps_theme");
  });

  await test.step("the toggle picks dark, and its name flips with the page", async () => {
    await toggle.click();
    await expect(html).toHaveClass(/dark/);
    await expect(toggle).toHaveAccessibleName("Switch to light theme");
  });

  await test.step("the server renders the choice, so a reload keeps it", async () => {
    expect(await (await page.request.get("/")).text()).toMatch(DARK_HTML);
    await page.reload();
    await expect(html).toHaveClass(/dark/);
    await expect(toggle).toHaveAccessibleName("Switch to light theme");
  });

  await test.step("picking light again is rendered light", async () => {
    await toggle.click();
    await expect(html).not.toHaveClass(/dark/);
    expect(await (await page.request.get("/")).text()).not.toMatch(DARK_HTML);
  });
});
