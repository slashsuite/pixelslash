import { PNG } from "pngjs";
import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureInto, RETRIED_ALONE } from "../src/capture-into.ts";
import { CaptureError } from "../src/errors.ts";
import { IMAGE_BROWSERS, parseConfig, type BrowserName } from "../src/config.ts";
import { compareSnapshots } from "../src/compare-snapshots.ts";
import { readManifest } from "../src/manifest.ts";
import { renderPixelReport } from "../src/report.ts";
import {
  captureSnapshots,
  openCaptureSession,
  recapture,
  type CaptureSession,
} from "../src/snapshot.ts";
import { cleanupDev, png, tmpDir } from "./dev-fixtures.ts";

/** A 16x16 solid red PNG. */
function red(): Buffer {
  const img = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < img.data.length; i += 4) img.data.set([255, 0, 0, 255], i);
  return PNG.sync.write(img);
}

const dirs: string[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    // An image whose request is never answered: the page loads, but never settles.
    if (path === "/never") return new Promise<Response>(() => {});
    // A red square far below the fold, loaded lazily: the browser does not start it on its own.
    if (path === "/red.png")
      return new Response(red(), { headers: { "content-type": "image/png" } });
    if (path === "/lazy")
      return new Response(
        '<!doctype html><body style="margin:0"><div style="height:6000px"></div><img src="/red.png" loading="lazy" width="16" height="16" style="display:block">',
        { headers: { "content-type": "text/html" } },
      );
    if (path === "/hangs")
      return new Response('<!doctype html><body><p>waiting</p><img src="/never">', {
        headers: { "content-type": "text/html" },
      });
    return new Response("<!doctype html><body><h1>Fixture</h1><p>Some text 🎨</p>", {
      headers: { "content-type": "text/html" },
    });
  },
});
afterAll(async () => {
  await server.stop(true);
  cleanupDev();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function out(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pixelslash-browsers-"));
  dirs.push(dir);
  return dir;
}

const pinned = { env: { PIXELSLASH_IMAGE_VERSION: "test" }, listFonts: async () => [] };
/** The settle timeout the never-settling page is given. */
const SETTLE_MS = 1_500;
const base = { baseUrl: `http://127.0.0.1:${server.port}` };

describe("a variant's browser", { timeout: 60_000 }, () => {
  test("defaults to chromium and names the variant by it; firefox and webkit are accepted", () => {
    const config = parseConfig({
      ...base,
      routes: ["/"],
      variants: [{}, { browser: "firefox" }, { browser: "webkit", theme: "dark" }],
    });
    expect(config.variants.map((v) => [v.name, v.browser])).toEqual([
      ["chromium-1280x720-light", "chromium"],
      ["firefox-1280x720-light", "firefox"],
      ["webkit-1280x720-dark", "webkit"],
    ]);
  });

  test("a manifest names only the browsers the image ships", async () => {
    const dir = await out();
    const config = parseConfig({ ...base, routes: ["/"] });
    const fake = fakeSession(config, ["chromium", "firefox"]);
    await captureInto(fake, dir);
    const file = Bun.file(join(dir, "manifest.json"));
    const manifest = await file.json();
    expect((await readManifest(dir)).snapshots.map((e) => e.variant.browser)).toEqual([
      "chromium",
      "firefox",
    ]);
    manifest.snapshots[0].variant.browser = "edge";
    await Bun.write(join(dir, "manifest.json"), JSON.stringify(manifest));
    await expect(readManifest(dir)).rejects.toThrow(/variant\.browser must be one of chromium/);
  });
});

/** A browserless session with one variant per browser, each fingerprinted by its own browser. */
function fakeSession(
  config: ReturnType<typeof parseConfig>,
  browsers: BrowserName[],
): CaptureSession {
  const withVariants = {
    ...config,
    variants: browsers.map((browser) => ({
      name: browser,
      browser,
      viewport: { width: 16, height: 16 },
      theme: "light" as const,
    })),
  };
  return {
    config: withVariants,
    routes: config.routes,
    fingerprintFor: (browser) => ({
      image: "version:test",
      browser: `${browser} 1`,
      fonts: "sha256:f",
    }),
    browserLaunchMs: 0,
    shoot: async () => ({ png: png(), ignore: [], media: [] }),
    flush: () => {},
    close: async () => {},
  };
}

describe("captureInto closes the pooled pages when its shots are taken", () => {
  test.each([
    [true, 1],
    [false, 0],
  ])("with reuse %s it releases them %i time(s)", async (reuse, times) => {
    const fake = fakeSession(parseConfig({ ...base, routes: ["/", "/a"] }), ["chromium"]);
    let released = 0;
    fake.releasePages = async () => {
      released++;
    };
    await captureInto(fake, await tmpDir(), 2, { reuse });
    expect(released).toBe(times);
  });
});

describe("one page × three browsers", { timeout: 60_000 }, () => {
  test("is three shots, each fingerprinted by the browser that took it", async () => {
    const config = parseConfig({ ...base, routes: ["/"] });
    const { manifest } = await captureInto(
      fakeSession(config, [...IMAGE_BROWSERS]),
      await tmpDir(),
    );
    expect(
      manifest.snapshots.map((e) => [e.variant.browser, e.fingerprint.browser, e.file]),
    ).toEqual([
      ["chromium", "chromium 1", "index/chromium.png"],
      ["firefox", "firefox 1", "index/firefox.png"],
      ["webkit", "webkit 1", "index/webkit.png"],
    ]);
  });

  test("a baseline is re-captured only in its own browser", async () => {
    const config = parseConfig({ ...base, routes: ["/"] });
    const fake = fakeSession(config, ["firefox"]);
    const used: string[] = [];
    fake.shoot = async (_, variant) => {
      used.push(variant.browser);
      return { png: png(), ignore: [], media: [] };
    };
    const variant = fake.config.variants[0]!;
    const entry = (browser: BrowserName) => ({ name: "index", variant: { ...variant, browser } });
    await recapture(fake, entry("firefox"));
    expect(used).toEqual(["firefox"]);
    // Same name, but the baseline was taken in another browser: the config no longer has it.
    expect(await recapture(fake, entry("webkit"))).toBeUndefined();
  });

  test("a compare matches a shot only against its own browser's baseline", async () => {
    const config = parseConfig({ ...base, routes: ["/"] });
    const [main, branch] = [await out(), await out()];
    await captureInto(fakeSession(config, ["chromium", "firefox"]), main);
    await captureInto(fakeSession(config, ["firefox", "webkit"]), branch);
    const result = await compareSnapshots({ mainDir: main, branchDir: branch, out: await out() });
    expect(result.unchanged.map((r) => r.shot)).toEqual([expect.stringContaining("firefox")]);
    expect(result.added.map((r) => r.shot)).toEqual([expect.stringContaining("webkit")]);
    expect(result.removed.map((r) => r.shot)).toEqual([expect.stringContaining("chromium")]);
  });

  test("the report names the browser on the shot", () => {
    const html = renderPixelReport({
      changedPixels: 0,
      regions: [],
      specks: { count: 0, pixels: 0 },
      browser: "firefox",
      main: { width: 4, height: 4 },
      branch: { width: 4, height: 4 },
    });
    expect(html).toContain("firefox · Main 4x4 · Branch 4x4");
  });
});

// Real-browser tests run on Chromium only; Firefox and WebKit are never used in testing.
describe("a real chromium", () => {
  const name = "chromium";
  test("captures a page, fingerprints itself, and writes the same bytes twice", async () => {
    const config = parseConfig({
      ...base,
      routes: ["/"],
      variants: [{ name: "small", browser: name, viewport: { width: 320, height: 200 } }],
    });
    const [a, b] = [await out(), await out()];
    const first = await captureSnapshots(config, a, pinned);
    await captureSnapshots(config, b, pinned);
    expect(first.manifest.snapshots[0]?.variant.browser).toBe(name);
    expect(first.manifest.snapshots[0]?.fingerprint.browser).toMatch(
      new RegExp(`^${name} \\d+\\.`),
    );
    const [left, right] = await Promise.all(
      [a, b].map((d) => Bun.file(join(d, "index/small.png")).bytes()),
    );
    expect(Buffer.compare(left ?? new Uint8Array(), right ?? new Uint8Array())).toBe(0);
    expect(left?.length).toBeGreaterThan(0);
  }, 60_000);

  test("a lazy image below the fold is loaded, not waited on forever, and is in the shot", async () => {
    const config = parseConfig({
      ...base,
      routes: ["/lazy"],
      variants: [{ name: "small", browser: name, viewport: { width: 320, height: 200 } }],
      stabilise: { timeoutMs: SETTLE_MS },
    });
    const session = await openCaptureSession(config, pinned);
    const dir = await out();
    try {
      await captureInto(session, dir, undefined, { warn() {} });
    } finally {
      await session.close();
    }
    const shot = PNG.sync.read(Buffer.from(await Bun.file(join(dir, "lazy/small.png")).bytes()));
    // Full page: the image sits at y 6000, past the distance chromium loads a lazy image ahead of the viewport, and is painted red.
    const scale = shot.width / 320;
    const y = Math.round(6008 * scale);
    const x = Math.round(8 * scale);
    const i = (y * shot.width + x) * 4;
    expect([...shot.data.subarray(i, i + 3)]).toEqual([255, 0, 0]);
  }, 60_000);

  test("fails a page that never settles with the settle timeout, not Playwright's", async () => {
    const config = parseConfig({
      ...base,
      routes: ["/hangs"],
      variants: [{ name: "small", browser: name, viewport: { width: 320, height: 200 } }],
      stabilise: { timeoutMs: SETTLE_MS },
    });
    // Proved from the error, not the clock. The settle gives up with `capture settle exceeded
    // <n>ms`; Playwright's own 30 s timeout would reject as `page.waitForFunction: Timeout
    // 30000ms exceeded`, so the message says which one ended the capture, however slow the host
    // is. The hang is paid twice (a shot that times out is retried alone once the run has
    // drained), so the second timeout carries `RETRIED_ALONE`.
    const session = await openCaptureSession(config, pinned);
    const dir = await out();
    let failure: unknown;
    try {
      failure = await captureInto(session, dir, undefined, { warn() {} }).then(
        () => undefined,
        (e: unknown) => e,
      );
    } finally {
      await session.close();
    }
    if (!(failure instanceof CaptureError))
      throw new Error(`expected the capture to reject with a CaptureError, got ${String(failure)}`);
    // Named, so a run of hundreds of shots says which one never settled (and in which variant).
    expect(failure.message).toMatch(
      /^hangs \(small: light, 320x200\): capture settle exceeded \d+ms/,
    );
    expect(failure.message.endsWith(RETRIED_ALONE)).toBe(true);
  }, 60_000);
});
