// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { emptyCounts } from "#/db/build-counts";
import type { BuildSummary } from "#/db/build-list";
import { formatRelative } from "#/lib/format";
import { render } from "#/test/render";
import { BuildsList } from "./builds-list";

/**
 * The project's builds list (PS-420), drawn twice: a stacked card per build for a phone and the
 * table from `sm` up (CSS picks one). Each shows the build's branch, sha, PR, status, mix, what is
 * left to review and when; and a build stored as `passed` that still has shots to review reads
 * "changes", not "passed" beside them. That the card fits a phone's width is the page loop's
 * (`e2e/pages.spec.ts`); which builds fold is `lib/build-folds.test.ts`'s.
 */

const NOW = new Date("2026-11-20T12:00:00Z");
const CREATED = new Date("2026-11-20T11:00:00Z");

const build = (over: Partial<BuildSummary>): BuildSummary => ({
  id: "b1",
  branch: "feature/a-long-branch-name",
  commitSha: "b".repeat(40),
  prNumber: 12,
  status: "changes",
  error: null,
  createdAt: CREATED,
  counts: { ...emptyCounts(), changed: 3, unchanged: 1, pending: 3, toReview: 3 },
  ...over,
});

afterEach(cleanup);

async function list(builds: BuildSummary[]) {
  await render(<BuildsList projectId="p1" defaultBranch="main" builds={builds} now={NOW} />);
  const [card] = screen.getAllByTestId("build-card");
  const [row] = screen.getAllByTestId("build-row");
  if (!card || !row) throw new Error("no build drawn");
  return { card: within(card), row: within(row) };
}

describe("the builds list", () => {
  test("the card and the row each carry every field of a build", async () => {
    const { card, row } = await list([build({})]);
    for (const view of [card, row]) {
      expect(view.getByText("feature/a-long-branch-name")).toBeTruthy();
      expect(view.getByText("bbbbbbb")).toBeTruthy();
      expect(view.getByText("PR #12")).toBeTruthy();
      expect(view.getByTestId("build-status").textContent).toBe("changes");
      expect(view.getByTestId("snapshot-mix")).toBeTruthy();
      expect(view.getByTestId("to-review").textContent).toMatch(/^3 to review$/);
      expect(view.getByTestId("rel-time").textContent).toBe(formatRelative(CREATED, NOW));
    }
  });

  test("a passed build with shots to review reads changes, on the card and the row", async () => {
    const { card, row } = await list([build({ status: "passed" })]);
    for (const view of [card, row]) {
      expect(view.getByTestId("build-status").textContent).toBe("changes");
      expect(view.queryByText("passed")).toBeNull();
    }
  });

  test("a passed build with nothing to review reads passed", async () => {
    const counts = { ...emptyCounts(), unchanged: 4 };
    const { card, row } = await list([build({ status: "passed", counts })]);
    for (const view of [card, row])
      expect(view.getByTestId("build-status").textContent).toBe("passed");
  });
});
