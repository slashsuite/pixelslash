import { describe, expect, test } from "vitest";
import { checkWorkflow } from "../check-workflows";

const wf = (on: string, runsOn: string) =>
  `name: t\non:\n${on}\njobs:\n  j:\n    runs-on: ${runsOn}\n    steps:\n      - run: echo\n`;

const call = (input: string) =>
  `on: push\njobs:\n  j:\n    uses: o/r/.github/workflows/x.yml@main\n    with:\n${input}`;

describe("check-workflows", () => {
  test("accepts a hosted runner and the allowed triggers", () => {
    const on =
      '  push:\n  pull_request:\n  workflow_dispatch:\n  workflow_call:\n  schedule:\n    - cron: "0 0 * * *"';
    expect(checkWorkflow("a.yml", wf(on, "ubuntu-latest"))).toEqual([]);
  });

  test("accepts a bare string trigger", () => {
    expect(
      checkWorkflow("a.yml", "name: t\non: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n"),
    ).toEqual([]);
  });

  test("refuses the proxmox runner", () => {
    expect(checkWorkflow("a.yml", wf("  push:", "proxmox"))).toHaveLength(1);
  });

  test("refuses a self-hosted runner in a label list", () => {
    expect(checkWorkflow("a.yml", wf("  push:", "[self-hosted, linux]"))).toHaveLength(1);
  });

  test("refuses a runs-on expression", () => {
    expect(checkWorkflow("a.yml", wf("  push:", "${{ vars.RUNNER }}"))).toHaveLength(1);
  });

  test("holds a reusable workflow's runs-on input to the same rule", () => {
    expect(checkWorkflow("a.yml", call("      paths: src"))).toEqual([]);
    expect(checkWorkflow("a.yml", call("      runs-on: proxmox"))).toHaveLength(1);
  });

  test.each([
    ['wrangler d1 export db --output "$RUNNER_TEMP/a.sql" > "$RUNNER_TEMP/log" 2>&1', 0],
    ["wrangler d1 export db --output x \\\n  &> /dev/null || status=$?", 0],
    ["# wrangler d1 export prints a link", 0],
    ["wrangler d1 export db --output x", 1],
    ["wrangler d1 export db --output x > /dev/null", 1],
    ["wrangler d1 export db --output x 2>&1", 1],
    ["wrangler d1 export db --output x 2> /dev/null", 1],
    // Redirects apply left to right: `2>&1 > f` points stderr at the log before stdout moves.
    ['wrangler d1 export db --output x 2>&1 > "$RUNNER_TEMP/log"', 1],
    ['wrangler d1 export db --output x >> "$RUNNER_TEMP/log" 2>&1', 0],
    ['wrangler d1 export db --output x > "${RUNNER_TEMP}/o" 2> "$RUNNER_TEMP/e"', 0],
    ["wrangler d1 export db --output x 2>/dev/null >/dev/null", 0],
    ["wrangler d1 export db --output x >& /dev/null", 0],
    ['> "$RUNNER_TEMP/log" 2>&1 wrangler d1 export db --output x', 0],
    // A digit glued to a word is part of it, and a comment's redirect is not one.
    ["wrangler d1 export db --output dump2>/dev/null >&2", 1],
    ['wrangler d1 export db --output x2>"$RUNNER_TEMP/e" 2>&1', 0],
    ["wrangler d1 export db --output x # &> /dev/null", 1],
    // A later redirect undoes an earlier sink.
    ["wrangler d1 export db --output x &> /dev/null 2>&1 2>&2 1>&2 >out.log", 1],
    ['wrangler d1 export db --output x > "$RUNNER_TEMP/log" 2>&1 2> err.log', 1],
    // Only the export's own redirects count, not the next command's.
    ['wrangler d1 export db --output x && echo ok > "$RUNNER_TEMP/log" 2>&1', 1],
    ["wrangler d1 export db --output x; echo ok &> /dev/null", 1],
    // A pipe takes stdout to another command; `|&` takes stderr too.
    ["wrangler d1 export db --output x 2> /dev/null | tee y", 1],
    ["wrangler d1 export db --output x 2> /dev/null |& cat", 1],
    ["wrangler d1 export db --output x &> /dev/null |& cat", 0],
  ])("checks that %s keeps the export off the log", (run, n) => {
    const text = `on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          ${run.replaceAll("\n", "\n          ")}\n`;
    expect(checkWorkflow("a.yml", text)).toHaveLength(n);
  });

  test.each([
    "pull_request_target",
    "workflow_run",
    "issue_comment",
    "pull_request_review_comment",
  ])("refuses the %s trigger", (trigger) => {
    const failures = checkWorkflow("a.yml", wf(`  push:\n  ${trigger}:`, "ubuntu-latest"));
    expect(failures).toEqual([`a.yml: triggers on ${trigger}`]);
  });
});
