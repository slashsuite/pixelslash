import { afterAll, describe, expect, test } from "vitest";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { packBundle } from "../src/bundle-archive.ts";
import { renderPlan } from "../src/bundle-plan.ts";
import {
  RENDER_CANCELLED,
  renderBundle,
  renderConcurrency,
  reportRenderError,
} from "../src/render-bundle.ts";
import { isObj } from "../src/upload-client.ts";
import { type Call, fakeServer, metaOf } from "./fake-server.ts";
import { cleanup, tmp } from "./upload-fixtures.ts";

/** A render error sent to a server that answers with `fetch`, with no wait between tries. */
const report = (fetch: () => Promise<Response>) =>
  reportRenderError({ buildId: "b1", token: "psr_b1.sig" }, { server: "https://ps.example" }, "e", {
    fetch,
    sleep: async () => {},
  });

afterAll(cleanup);

const story = (id: string, title: string, name: string, tags: string[] = []) => [
  id,
  { type: "story", id, title, name, importPath: "./x.stories.tsx", tags },
];

const INDEX = {
  v: 5,
  entries: Object.fromEntries([
    story("ui-card--default", "UI/Card", "Default"),
    story("ui-card--broken", "UI/Card", "Broken"),
  ]),
};

/**
 * Storybook's iframe, reduced to what capture reads: the body class and `#storybook-root`. A
 * `--hang` story pings `beacon` once its page is up, then never settles.
 */
const iframe = (
  beacon = "",
) => `<!doctype html><body class="sb-show-preparing" style="margin:0"><div id="storybook-root"></div>
<pre id="error-message"></pre><script>
const id = new URLSearchParams(location.search).get("id");
if (id.endsWith("--hang")) {
  if (${JSON.stringify(beacon)}) fetch(${JSON.stringify(beacon)}, { mode: "no-cors" });
} else if (id.endsWith("--broken")) {
  document.getElementById("error-message").textContent = "Error: boom in " + id;
  document.body.className = "sb-show-errordisplay";
} else {
  document.getElementById("storybook-root").innerHTML = "<div style='height:40px;width:60px;background:#08f'>" + id + "</div>";
  document.body.className = "sb-show-main";
}
</script>`;

async function bundle(index: object = INDEX, beacon = ""): Promise<Uint8Array> {
  const dir = await tmp();
  await Bun.write(join(dir, "index.json"), JSON.stringify(index));
  await Bun.write(join(dir, "iframe.html"), iframe(beacon));
  return (await packBundle(dir)).gz;
}

const pinned = { env: { PIXELSLASH_IMAGE_VERSION: "test" }, listFonts: async () => [] };

/**
 * The API as the renderer meets it: the plan and bundle of build b1, baselines for none of its
 * shots, and each finalise answered with the next of `finalised`.
 */
async function api(exclude: string[], finalised: object[] = [{ status: "passed" }]) {
  let n = 0;
  const gz = await bundle();
  const { plan } = renderPlan({
    storybook: { url: "http://localhost:6006", exclude },
    variants: [{ name: "desktop", viewport: { width: 200, height: 100 } }],
    stabilise: { timeoutMs: 1_500 },
    flake: { retries: 0 },
  });
  return fakeServer((c: Call) => {
    if (c.method === "GET" && c.url.endsWith("/builds/b1/render")) return Response.json({ plan });
    if (c.method === "GET" && c.url.endsWith("/builds/b1/bundle")) return new Response(gz);
    if (c.url.endsWith("/baselines")) {
      const keys: unknown = isObj(c.body) ? c.body.keys : [];
      if (!Array.isArray(keys)) throw new Error("baselines: no keys");
      return Response.json({
        diff_location: "server",
        baselines: keys.map((key) => ({ key, baseline: null, carry: null, accepted: null })),
      });
    }
    if (c.url.endsWith("/finalize")) return Response.json(finalised[n++] ?? finalised.at(-1));
    return undefined;
  });
}

describe("renderConcurrency", () => {
  test("a plan that names none takes the renderer's own count, not one shot for a busy host", () => {
    expect(renderConcurrency(undefined, 4)).toBe(4);
  });

  test("a plan may ask for fewer than the renderer gives, never more", () => {
    expect(renderConcurrency(2, 4)).toBe(2);
    expect(renderConcurrency(10, 4)).toBe(4);
  });
});

describe("renderBundle", () => {
  test("shoots each story of the bundle and sends the shots into the build it was given", async () => {
    const fake = await api(["*--broken"]);
    const scratch = await tmp();
    const outcome = await renderBundle(
      { buildId: "b1", token: "psr_b1.sig" },
      { server: "https://ps.example", scratch, concurrency: 2 },
      { ...pinned, fetch: fake.fetch },
    );
    expect(outcome).toEqual({ ok: true, snapshots: 1 });
    expect(new Set(fake.calls.map((c) => c.auth))).toEqual(new Set(["Bearer psr_b1.sig"]));
    expect(fake.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/v1/builds"))).toBe(
      false,
    );
    const puts = fake.calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => metaOf(c.body).name)).toEqual(["ui-card-default"]);
    const finalize = fake.calls.find((c) => c.url.endsWith("/finalize"));
    expect(finalize?.body).toMatchObject({ snapshots: 1 });
    expect(await readdir(scratch)).toEqual([]);
  }, 60_000);

  test("finalises again while the server's diff stops at its ceiling with shots left, until it finishes", async () => {
    // A wide change: the diff ran out of budget twice with 61 left, then measured the rest.
    const ceiling = { id: "b1", status: "errored", error: "diff ceiling: 61 left", unmeasured: 61 };
    const done = { id: "b1", status: "changes", error: null, unmeasured: 0 };
    const fake = await api(["*--broken"], [ceiling, ceiling, done]);
    const warned: string[] = [];
    const outcome = await renderBundle(
      { buildId: "b1", token: "psr_b1.sig" },
      { server: "https://ps.example", scratch: await tmp() },
      { ...pinned, fetch: fake.fetch, sleep: async () => {}, warn: (m) => warned.push(m) },
    );
    expect(outcome).toEqual({ ok: true, snapshots: 1 });
    expect(fake.calls.filter((c) => c.url.endsWith("/finalize"))).toHaveLength(3);
    expect(fake.calls.some((c) => c.url.endsWith("/render-error"))).toBe(false);
    expect(warned.filter((m) => /^upload: 61 of \d+ shots still to measure/.test(m))).toHaveLength(
      2,
    );
  }, 60_000);

  test("a story that fails to render ends the build with a render error naming it", async () => {
    const fake = await api([]);
    const scratch = await tmp();
    const outcome = await renderBundle(
      { buildId: "b1", token: "psr_b1.sig" },
      { server: "https://ps.example", scratch },
      { ...pinned, fetch: fake.fetch },
    );
    expect(outcome.ok).toBe(false);
    const reported = fake.calls.find((c) => c.url.endsWith("/builds/b1/render-error"));
    expect(reported?.body).toMatchObject({ error: expect.stringMatching(/ui-card-broken.*boom/) });
    expect(fake.calls.some((c) => c.url.endsWith("/finalize"))).toBe(false);
    expect(await readdir(scratch)).toEqual([]);
  }, 60_000);

  test("a render the server ends stops mid-capture, sends nothing more and reports no error", async () => {
    const abort = new AbortController();
    // The cancel lands once the browser has the story open and the shot is waiting on it.
    let reached = false;
    const beacon = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        reached = true;
        abort.abort();
        return new Response(null, { status: 204 });
      },
    });
    const gz = await bundle(
      { v: 5, entries: Object.fromEntries([story("ui-card--hang", "UI/Card", "Hang")]) },
      `http://127.0.0.1:${beacon.port}/`,
    );
    const { plan } = renderPlan({
      storybook: { url: "http://localhost:6006" },
      variants: [{ name: "desktop", viewport: { width: 200, height: 100 } }],
      stabilise: { timeoutMs: 45_000 },
      flake: { retries: 0 },
    });
    const fake = fakeServer((c: Call) => {
      if (c.method === "GET" && c.url.endsWith("/builds/b1/render")) return Response.json({ plan });
      if (c.method === "GET" && c.url.endsWith("/builds/b1/bundle")) return new Response(gz);
      return undefined;
    });
    const scratch = await tmp();
    const started = performance.now();
    const outcome = await renderBundle(
      { buildId: "b1", token: "psr_b1.sig" },
      { server: "https://ps.example", scratch },
      { ...pinned, fetch: fake.fetch, signal: abort.signal },
    );
    await beacon.stop(true);
    expect(reached).toBe(true);
    expect(outcome).toEqual({ ok: false, error: RENDER_CANCELLED });
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(fake.calls.map((c) => c.url.replace("https://ps.example/api/v1/builds/b1", ""))).toEqual(
      ["/render", "/bundle"],
    );
    expect(await readdir(scratch)).toEqual([]);
  }, 60_000);

  test("a render already cancelled fetches the plan and nothing else", async () => {
    const fake = await api([]);
    const abort = new AbortController();
    abort.abort();
    const outcome = await renderBundle(
      { buildId: "b1", token: "psr_b1.sig" },
      { server: "https://ps.example" },
      { fetch: fake.fetch, signal: abort.signal },
    );
    expect(outcome).toEqual({ ok: false, error: RENDER_CANCELLED });
    expect(fake.calls).toHaveLength(1);
  });

  test("a job whose build id is not one is refused before any request", async () => {
    const fake = await api([]);
    const outcome = await renderBundle(
      { buildId: "../../x", token: "t" },
      { server: "https://ps.example" },
      { fetch: fake.fetch },
    );
    expect(outcome).toEqual({ ok: false, error: "render: not a build id" });
    expect(fake.calls).toEqual([]);
  });

  test("a build given up on is reported as a render error with its own token, and nothing else is sent", async () => {
    const fake = await api([]);
    const reached = await reportRenderError(
      { buildId: "b1", token: "psr_b1.sig" },
      { server: "https://ps.example/" },
      "the renderer stopped 3 times",
      { fetch: fake.fetch },
    );
    expect(reached).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      method: "POST",
      url: "https://ps.example/api/v1/builds/b1/render-error",
      auth: "Bearer psr_b1.sig",
      body: { error: "the renderer stopped 3 times" },
    });
    await reportRenderError(
      { buildId: "../x", token: "t" },
      { server: "https://ps.example" },
      "e",
      {
        fetch: fake.fetch,
      },
    );
    expect(fake.calls).toHaveLength(1);
  });

  test("a render error the server never answered is worth sending again; one it refused is not", async () => {
    expect(await report(() => Promise.reject(new Error("connection refused")))).toBe(false);
    expect(await report(async () => new Response("bad gateway", { status: 502 }))).toBe(false);
    expect(await report(async () => Response.json({ error: "not found" }, { status: 404 }))).toBe(
      true,
    );
  });
});
