import { sql } from "./d1";
import { expect, expectHydrated, open, test } from "./fixtures";

test("mint an org token in the org settings, see it is live, revoke it", async ({
  page,
  request,
  provision,
}) => {
  const { orgId } = await provision({ org: "Monorepo Co" });
  await open(page, `/orgs?org=${orgId}`);

  await page.getByRole("link", { name: /^Tokens/ }).click();
  await expect(page).toHaveURL(/tab=tokens/);
  await expect(page.getByTestId("no-org-tokens")).toBeVisible();
  await expect(page.getByRole("button", { name: "Issue org token" })).toBeDisabled();

  await page.getByLabel("Org token name, e.g. monorepo CI").fill("monorepo CI");
  await page.getByRole("button", { name: "Issue org token" }).click();
  const token = (await page.getByTestId("issued-org-token").getByRole("code").textContent()) ?? "";
  expect(token).toMatch(/^psorg_/);
  const row = page.getByTestId("org-token-row").filter({ hasText: "monorepo CI" });
  await expect(row).toContainText(token.slice(0, 8));
  await expect(row).toContainText("active");

  // The shown token is live: it is its org.
  const auth = { authorization: `Bearer ${token}` };
  const me = await request.get("/api/v1/me", { headers: auth });
  expect(await me.json()).toMatchObject({ kind: "org-ci", orgId });

  // Shown once: after a reload only the prefix is left.
  await page.reload();
  await expect(page.getByTestId("issued-org-token")).toHaveCount(0);
  await expect(page.getByText(token)).toHaveCount(0);
  await expect(row).toContainText(token.slice(0, 8));

  // Stepped down while the page is open: the Revoke is refused with a 403 the table shows.
  await expectHydrated(page);
  const viewer = `org_id = '${orgId}' AND user_id = (SELECT id FROM users WHERE login = 'e2e-octocat')`;
  sql(`UPDATE members SET role = 'member' WHERE ${viewer}`);
  const refused = page.waitForResponse(
    (res) => res.request().method() === "POST" && !!res.request().postData()?.includes("tokenId"),
  );
  await row.getByRole("button", { name: "Revoke monorepo CI" }).click();
  expect((await refused).status()).toBe(403);
  await expect(page.getByRole("alert")).toHaveText(
    "Only an owner of this organization can do that.",
  );
  await expect(row).toContainText("active");
  sql(`UPDATE members SET role = 'owner' WHERE ${viewer}`);

  await row.getByRole("button", { name: "Revoke monorepo CI" }).click();
  await expect(row).toContainText("revoked");
  await expect(row.getByRole("button", { name: "Revoke monorepo CI" })).toHaveCount(0);
  expect((await request.get("/api/v1/me", { headers: auth })).status()).toBe(401);
});
