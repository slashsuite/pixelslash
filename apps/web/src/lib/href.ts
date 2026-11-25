import { defaultStringifySearch } from "@tanstack/react-router";

/**
 * An in-app href for a route path, its params filled in, with the search and hash the router
 * itself would write. `@slashsuite/ui-react` links take a plain `href` and draw it through the
 * router's `<Link>` (the `LinkProvider` in `router.tsx`), so this is how a page names a route.
 */
export function hrefTo(
  path: string,
  params: Record<string, string> = {},
  { search, hash }: { search?: Record<string, unknown>; hash?: string } = {},
): string {
  const filled = path.replace(/\$(\w+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`hrefTo: no value for $${name} in ${path}`);
    return encodeURIComponent(value);
  });
  const query = search ? defaultStringifySearch(search) : "";
  return `${filled}${query}${hash ? `#${hash}` : ""}`;
}
