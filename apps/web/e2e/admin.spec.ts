import { SIGNED_OUT, expect, open, test } from "./fixtures";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, uploadBuild } from "./api-upload";
import { rivalContext, rivalSession } from "./rival";

/**
 * The operator health page (PS-330). The e2e build lists the stub GitHub user (`e2e-octocat`) in
 * `PIXELSLASH_ADMIN_LOGINS`; everyone else, signed in or not, gets the same 404 as a path that does
 * not exist. The "variable unset" case is the access rule's unit test (`admin-access.test.ts`): the
 * build here always sets it. The page's width on a phone is the page loop's (`pages.spec.ts`), and
 * how it looks in either theme is the visual job's; what each figure counts is
 * `db/admin-health.test.ts`'s and `db/admin-health-compares.test.ts`'s.
 */

test("only a listed operator gets the health page, and it reads every group", async ({
  browser,
  page,
  provision,
}) => {
  await test.step("a visitor who is not signed in gets a 404, not a sign-in redirect", async () => {
    const context = await browser.newContext({ storageState: SIGNED_OUT });
    const view = await context.newPage();
    const response = await open(view, "/_admin");
    expect(response?.status()).toBe(404);
    expect(new URL(view.url()).pathname).toBe("/_admin");
    await expect(view.getByTestId("operator-health")).toHaveCount(0);
    await context.close();
  });

  await test.step("a signed-in user who is not listed gets a 404", async () => {
    const token = await rivalSession("admin-rival", 9101, "Not An Operator Co");
    const context = await rivalContext(browser, token);
    const view = await context.newPage();
    const response = await open(view, "/_admin");
    expect(response?.status()).toBe(404);
    await expect(view.getByTestId("operator-health")).toHaveCount(0);
    // Signed in, so the page they are refused is not a sign-in prompt.
    await expect(view.getByRole("link", { name: "Sign in with GitHub" })).toHaveCount(0);
    await context.close();
  });

  await test.step("no customer page links to it", async () => {
    // Signed in from the start (the setup project).
    await open(page, "/orgs");
    await expect(page.getByRole("link", { name: /operator|admin/i })).toHaveCount(0);
  });

  // A real build with a diffed shot, so the window has a build and a server compare to count.
  const { token } = await provision({ org: "Window Figures Co", project: "figures" });
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: "hero", png: WHITE }]);
  await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [{ name: "hero", png: CHANGED }],
  );

  await test.step("the operator sees every group, and what it cannot read says why", async () => {
    const response = await open(page, "/_admin");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Operator health", exact: true })).toBeVisible();
    await expect(page.getByTestId("admin-now")).toContainText("as of");
    await expect(page.getByTestId("admin-window-24h")).toContainText("Last 24 hours");
    await expect(page.getByTestId("admin-window-7d")).toContainText("Last 7 days");
    await expect(page.getByTestId("admin-24h-finished")).toContainText("finished");
    // Every step's tail reads p99 only from its gate, and the page names that gate.
    await expect(page.getByTestId("admin-window-24h")).toContainText("99th percentile");
    await expect(page.getByTestId("admin-window-24h")).toContainText("when under 100");
    // The deployment group: the e2e build is stamped, and its database is migrated to the code.
    await expect(page.getByTestId("admin-sha")).toHaveText("e2e");
    await expect(page.getByTestId("admin-unapplied")).toHaveText("none");
    // Storage: counts are numbers; R2 says it cannot be read cheaply, never 0.
    await expect(page.getByTestId("admin-rows-builds")).toBeVisible();
    await expect(page.getByTestId("admin-r2")).toContainText("unavailable:");
    await expect(page.getByTestId("admin-24h-summary-failures")).toContainText("unavailable:");
    // Read-only: nothing on the page acts.
    await expect(page.getByTestId("operator-health").getByRole("button")).toHaveCount(0);
  });

  await test.step("each window reads snapshots per build and time per snapshot", async () => {
    for (const key of ["24h", "7d"]) {
      const figures = page.getByTestId(`admin-${key}-figures`);
      await expect(figures.getByTestId(`admin-${key}-figures-per-build`)).toHaveText(
        /^\d[\d,]* \/ \d[\d,]*( max)? \/ (n\/a|\d[\d,]*) · n=\d[\d,]* builds$/,
      );
      await expect(figures.getByTestId(`admin-${key}-figures-per-snapshot`)).toHaveText(
        / · n=\d[\d,]* compares$/,
      );
      await expect(figures).toContainText("a CI build's times are not in it");
    }
  });
});
