import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RENDER_UNIT, cleanup, deploy, pack, setup } from "./update-harness";

afterEach(cleanup);

const renderLines = (commands: string[]) =>
  commands.filter((line) => /pixelslash-render|playwright install/.test(line));

describe("update.sh and the bundle renderer", () => {
  test("a CT whose secrets name a renderer gets its Chromium and its unit, started after the web app", () => {
    const s = setup();
    writeFileSync(
      join(s.legacyWeb, ".dev.vars.e2e"),
      "IMAGE_SIGNING_SECRET=ct-secret\nRENDER_URL=http://127.0.0.1:3100/jobs\n",
    );
    const { status, stderr, commands } = deploy(s, pack("aaaaaaa", { render: true }));
    expect({ status, stderr }).toMatchObject({ status: 0 });
    expect(existsSync(join(s.unitDir, RENDER_UNIT))).toBe(true);
    const lines = renderLines(commands);
    expect(lines[0]).toMatch(/^bunx playwright install --with-deps chromium-headless-shell @ /);
    expect(lines.slice(1).map((l) => l.replace(/ @ .*/, ""))).toEqual([
      `chown -R pixelslash-render:pixelslash-render ${join(s.home, "..", "render-home")}`,
      "systemctl enable --quiet pixelslash-render",
      "systemctl restart pixelslash-render",
    ]);
    const web = commands.findIndex((l) => l.startsWith("systemctl restart pixelslash-stub"));
    const render = commands.findIndex((l) => l.startsWith("systemctl restart pixelslash-render"));
    expect(web).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(web);
  });

  test("without a RENDER_URL nothing of it is installed, and a unit left from before is retired", () => {
    const s = setup();
    const clean = deploy(s, pack("aaaaaaa", { render: true }));
    expect({ status: clean.status, stderr: clean.stderr }).toMatchObject({ status: 0 });
    expect(renderLines(clean.commands)).toEqual([]);
    expect(existsSync(join(s.unitDir, RENDER_UNIT))).toBe(false);

    writeFileSync(join(s.unitDir, RENDER_UNIT), "[Unit]\n");
    const retired = deploy(s, pack("bbbbbbb", { render: true }));
    expect({ status: retired.status, stderr: retired.stderr }).toMatchObject({ status: 0 });
    expect(renderLines(retired.commands).map((l) => l.replace(/ @ .*/, ""))).toEqual([
      "systemctl disable --now --quiet pixelslash-render",
    ]);
    expect(existsSync(join(s.unitDir, RENDER_UNIT))).toBe(false);
  });
});
