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
//     whole dump: its stdout and stderr must go to a file under $RUNNER_TEMP or to /dev/null. The
//     command's redirects are followed in order, as the shell does, so `2>&1 > file` (which leaves
//     stderr on the log) fails where `> file 2>&1` passes.
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
const SINK = /^["']?(?:\$RUNNER_TEMP\/|\$\{RUNNER_TEMP\}\/|\/dev\/null\b)/;
// A command list's separators, longest first, so `||` is not read as two pipes.
// A lone `&` (run in the background) ends a command too; the `&` of `&>`, `>&` and `2>&1` does not.
const SEPARATOR = /(\|\||&&|\|&|;|\||(?<![>&])&(?![>&]))/;
// A redirect: `&>`, `&>>`, `>&` or `[n]>`, `[n]>>`, `[n]>&`, then its target. The shell reads n as a
// descriptor only when it is a whole word up to the `>`: `dump2>f` is the word `dump2` and then `>f`,
// and `10>f` is descriptor 10, never `>f` after a `10`.
const REDIRECT = /(&>>?|(?:(?<!\S)(\d+)|(?<!(?<!\S)\d+))>>?(&?))\s*("[^"]*"|'[^']*'|[^\s;|&<>]+)/g;
// A comment to the end of the line: the shell never reads a redirect in it.
const COMMENT = /(?:^|\s)#.*$/;

/** Where a file descriptor points: a sink, the log, or anywhere else (a file, a pipe). */
type Fd = "sink" | "log" | "other";

const target = (word: string): Fd => (SINK.test(word) ? "sink" : "other");

/** Which of stdout (0) and stderr (1) a redirect's number names, if either. */
function fdIndex(n: string): 0 | 1 | undefined {
  if (n === "" || n === "1") return 0;
  return n === "2" ? 1 : undefined;
}

/** Where `[n]>&word` points its descriptor, given where stdout and stderr point now. */
function dupTarget(fd: [Fd, Fd], word: string): Fd {
  if (word === "-") return "sink"; // closed
  if (word === "1") return fd[0];
  if (word === "2") return fd[1];
  return "other";
}

/** Whether a redirect points both stdout and stderr: `&>word`, `&>>word` and `>&word`. */
const both = (op: string, n: string, dup: string, word: string): boolean =>
  op.startsWith("&") || (dup !== "" && n === "" && !/^(?:\d+|-)$/.test(word));

/** Applies one redirect to stdout and stderr. */
function redirect(fd: [Fd, Fd], match: RegExpMatchArray): void {
  const [, op = "", n = "", dup = "", word = ""] = match;
  if (both(op, n, dup, word)) {
    fd[0] = fd[1] = target(word);
    return;
  }
  const i = fdIndex(n);
  if (i !== undefined) fd[i] = dup ? dupTarget(fd, word) : target(word);
}

/** Where stdout and stderr of the command in `segment` end up, its redirects applied left to right. */
function outputs(segment: string, piped: "" | "|" | "|&"): [Fd, Fd] {
  // A pipe is connected before the command's own redirects, and `|&` joins stderr to it after them.
  const fd: [Fd, Fd] = [piped ? "other" : "log", "log"];
  for (const match of segment.matchAll(REDIRECT)) redirect(fd, match);
  if (piped === "|&") fd[1] = fd[0];
  return fd;
}

/** Whether a shell line runs `d1 export` with its stdout or stderr left on the log. */
function exportLeaks(line: string): boolean {
  if (!EXPORT.test(line) || line.trimStart().startsWith("#")) return false;
  // Only after the export: a `#` before it may sit inside quotes.
  const at = line.search(EXPORT);
  const parts = (line.slice(0, at) + line.slice(at).replace(COMMENT, "")).split(SEPARATOR);
  // Even indices are commands, odd ones the separators between them.
  return parts.some((part, i) => {
    if (i % 2 || !EXPORT.test(part)) return false;
    const next = parts[i + 1];
    const piped = next === "|" || next === "|&" ? next : "";
    return outputs(part, piped).some((f) => f !== "sink");
  });
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
