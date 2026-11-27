// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "#/test/render";
import { BuildError } from "./build-error";

// The Re-run button's server function reads the Worker's env, which a test has none of; that the
// button re-runs is `rerun.test.tsx`'s.
vi.mock("#/server/rerun", () => ({ rerunBuildShots: vi.fn<() => Promise<never>>() }));

/**
 * The build page's callout for a build with no verdict: it prints the error the server stored, in
 * full, and offers the way to measure it again that the project's diff location allows. The
 * message itself (a build captured in another environment names both and the way out) is
 * `diff/process-unmeasured.test.ts`'s.
 */

const MOVED =
  "This build: image version:e2e, browser chromium 1, fonts sha256:laptop. " +
  "Its baseline: image version:e2e, browser chromium 1, fonts sha256:f. " +
  "Upload from CI or the pinned capture image.";

const errored = (diffLocation: string, status = "errored", error: string | null = MOVED) => ({
  project: { id: "p1", diffLocation },
  build: { id: "b1", status, error },
});

describe("the build page's error callout", () => {
  test("prints the stored error in full, with a re-run when the server diffs", async () => {
    await render(<BuildError {...errored("server")} />);
    expect(screen.getByText(MOVED)).toBeTruthy();
    expect(screen.getByRole("button", { name: /re-run/i })).toBeTruthy();
    expect(screen.queryByTestId("rerun-ci")).toBeNull();
  });

  test("when the project diffs in CI it says to re-run the CI job, and offers no button", async () => {
    await render(<BuildError {...errored("ci")} />);
    expect(screen.getByText(MOVED)).toBeTruthy();
    expect(screen.getByTestId("rerun-ci").textContent).toContain("re-run the CI job");
    expect(screen.queryByRole("button", { name: /re-run/i })).toBeNull();
  });

  test("a build with no error draws nothing", async () => {
    await render(<BuildError {...errored("server", "passed", null)} />);
    expect(screen.queryByText(MOVED)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
