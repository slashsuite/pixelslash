/**
 * Where an old address on pixelslash.dev now lives, or null when the app answers it as it is.
 *
 * pixelslash.dev used to serve the docs site, whose pages and files moved to slashslash.build, so
 * their old paths go there. Any other host (a self-host, a local build) is never redirected.
 */

const APEX = "pixelslash.dev";
const PAGES = "https://slashslash.build/pixelslash";

/** The old site's pages, each now under PAGES at the same path. */
const MOVED_PAGES = new Set(["/how-it-works", "/compare", "/pricing", "/security", "/self-host"]);

export function movedTo(url: URL, method: string): string | null {
  if (method !== "GET" && method !== "HEAD") return null;
  if (url.hostname !== APEX) return null;

  const path = url.pathname;
  const bare = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const site = siteAddress(bare);
  return site ? site + url.search : null;
}

/** The slashslash.build address of an old docs-site path (trailing slash already dropped). */
function siteAddress(path: string): string | null {
  if (MOVED_PAGES.has(path)) return PAGES + path;
  if (path === "/docs") return `${PAGES}/docs`;
  const slug = /^\/docs\/([^/]+)$/.exec(path)?.[1];
  if (slug) return `${PAGES}/docs/${slug}`;
  if (path === "/search-index.json") return `${PAGES}/search-index.json`;
  if (path === "/sitemap.xml") return "https://slashslash.build/sitemap.xml";
  return null;
}
