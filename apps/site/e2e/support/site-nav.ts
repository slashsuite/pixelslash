import type { Locator, Page } from "@playwright/test";

/**
 * The header's site nav as a reader sees it. AppShell (@slashsuite/ui-react 0.13) renders the nav
 * once, in a popover panel: from md it sits in the header row, and on a phone (or when the row is too
 * narrow for it) it opens under a "Menu" button. On a phone the Menu is opened first, as a reader would.
 */
export async function siteNav(page: Page): Promise<Locator> {
  const menu = menuButton(page);
  if ((await menu.isVisible()) && !(await menuOpen(page))) await menu.click();
  return page.getByTestId("site-nav").filter({ visible: true });
}

/** The phone header's Menu button: it toggles AppShell's popover panel. */
export const menuButton = (page: Page): Locator =>
  page.locator("header button[popovertarget]", { hasText: /^\s*Menu\s*$/ });

/** Whether the phone header's Menu is open. */
export const menuOpen = (page: Page): Promise<boolean> =>
  page.locator("header [data-shell-menu]").evaluate((element) => element.matches(":popover-open"));
