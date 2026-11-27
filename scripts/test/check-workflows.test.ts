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
