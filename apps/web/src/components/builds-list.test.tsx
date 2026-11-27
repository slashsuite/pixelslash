// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { emptyCounts } from "#/db/build-counts";
import { must } from "#/test/must";
import type { BuildSummary } from "#/db/build-list";
import { formatRelative } from "#/lib/format";
import { render, screen, within } from "#/test/render";
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

/** The card (a phone) and the row (`sm` up): every build is drawn as both. */
const VIEWS = ["build-card", "build-row"] as const;

/** Draws `builds` and returns the first build's `view`, card or row. */
async function first(builds: BuildSummary[], view: (typeof VIEWS)[number]): Promise<HTMLElement> {
  await render(<BuildsList projectId="p1" defaultBranch="main" builds={builds} now={NOW} />);
  return must(screen.getAllByTestId(view)[0], view);
}

describe("the builds list", () => {
  test.each(VIEWS)("the %s carries every field of a build", async (view) => {
    const el = await first([build({})], view);
    expect(within(el).getByText("feature/a-long-branch-name")).toBeTruthy();
    expect(within(el).getByText("bbbbbbb")).toBeTruthy();
    expect(within(el).getByText("PR #12")).toBeTruthy();
    expect(within(el).getByTestId("build-status").textContent).toBe("changes");
    expect(within(el).getByTestId("snapshot-mix")).toBeTruthy();
    expect(within(el).getByTestId("to-review").textContent).toMatch(/^3 to review$/);
    expect(within(el).getByTestId("rel-time").textContent).toBe(formatRelative(CREATED, NOW));
  });

  test.each(VIEWS)("on the %s, a passed build with shots to review reads changes", async (view) => {
    const el = await first([build({ status: "passed" })], view);
    expect(within(el).getByTestId("build-status").textContent).toBe("changes");
    expect(within(el).queryByText("passed")).toBeNull();
  });

  test.each(VIEWS)(
    "on the %s, a passed build with nothing to review reads passed",
    async (view) => {
      const counts = { ...emptyCounts(), unchanged: 4 };
      const el = await first([build({ status: "passed", counts })], view);
      expect(within(el).getByTestId("build-status").textContent).toBe("passed");
    },
  );
});
