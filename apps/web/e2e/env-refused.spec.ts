import { expect, open, test } from "./fixtures";
import { FINGERPRINT, SHA_MAIN, SHA_WORK, WHITE, uploadBuild } from "./api-upload";

/**
 * A branch build captured in another environment than its baseline is refused (PS-282), and the
 * build page says why in full (PS-590): both environments, and to upload from CI or the pinned
 * capture image. The refusal is the server's own, from a real upload.
 */

test("a build from another environment is refused, and its page names both and the way out", async ({
  page,
  provision,
}) => {
  const { token, projectId } = await provision({ org: "Moved Co", project: "moved" });
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, [{ name: "hero", png: WHITE }]);
  const buildId = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    [{ name: "hero", png: WHITE, fingerprint: { ...FINGERPRINT, fonts: "sha256:laptop" } }],
  );

  await open(page, `/projects/${projectId}/builds/${buildId}`);
  await expect(page.getByTestId("build-status")).toHaveText("errored");
  await expect(
    page.getByText(
      "This build: image version:e2e, browser chromium 1, fonts sha256:laptop. " +
        "Its baseline: image version:e2e, browser chromium 1, fonts sha256:f.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Upload from CI or the pinned capture image")).toBeVisible();
});
