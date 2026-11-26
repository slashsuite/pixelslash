import { randomUUID } from "node:crypto";
import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, uploadBuild } from "./api-upload";
import { sql } from "./d1";
import { expect, open, test } from "./fixtures";

const shots = (png: typeof WHITE) => [
  { name: "home", png },
  { name: "card", png },
];

/**
 * The combined review of a commit: a project with two subprojects, of which one changed two shots
 * on the commit and one did not run there. The project page links the commit's view; the view
 * groups the changes by subproject, decides them in place with the keys and the buttons, and lists
 * the one that did not run with its last build.
 */
test("a commit's changes across the subprojects are reviewed on one page", async ({
  page,
  provision,
}) => {
  const { orgId, projectId, token } = await provision({ org: "Commit Co", project: "storefront" });
  const sub = (name: string) => {
    const id = randomUUID();
    sql(
      `INSERT INTO projects (id, org_id, name, diff_location, parent_project_id) VALUES ('${id}', '${orgId}', '${name}', 'server', '${projectId}')`,
    );
    return id;
  };
  const e2eId = sub("e2e");
  sub("storybook");
  const main = { branch: "main", commitSha: SHA_MAIN };
  const work = {
    branch: "work",
    commitSha: SHA_WORK,
    mergeBaseSha: SHA_MAIN,
    ancestorShas: [SHA_MAIN],
  };
  await uploadBuild(token, main, shots(WHITE));
  await uploadBuild(token, { ...main, subproject: "e2e" }, shots(WHITE));
  const storybookMain = await uploadBuild(
    token,
    { ...main, subproject: "storybook" },
    shots(WHITE),
  );
  await uploadBuild(token, work, shots(WHITE));
  const e2eWork = await uploadBuild(token, { ...work, subproject: "e2e" }, shots(CHANGED));

  // The project page links the newest commit's combined view.
  await open(page, `/projects/${projectId}`);
  await page.getByTestId("commit-review-link").click();
  await page.waitForURL(`**/projects/${projectId}/commits/${SHA_WORK}`);

  await expect(page.getByTestId("commit-totals")).toHaveText("2 changes · 2 waiting");
  // The parent ran too, so the two are projects, not subprojects.
  await expect(page.getByTestId("commit-meta")).toContainText("across 2 projects;");
  const groups = page.getByTestId("commit-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveAttribute("data-project", "storefront");
  await expect(groups.nth(0).getByTestId("commit-group-totals")).toHaveText("no changes");
  const e2e = page.locator('[data-testid="commit-group"][data-project="e2e"]');
  await expect(e2e.getByTestId("commit-group-totals")).toHaveText("2 changes · 2 waiting");

  // The one that did not run counts nothing and links its last build.
  const notRun = page.getByTestId("commit-not-run-row");
  await expect(notRun).toHaveCount(1);
  await expect(notRun).toContainText("storybook");
  await expect(notRun).toContainText("not run on this commit (unchanged)");
  await expect(notRun.getByTestId("commit-last-build")).toHaveAttribute(
    "href",
    new RegExp(`/builds/${storybookMain}$`),
  );

  // Focus starts on the first waiting change; a accepts it and moves on to the next.
  const rows = e2e.getByTestId("commit-row");
  await expect(rows.nth(0)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("a");
  await expect(rows.nth(0)).toHaveAttribute("data-state", "accepted");
  await expect(rows.nth(1)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("k");
  await expect(rows.nth(0)).toHaveAttribute("data-focused", "true");
  await page.keyboard.press("j");
  await expect(rows.nth(1)).toHaveAttribute("data-focused", "true");

  // The buttons decide in place too; the totals follow.
  await rows.nth(1).getByTestId("commit-reject").click();
  await expect(rows.nth(1)).toHaveAttribute("data-state", "rejected");
  await expect(page.getByTestId("commit-totals")).toHaveText("2 changes · 1 accepted · 1 rejected");

  // ? lists the keys.
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");

  // The decisions are the build's own: its page shows them.
  await open(page, `/projects/${e2eId}/builds/${e2eWork}`);
  await expect(page.getByTestId("build-status")).toHaveText("failed");

  // A subproject's address opens its parent's view.
  await open(page, `/projects/${e2eId}/commits/${SHA_WORK}`);
  await page.waitForURL(`**/projects/${projectId}/commits/${SHA_WORK}`);
});

/**
 * A parent with subprojects uploads no builds of its own: on a commit where only its subprojects
 * ran, "Not run" lists the subproject that did not run and never the parent, and the summary
 * counts subprojects.
 */
test("the commit page leaves the parent out of not run", async ({ page, provision }) => {
  const { orgId, projectId, token } = await provision({ org: "Parent Co", project: "storefront" });
  for (const name of ["e2e", "storybook"])
    sql(
      `INSERT INTO projects (id, org_id, name, diff_location, parent_project_id) VALUES ('${randomUUID()}', '${orgId}', '${name}', 'server', '${projectId}')`,
    );
  const main = { branch: "main", commitSha: SHA_MAIN };
  const work = {
    branch: "work",
    commitSha: SHA_WORK,
    mergeBaseSha: SHA_MAIN,
    ancestorShas: [SHA_MAIN],
  };
  for (const subproject of ["e2e", "storybook"])
    await uploadBuild(token, { ...main, subproject }, shots(WHITE));
  await uploadBuild(token, { ...work, subproject: "e2e" }, shots(CHANGED));

  await open(page, `/projects/${projectId}/commits/${SHA_WORK}`);
  await expect(page.getByTestId("commit-group")).toHaveCount(1);
  const notRun = page.getByTestId("commit-not-run-row");
  await expect(notRun).toHaveCount(1);
  await expect(notRun).toContainText("storybook");
  await expect(page.getByTestId("commit-not-run")).not.toContainText("storefront");
  await expect(page.getByTestId("commit-meta")).toContainText("across 1 subproject;");
});

/**
 * A review started on one subproject's shot walks the commit's whole change set: accepting the
 * last change of the first subproject opens the second's first change, with no stop on a build
 * page between, the counter counts both, and the commit's page shows once nothing waits.
 */
test("accepting shot after shot walks every subproject of the commit, then the commit's page", async ({
  page,
  provision,
}) => {
  const { orgId, projectId, token } = await provision({ org: "Walk Co", project: "storefront" });
  for (const name of ["e2e", "storybook"])
    sql(
      `INSERT INTO projects (id, org_id, name, diff_location, parent_project_id) VALUES ('${randomUUID()}', '${orgId}', '${name}', 'server', '${projectId}')`,
    );
  const main = { branch: "main", commitSha: SHA_MAIN };
  const work = {
    branch: "work",
    commitSha: SHA_WORK,
    mergeBaseSha: SHA_MAIN,
    ancestorShas: [SHA_MAIN],
  };
  for (const subproject of [undefined, "e2e", "storybook"])
    await uploadBuild(token, { ...main, ...(subproject ? { subproject } : {}) }, shots(WHITE));
  await uploadBuild(token, work, shots(WHITE));
  const e2eWork = await uploadBuild(token, { ...work, subproject: "e2e" }, shots(CHANGED));
  const storybookWork = await uploadBuild(
    token,
    { ...work, subproject: "storybook" },
    shots(CHANGED),
  );

  // Start on e2e's first change, from the commit's page.
  await open(page, `/projects/${projectId}/commits/${SHA_WORK}`);
  const e2e = page.locator('[data-testid="commit-group"][data-project="e2e"]');
  await e2e.getByTestId("commit-row-name").first().click();
  await page.waitForURL(`**/builds/${e2eWork}/snapshots/**`);
  const position = page.getByTestId("review-position");
  await expect(position).toHaveText("change 1 of 4");

  await page.keyboard.press("a");
  await expect(position).toHaveText("change 2 of 4");
  // e2e's last change: the next is storybook's first, not e2e's build page.
  await page.keyboard.press("a");
  await page.waitForURL(`**/builds/${storybookWork}/snapshots/**`);
  await expect(position).toHaveText("change 3 of 4");
  await page.keyboard.press("a");
  await expect(position).toHaveText("change 4 of 4");

  // Nothing waits anywhere: the commit's page, every change accepted.
  await page.keyboard.press("a");
  await page.waitForURL(`**/projects/${projectId}/commits/${SHA_WORK}`);
  await expect(page.getByTestId("commit-totals")).toHaveText("4 changes · 4 accepted");
});
