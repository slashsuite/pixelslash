import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { provisionByClicking } from "./ui-provision";
import { open } from "../../e2e/fixtures";
import { png } from "../../e2e/png";
import { SERVER, SERVER_PORT, STUB } from "../../e2e/ports";

/**
 * The Docker self-host (PS-240), end to end against the image: a fresh volume, sign-in through the
 * GitHub stand-in, a CLI upload that the container diffs, a restart, and the same rows and blobs
 * after it. The stand-in needs the `CLOUDFLARE_ENV=e2e` build (a production build refuses it,
 * PS-250), so the production image is checked separately: it sends sign-in to github.com.
 *
 * Sign-in behind TLS: a proxy in front of the container ends HTTPS, as a tunnel or a reverse proxy
 * does, and sends nothing that says so. `PIXELSLASH_PUBLIC_URL` is what tells the app its address,
 * and `PIXELSLASH_ALLOWED_GITHUB_LOGINS` who may sign in.
 *
 * Each test builds the image it needs (once per run) and removes its own containers, so any one of
 * them passes alone.
 */

const ROOT = resolve(import.meta.dirname, "../../../..");
const CLI = join(ROOT, "packages/cli/src/index.ts");
const RUN = `ps-self-host-e2e-${process.pid}`;
const WHITE = png(40, 40);
const CHANGED = png(40, 40, [{ x: 10, y: 10, w: 10, h: 10, rgb: [220, 30, 30] }]);
const MOVED = png(40, 40, [{ x: 20, y: 20, w: 10, h: 10, rgb: [30, 30, 220] }]);

function docker(...args: string[]): string {
  const res = spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`docker ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

const built = new Set<string>();

/** The image for a build env (`e2e`, or empty for production), built the first time a test asks. */
function image(cloudflareEnv: "e2e" | ""): string {
  const tag = cloudflareEnv ? "pixelslash-self-host:e2e" : "pixelslash-self-host:local";
  if (built.has(tag)) return tag;
  docker(
    "build",
    "-f",
    "docker/self-host/Dockerfile",
    "--build-arg",
    `CLOUDFLARE_ENV=${cloudflareEnv}`,
    "-t",
    tag,
    ".",
  );
  built.add(tag);
  return tag;
}

const containers: string[] = [];

/** Start a container on the host's network, removed after the test; returns its name. */
function start(name: string, tag: string, env: Record<string, string>, volume?: string) {
  const flags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const mount = volume ? ["-v", `${volume}:/data`] : [];
  containers.push(name);
  docker("run", "-d", "--name", name, "--network", "host", ...flags, ...mount, tag);
  return name;
}

/** The e2e image's container, signing in through the GitHub stand-in, with its state in the container. */
function startWithStub(name: string, env: Record<string, string>, volume?: string) {
  return start(
    name,
    image("e2e"),
    {
      PORT: String(SERVER_PORT),
      ...(volume ? {} : { PIXELSLASH_DATA_DIR: "/tmp/data" }),
      GITHUB_CLIENT_ID: "e2e-client",
      GITHUB_CLIENT_SECRET: "e2e-secret",
      GITHUB_OAUTH_BASE: STUB,
      GITHUB_API_BASE: STUB,
      ...env,
    },
    volume,
  );
}

async function up(url: string) {
  await expect
    .poll(async () => (await fetch(url).catch(() => null))?.status ?? 0, { timeout: 120_000 })
    .toBe(200);
}

const temps: string[] = [];
const closers: (() => Promise<void>)[] = [];
const volume = `${RUN}-data`;

// Every container holds the one port, so a test's own are gone before the next one starts.
test.afterEach(async () => {
  for (const name of containers.splice(0)) spawnSync("docker", ["rm", "-f", name]);
  await Promise.all(closers.splice(0).map((close) => close()));
});

test.afterAll(async () => {
  spawnSync("docker", ["volume", "rm", "-f", volume]);
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * An HTTPS proxy on a free port in front of the app, on a self-signed certificate for localhost:
 * the TLS end of a tunnel. It forwards each request as it came and adds no forwarded header.
 */
async function tlsProxy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ps-self-host-tls-"));
  temps.push(dir);
  const [key, cert] = [join(dir, "key.pem"), join(dir, "cert.pem")];
  const made = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ].concat(["-keyout", key, "-out", cert]),
    { encoding: "utf8" },
  );
  if (made.status !== 0) throw new Error(`openssl: ${made.stderr}`);
  const server = createHttpsServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (req, res) => {
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: SERVER_PORT,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on("error", () => res.writeHead(502).end());
      req.pipe(upstream);
    },
  );
  await new Promise<void>((listening) => server.listen(0, listening));
  closers.push(() => new Promise((closed) => server.close(() => closed())));
  const address = server.address();
  return `https://localhost:${typeof address === "object" && address ? address.port : 0}`;
}

/** A shot dir as `capture` writes it, holding one 40×40 shot. */
async function snapshotDir(shot: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), "ps-self-host-"));
  temps.push(dir);
  await mkdir(join(dir, "home"));
  await writeFile(join(dir, "home/desktop.png"), shot);
  const entry = {
    name: "home",
    path: "/",
    variant: {
      name: "desktop",
      browser: "chromium",
      viewport: { width: 40, height: 40 },
      theme: "light",
    },
    tags: ["web"],
    file: "home/desktop.png",
    fingerprint: { image: "version:e2e", browser: "chromium 1", fonts: "sha256:f" },
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ version: 1, snapshots: [entry] }));
  return dir;
}

/**
 * The real CLI uploads one shot; returns the build id it printed. On the default branch, which
 * accepts every shot, so each upload is the next one's baseline: on another branch a shot whose
 * change nobody decided is a baseline only for an unchanged shot (src/db/baselines.ts).
 */
async function upload(shot: Buffer, token: string): Promise<string> {
  const dir = await snapshotDir(shot);
  const res = spawnSync("bun", [CLI, "upload", dir, "--server", SERVER, "--branch", "main"], {
    cwd: ROOT,
    env: { ...process.env, PIXELSLASH_TOKEN: token },
    encoding: "utf8",
  });
  expect(res.status, res.stderr).toBe(0);
  return /build: (\S+)/.exec(res.stdout)?.[1] ?? "";
}

type Shot = { id: string; diff_status: string; diff_error: string | null; diff_result: unknown };

async function shotOf(buildId: string, token: string): Promise<Shot | undefined> {
  const res = await fetch(`${SERVER}/api/v1/builds/${buildId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const reply: { build: { snapshots: Shot[] } } = await res.json();
  return reply.build.snapshots[0];
}

test("signs in, takes an upload, diffs it, and keeps it all across a restart", async ({ page }) => {
  const name = startWithStub(`${RUN}-app`, {}, volume);
  await up(SERVER);

  const { token } = await provisionByClicking(page, "Self Co", "home");
  const first = await upload(WHITE, token);
  expect(await shotOf(first, token)).toMatchObject({ diff_status: "new" });
  const second = await upload(CHANGED, token);
  expect(await shotOf(second, token)).toMatchObject({
    diff_status: "changed",
    diff_error: null,
    diff_result: { changed_pixels: 100 },
  });
  // That diff ran in the one process: the container runs `start.ts` and the workerd it started,
  // and nothing else. A `bun -e` (this exec, or the image's health check) is left out, and so is a
  // `runc init`: that is how an exec docker is still starting shows in /proc before it runs its
  // command, and the health check's exec fires every 30 s, which is when this test gets here.
  const running: string[] = JSON.parse(
    docker(
      "exec",
      name,
      "bun",
      "-e",
      `const { readdirSync, readFileSync } = require("node:fs");
      const own = String(process.pid);
      const cmds = readdirSync("/proc").filter((p) => /^\\d+$/.test(p) && p !== own).map((p) => {
        try { return readFileSync("/proc/" + p + "/cmdline", "utf8").split("\\0").filter(Boolean).join(" "); }
        catch { return ""; }
      }).filter(Boolean);
      console.log(JSON.stringify(cmds));`,
    ),
  );
  expect(running.filter((cmd) => !/workerd|^bun -e |^runc init$/.test(cmd))).toEqual([
    "bun deploy/docker/start.ts",
  ]);

  docker("restart", name);
  await up(SERVER);
  // The rows, the session and the token are where they were.
  expect(await shotOf(second, token)).toMatchObject({ diff_status: "changed" });
  await open(page, "/orgs");
  await expect(page.getByRole("heading", { name: "Self Co" })).toBeVisible();
  // The blobs are still on the volume: the shot's PNG is served, and a new upload diffs against
  // a baseline read back from disk.
  const read = await fetch(`${SERVER}/api/v1/snapshots/${(await shotOf(second, token))?.id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const { snapshot }: { snapshot: { images: { head: string } } } = await read.json();
  const head = await fetch(snapshot.images.head);
  expect(head.status).toBe(200);
  expect(Buffer.from(await head.arrayBuffer()).equals(CHANGED)).toBe(true);
  const third = await upload(MOVED, token);
  expect(await shotOf(third, token)).toMatchObject({ diff_status: "changed", diff_error: null });
});

test("signs in behind an HTTPS proxy, with a Secure session cookie, when the login is allowed", async ({
  browser,
}) => {
  const publicUrl = await tlsProxy();
  startWithStub(`${RUN}-https`, {
    PIXELSLASH_PUBLIC_URL: publicUrl,
    // Case and spaces do not matter; the stand-in signs everyone in as e2e-octocat.
    PIXELSLASH_ALLOWED_GITHUB_LOGINS: "someone-else, E2E-Octocat",
  });
  await up(SERVER);
  const context = await browser.newContext({ baseURL: publicUrl, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await open(page, "/");
  const sent = page.waitForRequest((r) => r.url().startsWith(`${STUB}/login/oauth/authorize`));
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  // The callback GitHub is sent back to is the public URL, not the container's own address.
  const authorize = new URL((await sent).url());
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${publicUrl}/auth/github/callback`);
  await expect(page).toHaveURL(`${publicUrl}/orgs`);
  const session = (await context.cookies(publicUrl)).find((c) => c.name === "ps_session");
  expect(session).toMatchObject({ secure: true, httpOnly: true });
  await context.close();
});

test("refuses a GitHub login that is not on the allowlist", async ({ page }) => {
  startWithStub(`${RUN}-refused`, { PIXELSLASH_ALLOWED_GITHUB_LOGINS: "someone-else" });
  await up(SERVER);
  await open(page, "/");
  const callback = page.waitForResponse((r) => r.url().includes("/auth/github/callback"));
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  expect((await callback).status()).toBe(403);
  await expect(page.getByText("This server does not let @e2e-octocat sign in.")).toBeVisible();
  expect((await page.context().cookies()).map((c) => c.name)).not.toContain("ps_session");
});

// No browser: the production image is checked by its redirect alone.
test("the production image signs in through github.com", async () => {
  start(`${RUN}-prod`, image(""), {
    PORT: String(SERVER_PORT),
    PIXELSLASH_DATA_DIR: "/tmp/data",
    GITHUB_CLIENT_ID: "self-host-client",
    GITHUB_CLIENT_SECRET: "unused",
  });
  await up(SERVER);
  const res = await fetch(`${SERVER}/auth/github`, { redirect: "manual" });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(location.searchParams.get("client_id")).toBe("self-host-client");
});
