import { join, normalize, sep } from "node:path";

/** A static Storybook build served on loopback for one render; `stop` closes it. */
export type ServedBundle = { url: string; stop: () => Promise<void> };

/**
 * Serve `dir` on 127.0.0.1 at a free port, as a static host serves a Storybook build: a path that
 * ends in `/` is its `index.html`, a missing file is `404.html` (status 404) when the build has
 * one, and a path that would leave `dir` is refused. Only loopback: nothing else reaches it.
 */
export function serveBundle(dir: string): ServedBundle {
  const root = normalize(dir);
  const notFound = () => {
    const page = Bun.file(join(root, "404.html"));
    return page
      .exists()
      .then((has) =>
        has ? new Response(page, { status: 404 }) : new Response("not found", { status: 404 }),
      );
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      let path: string;
      try {
        path = decodeURIComponent(new URL(req.url).pathname);
      } catch {
        return new Response("bad path", { status: 400 });
      }
      if (path.endsWith("/")) path += "index.html";
      const full = normalize(join(root, path));
      if (full !== root && !full.startsWith(root + sep))
        return new Response("forbidden", { status: 403 });
      const file = Bun.file(full);
      return (await file.exists()) ? new Response(file) : notFound();
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}
