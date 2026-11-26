import { afterAll, describe, expect, test } from "vitest";
import { mkdir, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { bundleSecrets, packBundle, readBundleIndex, unpackBundle } from "../src/bundle-archive.ts";
import { planConfig, renderPlan } from "../src/bundle-plan.ts";
import { serveBundle } from "../src/bundle-serve.ts";
import {
  BundleError,
  TAR_END,
  checkBundleStart,
  checkEntryPath,
  tarHeader,
  tarPadding,
} from "../src/bundle-tar.ts";
import { uploadBundle } from "../src/upload-bundle.ts";
import { type Call, fakeServer } from "./fake-server.ts";
import { cleanup, gitOpts, repo, tmp } from "./upload-fixtures.ts";

afterAll(cleanup);

const INDEX = {
  v: 5,
  entries: {
    "ui-button--primary": {
      type: "story",
      id: "ui-button--primary",
      title: "UI/Button",
      name: "Primary",
    },
    "ui-button--docs": { type: "docs", id: "ui-button--docs", title: "UI/Button", name: "Docs" },
  },
};

/** A Storybook build's shape: the index, an iframe page and a nested asset. */
async function storybookDir(index: unknown = INDEX): Promise<string> {
  const dir = await tmp();
  await Bun.write(join(dir, "index.json"), JSON.stringify(index));
  await Bun.write(join(dir, "iframe.html"), "<!doctype html><p>story</p>");
  await Bun.write(join(dir, "index.html"), "<!doctype html><p>manager</p>");
  await Bun.write(join(dir, "assets/a/main.js"), "console.log(1)");
  return dir;
}

/** A tar of `files` in the order given, gzipped: an archive the CLI would not write. */
function archive(files: [string, string][]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  for (const [path, text] of files) {
    const data = new TextEncoder().encode(text);
    parts.push(tarHeader(path, data.length), data, new Uint8Array(tarPadding(data.length)));
  }
  parts.push(TAR_END);
  const tar = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    tar.set(p, at);
    at += p.length;
  }
  return Bun.gzipSync(tar);
}

describe("the bundle archive", () => {
  test("packs index.json first, unpacks to the same files, and packs the same bytes twice", async () => {
    const dir = await storybookDir();
    const packed = await packBundle(dir);
    expect(packed).toMatchObject({ files: 4, stories: 1 });
    expect((await packBundle(dir)).gz).toEqual(packed.gz);
    expect(await checkBundleStart(packed.gz)).toEqual({ stories: 1 });
    const dest = join(await tmp(), "out");
    expect(await unpackBundle(packed.gz, dest)).toEqual({ stories: 1 });
    expect(await Bun.file(join(dest, "assets/a/main.js")).text()).toBe("console.log(1)");
    expect((await readdir(dest)).toSorted()).toEqual([
      "assets",
      "iframe.html",
      "index.html",
      "index.json",
    ]);
  });

  test("a directory with no index, or an index with no story, is refused by name", async () => {
    const empty = await tmp();
    await expect(readBundleIndex(empty)).rejects.toThrow(/index\.json is missing/);
    await expect(packBundle(await storybookDir({ v: 5, entries: {} }))).rejects.toThrow(
      /lists no stories/,
    );
    await expect(packBundle(await storybookDir({ stories: {} }))).rejects.toThrow(
      /needs Storybook 7/,
    );
  });

  test("a link in the build is refused, not followed", async () => {
    const dir = await storybookDir();
    await symlink("/etc/hostname", join(dir, "leak.txt"));
    await expect(packBundle(dir)).rejects.toThrow(/leak\.txt is not a regular file/);
  });

  test("the server's check reads the first entry only, and refuses what is not a bundle", async () => {
    await expect(checkBundleStart(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a gzip/);
    await expect(
      checkBundleStart(
        archive([
          ["iframe.html", "x"],
          ["index.json", JSON.stringify(INDEX)],
        ]),
      ),
    ).rejects.toThrow(/first entry must be index\.json/);
    await expect(checkBundleStart(archive([["index.json", "{"]]))).rejects.toThrow(/not JSON/);
    await expect(checkBundleStart(Bun.gzipSync(new Uint8Array(100)))).rejects.toThrow(BundleError);
  });

  test("an entry path that would leave the directory is refused, on pack and on unpack", async () => {
    for (const bad of ["../x", "/etc/passwd", "a/../../b", "a//b", "a\\b", "a/./b", ""])
      expect(() => checkEntryPath(bad)).toThrow(BundleError);
    expect(checkEntryPath("assets/a.js")).toBe("assets/a.js");
    // A hand-made header with `..` in it: written raw, past `tarHeader`'s own check.
    const raw = Bun.gunzipSync(archive([["index.json", JSON.stringify(INDEX)]]));
    const second = tarHeader("abcd/x.js", 1);
    second.set(new TextEncoder().encode("../x.js\0\0"), 0);
    second.fill(0x20, 148, 156);
    const sum = second.reduce((n, b) => n + b, 0);
    second.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    const end = raw.length - 1024;
    const forged = new Uint8Array(end + 512 + 512 + 1024);
    forged.set(raw.subarray(0, end));
    forged.set(second, end);
    forged.set(new TextEncoder().encode("y"), end + 512);
    await expect(unpackBundle(Bun.gzipSync(forged), join(await tmp(), "out"))).rejects.toThrow(
      /\.\. segment/,
    );
  });

  test("a value shaped like a credential is named by file and kind, never printed", async () => {
    const dir = await storybookDir();
    const key = `AKIA${"A".repeat(16)}`;
    await Bun.write(join(dir, "assets/env.js"), `const k = "${key}";`);
    await Bun.write(join(dir, "logo.png"), key);
    const found = await bundleSecrets(dir);
    expect(found).toEqual(["assets/env.js holds what looks like an AWS access key"]);
    expect(found.join("")).not.toContain(key);
  });
});

describe("the render plan", () => {
  const config = {
    storybook: { url: "http://localhost:6006", globals: { theme: ["light", "dark"] } },
    start: { command: "bun serve.ts", url: "http://localhost:6006" },
    variants: [{ name: "desktop", viewport: { width: 1280, height: 800 } }],
    ignore: ["video"],
    concurrency: 8,
  };

  test("carries the capture keys, drops the app's and checks it as the renderer will", () => {
    const { plan, notes } = renderPlan(config);
    expect(plan).toEqual({
      storybook: { globals: { theme: ["light", "dark"] } },
      variants: config.variants,
      ignore: ["video"],
      concurrency: 8,
    });
    expect(notes).toEqual([
      "bundle: start, storybook.url not sent: the server serves the bundle itself",
    ]);
    const parsed = planConfig(plan, "http://127.0.0.1:4000");
    expect(parsed.storybook?.url).toBe("http://127.0.0.1:4000");
    expect(parsed.start).toBeUndefined();
  });

  test("refuses what a bundle cannot render, by key", () => {
    expect(() => renderPlan({ routes: [] })).toThrow(/needs a storybook block/);
    expect(() => renderPlan({ ...config, routes: [{ path: "/", name: "home" }] })).toThrow(
      /routes does not go with --bundle/,
    );
    expect(() => renderPlan({ ...config, setup: { steps: [{ goto: "/" }] } })).toThrow(
      /setup does not go with --bundle/,
    );
    expect(renderPlan({ ...config, routes: [] }).plan).not.toHaveProperty("routes");
  });

  test("a plan the server holds is checked again: a key it does not carry is refused", () => {
    expect(() => planConfig({ storybook: {}, start: { command: "rm -rf /" } }, "http://x")).toThrow(
      /start is not a plan key/,
    );
    expect(() => planConfig({}, "http://x")).toThrow(/has no storybook block/);
  });
});

describe("serveBundle", () => {
  test("serves files, index.html for a directory, 404.html for a miss, and nothing outside", async () => {
    const dir = await storybookDir();
    await Bun.write(join(dir, "404.html"), "gone");
    await mkdir(join(dir, "docs"));
    await Bun.write(join(dir, "docs/index.html"), "docs");
    const served = serveBundle(dir);
    try {
      const get = (path: string) => fetch(`${served.url}${path}`);
      expect(await (await get("/iframe.html")).text()).toContain("story");
      expect(await (await get("/docs/")).text()).toBe("docs");
      const miss = await get("/nope.js");
      expect([miss.status, await miss.text()]).toEqual([404, "gone"]);
      expect((await get("/..%2f..%2fetc%2fhostname")).status).toBe(403);
      expect(new URL(served.url).hostname).toBe("127.0.0.1");
    } finally {
      await served.stop();
    }
  });
});

describe("uploadBundle", () => {
  test("opens a render build with the plan, sends the archive, then finalises to render", async () => {
    const { dir: cwd } = await repo(1, 1);
    const bundle = await storybookDir();
    const fake = fakeServer();
    const warned: string[] = [];
    const result = await uploadBundle(
      {
        bundle,
        config: { storybook: { url: "http://localhost:6006" } },
        server: "https://ps.example/",
        token: "psci_t",
        git: gitOpts(cwd),
        subproject: "web",
      },
      { fetch: fake.fetch, warn: (m) => warned.push(m) },
    );
    expect(result).toMatchObject({ buildId: "b1", stories: 1, files: 4 });
    const calls = fake.calls.map((c: Call) => `${c.method} ${c.url}`);
    expect(calls).toEqual([
      "POST https://ps.example/api/v1/builds",
      "PUT https://ps.example/api/v1/builds/b1/bundle",
      "POST https://ps.example/api/v1/builds/b1/finalize",
    ]);
    const [open, put, finalize] = fake.calls;
    expect(open?.body).toMatchObject({
      subproject: "web",
      render: { kind: "bundle", plan: { storybook: {} } },
    });
    expect(open?.body).not.toHaveProperty("clientDiff");
    const sent = put?.body;
    if (!(sent instanceof Blob)) throw new Error("the bundle was not sent as bytes");
    expect(await checkBundleStart(new Uint8Array(await sent.arrayBuffer()))).toEqual({
      stories: 1,
    });
    expect(finalize?.body).toEqual({ render: true });
    expect(warned).toEqual(["bundle: storybook.url not sent: the server serves the bundle itself"]);
  });

  test("a directory that is not a build fails before any request", async () => {
    const fake = fakeServer();
    const bundleless = await tmp();
    await expect(
      uploadBundle(
        {
          bundle: bundleless,
          config: { storybook: {} },
          server: "https://ps.example",
          token: "t",
          git: gitOpts(bundleless),
        },
        { fetch: fake.fetch },
      ),
    ).rejects.toThrow(/index\.json is missing/);
    expect(fake.calls).toEqual([]);
  });
});
