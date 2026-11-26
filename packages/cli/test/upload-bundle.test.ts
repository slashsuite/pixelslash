import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { capture, cleanup, tmp } from "./support.ts";
import { fakeUploadApi, gitRepo } from "./upload-support.ts";

afterAll(cleanup);

const SERVER = "https://ps.example";
const CI = { PIXELSLASH_TOKEN: "psci_env" };

/** A repo with a config and a Storybook build of one story beside it. */
async function repoWithBundle(config: Record<string, unknown>) {
  const cwd = await gitRepo();
  await Bun.write(join(cwd, "pixelslash.config.json"), JSON.stringify(config));
  const index = {
    v: 5,
    entries: { "ui-card--default": { type: "story", id: "ui-card--default" } },
  };
  await Bun.write(join(cwd, "sb", "index.json"), JSON.stringify(index));
  await Bun.write(join(cwd, "sb", "iframe.html"), "<html></html>");
  return cwd;
}

describe("pixelslash upload --bundle", () => {
  test("opens a render build with the plan, sends the archive and finalises for the renderer", async () => {
    const cwd = await repoWithBundle({
      storybook: { url: "http://localhost:6006", include: ["ui-*"] },
      start: { command: "bun run storybook" },
    });
    const [api, cap] = [fakeUploadApi(), capture()];
    // `--bundle DIR` need not come first.
    const argv = ["upload", "--server", SERVER, "--bundle", "sb"];
    expect(await run(argv, cap.io, { fetch: api.fetch, cwd, env: CI })).toBe(0);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/v1/builds",
      "PUT /api/v1/builds/build-1/bundle",
      "POST /api/v1/builds/build-1/finalize",
    ]);
    const open = JSON.parse(api.calls[0]?.body ?? "{}");
    expect(open.render.kind).toBe("bundle");
    expect(open.render.plan.storybook).toEqual({ include: ["ui-*"] });
    expect(open).not.toHaveProperty("clientDiff");
    expect(JSON.parse(api.calls[2]?.body ?? "{}")).toEqual({ render: true });
    expect(cap.stdout).toMatch(/sent a bundle of 1 stories .*\nbuild: build-1/);
    expect(cap.stderr).toContain("start, storybook.url not sent");
  });

  test("a config with routes is refused before anything is sent", async () => {
    const cwd = await repoWithBundle({ storybook: {}, routes: [{ name: "home", path: "/" }] });
    const api = fakeUploadApi();
    const argv = ["upload", "--bundle", "sb", "--server", SERVER];
    await expect(run(argv, capture().io, { fetch: api.fetch, cwd, env: CI })).resolves.toBe(2);
    expect(api.calls).toEqual([]);
  });

  test("no config, or no DIR, is a usage error", async () => {
    const cwd = await tmp();
    const api = fakeUploadApi();
    for (const argv of [
      ["upload", "--bundle", "sb", "--server", SERVER],
      ["upload", "--bundle", "--server", SERVER],
    ]) {
      const cap = capture();
      expect(await run(argv, cap.io, { fetch: api.fetch, cwd, env: CI })).toBe(2);
    }
    expect(api.calls).toEqual([]);
  });
});
