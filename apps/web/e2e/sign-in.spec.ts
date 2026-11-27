import { SIGNED_OUT, expect, open, test } from "./fixtures";

// Signs in itself, so it starts with no session. Not the server's zone or locale, so a date
// formatted in the reader's own fails hydration.
test.use({ storageState: SIGNED_OUT, timezoneId: "America/New_York", locale: "de-DE" });

const HYDRATION = /hydrat|react\.dev\/errors\/(418|423|425)/i;

/**
 * Signing in through the button, then a project's pages in another zone and locale. Creating the
 * org, the project and the token by clicking is orgs.spec.ts; here they are written straight to the
 * D1, so the pages have a project and a dated token row to render.
 */
test("sign in with GitHub, and a project's pages hydrate in the reader's own zone", async ({
  page,
  provision,
}) => {
  const hydrationErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && HYDRATION.test(msg.text())) hydrationErrors.push(msg.text());
  });
  page.on("pageerror", (error) => {
    if (HYDRATION.test(error.message)) hydrationErrors.push(error.message);
  });
  await open(page, "/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(/\/orgs$/);
  await expect(page.getByRole("heading", { name: "Organizations", exact: true })).toBeVisible();

  const { orgId, orgName, projectId, token } = await provision({
    org: "Acme",
    project: "storefront",
  });
  await open(page, `/orgs?org=${orgId}`);
  await expect(page.getByRole("heading", { name: orgName, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "storefront", exact: true })).toBeVisible();

  await open(page, `/projects/${projectId}`);
  await expect(page.getByTestId("empty-project")).toContainText("No builds yet");

  await open(page, `/projects/${projectId}/settings`);
  await expect(page.getByRole("heading", { name: "storefront · settings" })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: token.slice(0, 9) });
  await expect(row).toContainText("active");
  expect(hydrationErrors).toEqual([]);
});

/** Every `build-commit` meta's content in served HTML, read as scripts/check-commit.ts reads it. */
const buildCommitsIn = (html: string) =>
  [...html.matchAll(/<meta\s[^>]*>/gi)]
    .map(([tag]) => tag)
    .filter((tag) => /\sname\s*=\s*"build-commit"/i.test(tag))
    .map((tag) => /\scontent\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? "");

// The root route's head carries it, so one page stands for every route (scripts/check-commit.ts reads it after a deploy).
test("the page names the commit it was built from in a meta nobody sees", async ({ page }) => {
  // Read the way the deploy check reads it: from the served HTML.
  const commits = buildCommitsIn(await (await page.request.get("/")).text());
  expect(commits).toHaveLength(1);
  const [commit = ""] = commits;
  expect(commit).toMatch(/^([0-9a-f]{40}(-dirty)?|unknown)$/);
  await open(page, "/");
  await expect(page.getByText(new RegExp(commit))).toHaveCount(0);
});
