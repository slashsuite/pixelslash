// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { builds } from "#/db/schema";
import { orgTimings } from "#/db/timings-stats";
import { render, screen, within } from "#/test/render";
import { seededStore } from "#/test/store";
import { TimingsPanel } from "./org-timings";

/**
 * The org's Timings tab, from the builds in the database to the page: a project row with its build
 * count and the median and slowest of a step, and a sentence, not a row of dashes, for a project
 * with no finished build. The statistics are `orgTimings`' own tests; which tail a step shows is
 * `lib/timings.test.ts`'s.
 */

const now = new Date("2026-10-24T12:00:00Z");

/** The table's body rows, each cell keyed by its column's header. */
function rows(): Record<string, string | null>[] {
  const [head, ...body] = screen.getAllByRole("row");
  const headers = head
    ? within(head)
        .getAllByRole("columnheader")
        .map((h) => h.textContent)
    : [];
  return body.map((row) =>
    Object.fromEntries(
      within(row)
        .getAllByRole("cell")
        .map((cell, i) => [headers[i] ?? String(i), cell.textContent]),
    ),
  );
}

describe("the Timings tab", () => {
  test("a project with finished builds shows its build count and a median over the slowest, marked max", async () => {
    const { db, user, org, project } = await seededStore({
      org: "Timings Co",
      projects: ["timed"],
    });
    for (const [i, diffMs] of [900, 1_400].entries()) {
      const end = new Date(now.getTime() - 1_000 * (i + 1));
      await db.insert(builds).values({
        id: crypto.randomUUID(),
        projectId: project.id,
        commitSha: "a".repeat(40),
        branch: "main",
        status: "passed",
        diffMs,
        processingStartedAt: new Date(end.getTime() - diffMs),
        finishedAt: end,
      });
    }
    await render(<TimingsPanel projects={await orgTimings(db, user.id, org.id, now)} />);
    // Every build ran the step, so no count sits beside the figures; no build summarised, so n/a.
    expect(rows()).toEqual([
      expect.objectContaining({
        Project: "timed",
        Builds: "2",
        // A duration's number and unit are joined by a no-break space.
        diff: expect.stringMatching(/^900.ms \/ 1\.4.s max$/),
        "total from diff start": expect.stringMatching(/^900.ms \/ 1\.4.s max$/),
        "AI summary": "n/a",
      }),
    ]);
  });

  test("with no finished build it says so in a sentence and draws no project row", async () => {
    const { db, user, org } = await seededStore({ org: "Timings Co", projects: ["timed"] });
    await render(<TimingsPanel projects={await orgTimings(db, user.id, org.id, now)} />);
    expect(screen.getByText(/No finished builds in the last 30 days/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
