import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RENDER_UNIT, bunxBody, cleanup, deploy, pack, serve, setup } from "./update-harness";

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

  test("a renderer that cannot be installed is left out; the release still serves", () => {
    const s = setup();
    writeFileSync(join(s.legacyWeb, ".dev.vars.e2e"), "RENDER_URL=http://127.0.0.1:3100/jobs\n");
    const failing = 'if [[ " $* " == *" playwright install "* ]]; then exit 1; fi';
    writeFileSync(join(s.stubs, "bunx"), `#!/usr/bin/env bash\n${bunxBody(failing)}\n`);
    const { status, stderr, commands } = deploy(s, pack("aaaaaaa", { render: true }));
    expect({ status, stderr }).toMatchObject({ status: 0 });
    expect(stderr).toContain("pixelslash-render was not installed");
    expect(existsSync(join(s.unitDir, RENDER_UNIT))).toBe(false);
    expect(
      commands.some((l) => l.startsWith("systemctl restart pixelslash-stub pixelslash-web")),
    ).toBe(true);
    expect(commands.some((l) => l.startsWith("systemctl restart pixelslash-render"))).toBe(false);
  });

  test("a rollback brings the web app back before it reinstalls the renderer", () => {
    const s = setup();
    writeFileSync(join(s.legacyWeb, ".dev.vars.e2e"), "RENDER_URL=http://127.0.0.1:3100/jobs\n");
    serve(s, "aaaaaaa", { render: true });
    const { status, commands } = deploy(s, pack("bbbbbbb", { broken: true, render: true }));
    expect(status).toBe(1);
    const at = (re: RegExp) => commands.findLastIndex((l) => re.test(l));
    const web = at(/^systemctl restart pixelslash-stub pixelslash-web /);
    expect(web).toBeGreaterThan(-1);
    expect(at(/^bunx playwright install /)).toBeGreaterThan(web);
    expect(at(/^systemctl restart pixelslash-render /)).toBeGreaterThan(web);
    expect(existsSync(join(s.unitDir, RENDER_UNIT))).toBe(true);
  });

  test("a renderer whose unit will not start is reported; the deploy still ends serving", () => {
    const s = setup();
    writeFileSync(join(s.legacyWeb, ".dev.vars.e2e"), "RENDER_URL=http://127.0.0.1:3100/jobs\n");
    writeFileSync(
      join(s.stubs, "systemctl"),
      '#!/usr/bin/env bash\necho "systemctl $* @ $PWD" >>"$STUB_LOG"\n[[ " $* " != *" pixelslash-render "* ]]\n',
    );
    const { status, stderr } = deploy(s, pack("aaaaaaa", { render: true }));
    expect({ status, stderr }).toMatchObject({ status: 0 });
    expect(stderr).toContain("pixelslash-render did not start");
    expect(stderr).toContain("release aaaaaaa is serving");
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

  test("a renderer in the middle of a build is restarted once it is done, without the deploy waiting", () => {
    const s = setup();
    writeFileSync(join(s.legacyWeb, ".dev.vars.e2e"), "RENDER_URL=http://127.0.0.1:3100/jobs\n");
    const { status, stderr, commands } = deploy(s, pack("aaaaaaa", { render: true }), {
      STUB_RENDER_HEALTH: '{"queued":4,"rendering":"b_1-x"}',
    });
    expect({ status, stderr }).toMatchObject({ status: 0 });
    expect(commands.some((l) => /^curl .*127\.0\.0\.1:3100\/health /.test(l))).toBe(true);
    expect(
      renderLines(commands)
        .filter((l) => l.startsWith("systemctl"))
        .map((l) => l.replace(/ @ .*/, "")),
    ).toEqual([
      "systemctl enable --quiet pixelslash-render",
      "systemctl restart --no-block pixelslash-render",
    ]);
    expect(stderr).toContain(
      "pixelslash-render is rendering build b_1-x: it restarts on this release once that build is rendered; its queue is kept",
    );
    expect(stderr).toContain("release aaaaaaa is serving");
  });

  test("an idle renderer is restarted and waited for, as before", () => {
    const s = setup();
    writeFileSync(join(s.legacyWeb, ".dev.vars.e2e"), "RENDER_URL=http://127.0.0.1:3100/jobs\n");
    const { status, stderr, commands } = deploy(s, pack("aaaaaaa", { render: true }), {
      STUB_RENDER_HEALTH: '{"queued":0,"rendering":null}',
    });
    expect({ status, stderr }).toMatchObject({ status: 0 });
    expect(commands.some((l) => l.startsWith("systemctl restart pixelslash-render "))).toBe(true);
    expect(stderr).not.toContain("is rendering build");
  });
});
