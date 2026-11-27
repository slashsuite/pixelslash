import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, expectHydrated, open, test } from "./fixtures";
import { sql } from "./d1";
import { createOrg, createProject, openSettings } from "./orgs-page";

/** On a fresh project's settings: issue a CI token, see it once, revoke it, and save the default branch. */
async function issueToken(page: Page) {
  await expect(page.getByRole("heading", { name: "storefront · settings" })).toBeVisible();
  await expect(page.getByTestId("no-tokens")).toBeVisible();
  await expectHydrated(page);
  // Empty, the button is grey and says why rather than doing nothing.
  const issue = page.getByRole("button", { name: "Issue token" });
  await expect(issue).toBeDisabled();
  await expect(issue).toHaveAccessibleDescription(/Name the token first/);

  await page.getByLabel("Token name, e.g. github-actions").fill("github-actions");
  await page.getByRole("button", { name: "Issue token" }).click();
  const token = (await page.getByTestId("issued-token").getByRole("code").textContent()) ?? "";
  expect(token).toMatch(/^psci_/);
  const row = page.getByRole("row", { name: /github-actions/ });
  await expect(row).toContainText(token.slice(0, 9));
  await expect(row).toContainText("active");

  await page.reload();
  await expect(page.getByTestId("issued-token")).toHaveCount(0);
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toContainText("revoked");

  // The default branch starts at main and is what auto-accepts (ob 1559); a save survives a reload.
  const branch = page.getByLabel("Default branch, e.g. main");
  await expect(branch).toHaveValue("main");
  await branch.fill("master");
  // Reload only once the save's server call has returned: its response is what makes the value stick.
  const saved = page.waitForResponse(
    (res) => res.request().method() === "POST" && !!res.request().postData()?.includes("master"),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(page.getByLabel("Default branch, e.g. main")).toHaveValue("master");
}

/**
 * The one test that makes an org, a project and a CI token by clicking. Every other spec has them
 * written straight to the D1 (`provision` in fixtures.ts), so this is where those three flows are
 * proved in a browser.
 */
test("create an org, a project and a CI token by clicking; an empty org says what a project is, and an invite can be withdrawn", async ({
  page,
}) => {
  await open(page, "/orgs");
  const orgName = `Fresh Co ${randomUUID().slice(0, 8)}`;
  const orgId = await createOrg(page, orgName);
  const empty = page.getByTestId("empty-org");
  await expect(empty).toContainText("No projects yet");
  await expect(page.getByTestId("upload-command").getByRole("code")).toContainText(
    "pixelslash upload",
  );
  await expect(page.getByTestId("upload-command").getByRole("code")).toContainText("--server http");

  // Creating with no name says why on the field and puts the focus back in it.
  await page.getByRole("button", { name: "+ New project" }).first().click();
  await expect(page.getByLabel("Project name")).toBeFocused();
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("dialog")).toContainText("Type a name first.");
  await expect(page.getByLabel("Project name")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Project name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await createProject(page, "storefront");
  await expect(page.getByTestId("project-row")).toHaveCount(1);
  await expect(page.getByTestId("project-row")).toContainText("no builds yet");

  // The link inside the stretched row takes its own click; a click elsewhere on the row follows the row.
  const projectRow = page.getByTestId("project-row");
  await projectRow.getByRole("link", { name: "Set up uploads →" }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/settings/);
  await page.goBack();
  await projectRow.click({ position: { x: 600, y: 3 } });
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  // A project with no builds says how to make one: the token, then the exact upload command.
  const emptyProject = page.getByTestId("empty-project");
  await expect(emptyProject).toContainText("No builds yet");
  await expect(emptyProject.getByTestId("upload-command").getByRole("code")).toContainText(
    `pixelslash upload DIR --server ${new URL(page.url()).origin}`,
  );
  await page.goBack();
  await expect(page.getByTestId("project-row")).toHaveCount(1);

  await page.getByRole("link", { name: /^Members/ }).click();
  await page.getByLabel("Invite a member by GitHub login or email").fill("octo-dev");
  await page.getByRole("button", { name: "Invite", exact: true }).last().click();
  const pending = page.getByTestId("invite-row");
  await expect(pending).toContainText("octo-dev");
  await expect(pending).toContainText("pending");
  await expect(page.getByTestId("member-row")).toHaveCount(1);

  await pending.getByRole("button", { name: /Withdraw/ }).click();
  await expect(page.getByTestId("invite-row")).toHaveCount(0);
  // No invite left: the header says nothing of invites.
  await expect(page.getByTestId("org-people")).toHaveText("1 member");

  // The Timings tab: the link, the ?tab=timings URL and the loader that reads the builds. With no
  // build yet it says so (the rows and the numbers are render and query tests).
  await page.getByRole("link", { name: "Timings", exact: true }).click();
  await expect(page).toHaveURL(/tab=timings/);
  await expect(page.getByTestId("timings-empty")).toContainText(
    "No finished builds in the last 30 days",
  );

  // Issue a CI token from the project's settings, through its row's gear.
  await open(page, `/orgs?org=${orgId}`);
  await openSettings(page, "storefront");
  await issueToken(page);
});

const VIEWER = "(SELECT id FROM users WHERE login = 'e2e-octocat')";

/** Two more people in the org, written to the D1: one member and one other owner. */
function addPeople(orgId: string) {
  const suffix = randomUUID().slice(0, 8);
  const people = { member: `ada-${suffix}`, owner: `grace-${suffix}` };
  sql(
    [
      `INSERT INTO users (id, login) VALUES ('${people.member}', '${people.member}'), ('${people.owner}', '${people.owner}')`,
      `INSERT INTO members (org_id, user_id, role) VALUES ('${orgId}', '${people.member}', 'member'), ('${orgId}', '${people.owner}', 'owner')`,
    ].join(";\n"),
  );
  return people;
}

/** The members tab as an owner, then as a member: an owner removes a member; a member has no controls on anyone else. */
test("an owner removes a member, and a member sees no controls on anyone else's row", async ({
  page,
  provision,
}) => {
  const { orgId } = await provision({ org: "Roles Co" });
  const people = addPeople(orgId);
  await open(page, `/orgs?org=${orgId}&tab=members`);
  const row = (login: string) => page.getByTestId("member-row").filter({ hasText: login });
  await expect(page.getByTestId("member-row")).toHaveCount(3);
  await expect(row("e2e-octocat").getByTestId("member-role")).toHaveText("owner");
  await expect(row(people.member).getByTestId("member-role")).toHaveText("member");

  await row(people.member)
    .getByRole("button", { name: `Remove ${people.member}` })
    .click();
  await expect(page.getByTestId("member-row")).toHaveCount(2);
  await expect(row(people.member)).toHaveCount(0);

  // Stepped down by another owner: the viewer is now a member.
  sql(`UPDATE members SET role = 'member' WHERE org_id = '${orgId}' AND user_id = ${VIEWER}`);
  await page.reload();
  await expectHydrated(page);
  await expect(row("e2e-octocat").getByTestId("member-role")).toHaveText("member");
  await expect(row(people.owner).getByRole("button")).toHaveCount(0);
  // On their own row a member can only leave.
  await expect(row("e2e-octocat").getByRole("button")).toHaveText(["Leave"]);
});

/** The settings page's diff location form: a save survives a reload. What a CI project's upload then does is `local-build/upload.local-build.test.ts`. */
test("the diff location is saved from the project settings and survives a reload", async ({
  page,
  provision,
}) => {
  const { projectId } = await provision({ org: "Ci Co", project: "ci-shots" });
  await open(page, `/projects/${projectId}/settings`);
  const inCi = page.getByRole("radio", { name: /^In CI/ });
  await expect(inCi).not.toBeChecked();
  await page.getByText("In CI", { exact: true }).click();
  // Reload only once the save's server call has returned: its response is what makes the value stick.
  const saved = page.waitForResponse(
    (res) => res.request().method() === "POST" && !!res.request().postData()?.includes('"ci"'),
  );
  await page.getByRole("button", { name: "Save diff location" }).click();
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("radio", { name: /^In CI/ })).toBeChecked();
});
