// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import type { BuildTimings as CliTimings } from "#/db/diff-json";
import { must } from "#/test/must";
import { builds } from "#/db/schema";
import { CLI_TOTAL_NOTE, RERUN_NOTE } from "#/lib/timings";
import { keyValues } from "#/test/key-values";
import { render, screen } from "#/test/render";
import { seededStore } from "#/test/store";
import { BuildTimings } from "./build-timings";

/**
 * The build page's "This run" card as the page draws it, from a stored build row: the server's
 * steps and the re-run note, and the CLI's total and its note. The step words and the speed
 * profile's rows are `lib/timings`' and `lib/run-card`'s, tested there; this proves a stored row
 * reaches the card and what the card itself decides.
 */

const SENT: CliTimings = { totalMs: 900, captureMs: 400, shots: [] };

/** A real build row, as `buildView` selects it, with these columns set. */
async function build(over: Partial<typeof builds.$inferInsert>) {
  const { db, project } = await seededStore();
  await db.insert(builds).values({
    id: crypto.randomUUID(),
    projectId: project.id,
    commitSha: "a".repeat(40),
    branch: "work",
    status: "changes",
    ...over,
  });
  return must((await db.select().from(builds))[0], "the build row");
}

/** Draws the card for `row`, opens it, and returns its rows: Server, CLI and the rest. */
async function card(row: Awaited<ReturnType<typeof build>>) {
  const { user } = await render(
    <BuildTimings build={{ ...row }} shots={[]} defaultBranch="main" recaptures={null} />,
  );
  await user.click(screen.getByRole("button", { name: "This run" }));
  return keyValues();
}

const at = (ms: number) => new Date(1_700_000_000_000 + ms);

describe("a diffed build's timings card", () => {
  const ran = {
    queueMs: 1_200,
    diffMs: 3_400,
    processingStartedAt: at(0),
    finishedAt: at(3_500),
    timings: SENT,
  };

  test("a stored build's server steps reach the card: before diff, the diff and the total", async () => {
    const { Server } = await card(await build(ran));
    expect(Server).toMatch(/^before diff 1\.2.s\s*diff 3\.4.s\s*total from diff start 3\.5.s$/);
  });

  test("a first run has no re-run note, and a project with no model has no explanation or summary step", async () => {
    const { Server } = await card(await build(ran));
    expect(Server).not.toContain(RERUN_NOTE);
    expect(Server).not.toMatch(/AI explanations|AI summary/);
  });

  test("a build that took a second run says its numbers are the latest run's", async () => {
    const { Server } = await card(await build({ ...ran, rerun: true }));
    expect(Server).toContain(RERUN_NOTE);
  });

  test("the CLI's total is shown with the note that it is the wall clock", async () => {
    const { CLI } = await card(await build(ran));
    expect(CLI).toMatch(/total 900.ms/);
    expect(CLI).toContain(CLI_TOTAL_NOTE);
  });
});
