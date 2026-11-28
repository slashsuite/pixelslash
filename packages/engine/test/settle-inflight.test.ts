import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Browser } from "playwright";
import { PNG } from "pngjs";
import { launchBrowser } from "../src/capture.ts";
import { openPage, type ShotProgress } from "../src/capture-open.ts";
import { parseConfig } from "../src/config.ts";

// The CLI's shot path (`openPage`) against real Chromium: a page whose content arrives from a slow fetch is
// shot with it, a page that hydrates before it fetches is shot after the fetch, and a static page does not pay
// a fixed network or idle window, and an image the browser decodes off the main thread is shot painted.

/** The red of the large image below. */
const RED = [220, 20, 20] as const;

/**
 * A large solid red PNG: small on the wire, but tens of millions of pixels to decode, so with
 * `decoding="async"` the image has loaded well before it is decoded, and a frame painted in between
 * has a blank box where it goes. Built by hand rather than with pngjs, whose JavaScript row filters
 * took over a second here (and several on a loaded CI runner, past the test's limit): each row uses
 * the Sub filter, so after its first pixel every byte is zero, and the native deflate squeezes the
 * whole image in a few milliseconds. Built on its first request, so the other tests do not pay for it.
 */
let largeRed: Buffer | undefined;
/** One PNG chunk: length, type, data and the CRC of type and data. */
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(Bun.hash.crc32(body), 8 + data.length);
  return out;
}
function largeRedPng(): Buffer {
  if (largeRed) return largeRed;
  const side = 6_000;
  const row = Buffer.alloc(1 + side * 3);
  row[0] = 1; // Sub: each byte is stored as its difference from the pixel to its left.
  row.set(RED, 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, deflate, adaptive filtering, no interlace.
  return (largeRed = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: side }, () => row)))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}
const ASYNC_IMAGE = `<!doctype html><body style="margin:0;background:#fff">
  <img decoding="async" src="/large-red.png" style="display:block;width:400px;height:400px"></body>`;

/**
 * A page that renders "Loading...", then works the main thread for about 200ms in small slices posted
 * through a MessageChannel (as React's scheduler does while it hydrates, with no request in flight), and
 * only then fetches its data and renders it.
 */
const HYDRATING = `<!doctype html><body><p id="out">Loading...</p><script>
  const channel = new MessageChannel();
  const until = performance.now() + 200;
  channel.port1.onmessage = () => {
    const slice = performance.now() + 5;
    while (performance.now() < slice) {}
    if (performance.now() < until) return channel.port2.postMessage(null);
    fetch("/hydrated-data").then((r) => r.json()).then((d) => { document.getElementById("out").textContent = d.text; });
  };
  channel.port2.postMessage(null);
</script>`;

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/slow-data") {
      await Bun.sleep(300);
      return Response.json({ text: "arrived late" });
    }
    if (path === "/hydrated-data") return Response.json({ text: "hydrated and loaded" });
    if (path === "/large-red.png")
      return new Response(largeRedPng(), {
        headers: { "content-type": "image/png", "cache-control": "no-store" },
      });
    if (path === "/async-image")
      return new Response(ASYNC_IMAGE, { headers: { "content-type": "text/html" } });
    if (path === "/hydrating")
      return new Response(HYDRATING, { headers: { "content-type": "text/html" } });
    if (path === "/slow") {
      return new Response(
        `<!doctype html><body><p id="out">loading</p><script>
          fetch("/slow-data").then((r) => r.json()).then((d) => { document.getElementById("out").textContent = d.text; });
        </script>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    return new Response("<!doctype html><body><h1>Static</h1>", {
      headers: { "content-type": "text/html" },
    });
  },
});

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  await server.stop(true);
});

/** The CLI's own shot path: `openPage` attaches the tracker, navigates and settles. */
async function settled(path: string, { shoot = false } = {}) {
  const route = parseConfig({ baseUrl: `http://127.0.0.1:${server.port}`, routes: [path] })
    .routes[0]!;
  const page = await browser.newPage();
  try {
    const progress: ShotProgress = { step: "goto", crashed: false };
    const opened = await openPage(page, `http://127.0.0.1:${server.port}${path}`, route, {
      timeoutMs: 8_000,
      progress,
    });
    return {
      steps: opened.settle,
      text: await page.locator("body").innerText(),
      shot: shoot ? PNG.sync.read(await page.screenshot({ fullPage: true })) : undefined,
    };
  } finally {
    await page.close();
  }
}

describe("the in-flight settle in Chromium", () => {
  test("a page whose content comes from a fetch delayed 300ms is shot with that content", async () => {
    const { text } = await settled("/slow");
    expect(text).toContain("arrived late");
  });

  test("a page that fetches its data only after 200ms of main-thread work is shot with that data", async () => {
    const { text } = await settled("/hydrating");
    expect(text).toContain("hydrated and loaded");
  });

  test("an image with decoding=async is shot decoded, not as a blank box", async () => {
    const { shot } = await settled("/async-image", { shoot: true });
    if (!shot) throw new Error("no shot");
    // The middle of the 400px image.
    const at = (200 * shot.width + 200) * 4;
    expect([...shot.data.subarray(at, at + 3)]).toEqual([...RED]);
  });

  test("a static page's network and idle waits are each under 50ms", async () => {
    const { steps } = await settled("/");
    expect(steps.networkIdleMs).toBeLessThan(50);
    expect(steps.idleMs).toBeLessThan(50);
  });
});
