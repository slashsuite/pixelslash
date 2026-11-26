import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { builds, snapshots } from "#/db/schema";
import { buildIdOf, cli, db, removeTemps, seed, serverUrl, tempDir } from "./harness";
import { WEB } from "./paths";

/**
 * A Storybook bundle rendered on the server, end to end on this machine: the real CLI sends a static
 * build with `upload --bundle`, the local build hands it to the self-host's renderer
 * (`deploy/ssh/render-worker.ts`, run as the unit runs it), which renders every story in Chromium
 * with the render token it was given, uploads the shots into the same build and finalises it.
 */

const story = (id: string, name: string) => [
  id,
  { type: "story", id, title: "UI/Card", name, importPath: "./card.stories.tsx", tags: [] },
];

const INDEX = {
  v: 5,
  entries: Object.fromEntries([
    story("ui-card--default", "Default"),
    story("ui-card--wide", "Wide"),
  ]),
};

/** Storybook's iframe, reduced to what capture reads: the body class and `#storybook-root`. */
const IFRAME = `<!doctype html><body class="sb-show-preparing" style="margin:0"><div id="storybook-root"></div>
<script>
const id = new URLSearchParams(location.search).get("id");
const width = id.endsWith("--wide") ? 160 : 60;
document.getElementById("storybook-root").innerHTML =
  "<div style='height:40px;width:" + width + "px;background:#08f'>" + id + "</div>";
document.body.className = "sb-show-main";
</script>`;

const CONFIG = {
  storybook: { url: "http://localhost:6006" },
  variants: [{ name: "desktop", viewport: { width: 200, height: 100 } }],
  flake: { retries: 0 },
};

let worker: ChildProcess | undefined;
let workerLog = "";

async function renderer(): Promise<ChildProcess> {
  const port = inject("renderPort");
  workerLog = join(tempDir("ps-render-log-"), "render.log");
  const out = openSync(workerLog, "w");
  const child = spawn("bun", ["deploy/ssh/render-worker.ts"], {
    cwd: WEB,
    env: {
      ...process.env,
      RENDER_API: serverUrl(),
      RENDER_HOST: "127.0.0.1",
      RENDER_PORT: String(port),
      RENDER_SCRATCH: tempDir("ps-render-scratch-"),
    },
    stdio: ["ignore", out, out],
  });
  for (let tries = 0; tries < 80; tries++) {
    const up = await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined);
    if (up?.ok) return child;
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill("SIGTERM");
  throw new Error(`the renderer did not come up: ${readFileSync(workerLog, "utf8")}`);
}

function storybookBuild() {
  const dir = tempDir("ps-render-bundle-");
  mkdirSync(join(dir, "sb"));
  writeFileSync(join(dir, "sb/index.json"), JSON.stringify(INDEX));
  writeFileSync(join(dir, "sb/iframe.html"), IFRAME);
  writeFileSync(join(dir, "pixelslash.config.json"), JSON.stringify(CONFIG));
  return dir;
}

/** The build's status once it has left `uploading`, or the last one read when 90 s pass. */
async function settled(id: string): Promise<{ status: string; error: string | null } | undefined> {
  for (let tries = 0; tries < 180; tries++) {
    const [row] = await db()
      .select({ status: builds.status, error: builds.error })
      .from(builds)
      .where(eq(builds.id, id));
    if (row && row.status !== "uploading") return row;
    await new Promise((r) => setTimeout(r, 500));
  }
  return undefined;
}

/**
 * The renderer's line for one build, or the whole log when 30 s pass without it. The build is
 * finalised inside the render and the line is written after it returns (the job's scratch is removed
 * in between), so a settled build does not yet mean a logged one.
 */
async function logged(id: string): Promise<string> {
  for (let tries = 0; tries < 300; tries++) {
    const log = readFileSync(workerLog, "utf8");
    const line = log.split("\n").find((l) => l.startsWith(`render ${id}: `));
    if (line !== undefined) return line;
    await new Promise((r) => setTimeout(r, 100));
  }
  return readFileSync(workerLog, "utf8");
}

beforeAll(async () => {
  worker = await renderer();
});

afterAll(async () => {
  const child = worker;
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }
  removeTemps();
});

describe("upload --bundle against the local build and its renderer", () => {
  test("the server renders every story and the build ends with their shots, as a client capture's would", async () => {
    const { token } = await seed();
    const dir = storybookBuild();
    const argv = [
      "upload",
      "--bundle",
      join(dir, "sb"),
      "--config",
      join(dir, "pixelslash.config.json"),
    ];
    const sent = cli([...argv, "--server", serverUrl(), "--branch", "local-build"], {
      PIXELSLASH_TOKEN: token,
    });
    expect({ code: sent.code, stderr: sent.stderr }).toMatchObject({ code: 0 });
    expect(sent.stdout).toMatch(/sent a bundle of 2 stories/);
    const id = buildIdOf(sent.stdout);
    expect(id).not.toBe("");

    const row = await settled(id);
    expect(row).toMatchObject({ error: null });
    expect(row?.status).not.toBe("errored");
    const shots = await db()
      .select({ name: snapshots.name, viewport: snapshots.viewport })
      .from(snapshots)
      .where(eq(snapshots.buildId, id))
      .orderBy(asc(snapshots.name));
    expect(shots.map((s) => s.name)).toEqual(["ui-card-default", "ui-card-wide"]);
    expect(await logged(id)).toMatch(new RegExp(`^render ${id}: 2 shots in [\\d.]+ s$`));
    expect(readFileSync(workerLog, "utf8")).not.toContain("psr_");
  }, 120_000);
});
