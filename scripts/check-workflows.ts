#!/usr/bin/env bun
// Keeps CI safe for a public repository.
//
// Usage: bun scripts/check-workflows.ts <file.yml>...
//
// A public repository runs a fork's pull request on our workflows, so:
//   - no job may run on a self-hosted runner: its `runs-on` must not name `proxmox` or `self-hosted`,
//     and must not be an expression (an expression could resolve to either); a job that calls a
//     reusable workflow (`uses:`) is held to the same rule on its `with: runs-on:` input, which is
//     how the UISlash review workflow picks its runner, and
//   - no workflow may trigger on anything but push, pull_request, workflow_dispatch, workflow_call or schedule
//     (never pull_request_target, workflow_run, issue_comment or any other trigger a fork can drive
//     with more than a read-only token).
// And since the logs of a public repository's runs are public:
//   - no step may let `wrangler d1 export` print to the log, since it prints a presigned link to the
//     whole dump: its stdout and stderr must go to a file under $RUNNER_TEMP or to /dev/null.
// Exits 1 if any rule fails.
import { basename } from "node:path";

// `schedule` runs only on the default branch, as the repository's own code, so no fork can drive it.
const ALLOWED_TRIGGERS = new Set([
  "push",
  "pull_request",
  "workflow_dispatch",
  "workflow_call",
  "schedule",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function triggers(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (isRecord(on)) return Object.keys(on);
  return [];
}

function forbiddenRunner(runsOn: unknown): boolean {
  const text = JSON.stringify(runsOn ?? "");
  return text.includes("proxmox") || text.includes("self-hosted") || text.includes("${{");
}

const EXPORT = /\bd1\s+export\b/;
const SINK = String.raw`"?(?:\$RUNNER_TEMP\/|\$\{RUNNER_TEMP\}\/|\/dev\/null)`;
const BOTH = new RegExp(`&>\\s*${SINK}`);
const STDOUT = new RegExp(`(?:^|[^2&])>\\s*${SINK}`);

/** Whether a shell line runs `d1 export` with its stdout or stderr left on the log. */
function exportLeaks(line: string): boolean {
  if (!EXPORT.test(line) || line.trimStart().startsWith("#")) return false;
  return !(BOTH.test(line) || (STDOUT.test(line) && line.includes("2>&1")));
}

/** The `d1 export` command lines in a job's `run` steps that print to the log. */
function leakingExports(job: Record<string, unknown>): string[] {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  return steps
    .flatMap((s: unknown) => (isRecord(s) && typeof s.run === "string" ? [s.run] : []))
    .flatMap((run) => run.replaceAll("\\\n", " ").split("\n"))
    .filter(exportLeaks);
}

/** What is wrong with one job: its runner, and a `d1 export` that prints to the log. */
function checkJob(name: string, id: string, job: Record<string, unknown>): string[] {
  const failures: string[] = [];
  const input = isRecord(job.with) ? job.with["runs-on"] : undefined;
  if (forbiddenRunner(job["runs-on"]) || forbiddenRunner(input))
    failures.push(`${name}: job ${id} runs on a self-hosted runner or an expression`);
  if (leakingExports(job).length)
    failures.push(`${name}: job ${id} lets wrangler d1 export print to the log`);
  return failures;
}

export function checkWorkflow(name: string, text: string): string[] {
  const wf: unknown = Bun.YAML.parse(text);
  const failures: string[] = [];
  if (!isRecord(wf)) return failures;
  // YAML 1.1 parsers read a bare `on:` key as boolean true; accept either spelling.
  const bad = triggers(wf.on ?? wf.true).filter((t) => !ALLOWED_TRIGGERS.has(t));
  if (bad.length) failures.push(`${name}: triggers on ${bad.join(", ")}`);
  const jobs = isRecord(wf.jobs) ? wf.jobs : {};
  for (const [id, job] of Object.entries(jobs)) {
    if (isRecord(job)) failures.push(...checkJob(name, id, job));
  }
  return failures;
}

if (import.meta.main) {
  const files = Bun.argv.slice(2);
  const failures: string[] = [];
  for (const f of files) {
    failures.push(...checkWorkflow(basename(f), await Bun.file(f).text()));
  }
  for (const line of failures) console.log(`FAIL ${line}`);
  console.log(`${files.length} workflow(s) read, ${failures.length} failure(s)`);
  process.exit(failures.length ? 1 : 0);
}
