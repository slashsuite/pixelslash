import { CHANGED, SHA_MAIN, SHA_WORK, WHITE, uploadBuild } from "./api-upload";
import { expect, open, test } from "./fixtures";

/** One story, shot at a desktop and a phone width under the same name. */
const shots = (png: typeof WHITE) => [
  { name: "button-primary", png, viewport: "1280x800" },
  { name: "button-primary", png, viewport: "390x844" },
];

/**
 * A capture that shoots each story at two widths gives both shots one name. The build page and the
 * branch's review list must still tell them apart, so each row names its viewport next to the
 * shot's name: one "Desktop 1280x800", one "Phone 390x844", never two rows that read the same.
 */
test("a two-viewport build lists each shot with its viewport", async ({ page, provision }) => {
  const { token, projectId } = await provision({ org: "Viewport Co", project: "storybook" });
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, shots(WHITE));
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    shots(CHANGED),
  );

  const expectOneEach = async (rows: ReturnType<typeof page.getByTestId>) => {
    await expect(rows).toHaveCount(2);
    for (const label of ["Desktop 1280x800", "Phone 390x844"]) {
      const row = rows.filter({ hasText: label });
      await expect(row).toHaveCount(1);
      // The card reads the name as words ("Button primary"), the review row shows the key.
      await expect(row).toContainText(/button.primary/i);
    }
  };

  // The build page's changed shots.
  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await expectOneEach(page.getByTestId("snapshot-row"));

  // The branch's final review, against main.
  await open(page, `/projects/${projectId}/branches/work`);
  await expectOneEach(page.getByTestId("main-row"));
});
