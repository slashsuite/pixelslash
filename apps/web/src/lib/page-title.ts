/**
 * A page's `document.title`: the page, then the org or project it belongs to, then the product,
 * joined with a middle dot (`Build feat/x · web · PixelSlash`). An empty part is left out, so a page
 * with none is plain `PixelSlash`.
 */
export function pageTitle(...parts: (string | null | undefined)[]): string {
  return [...parts.filter((part): part is string => Boolean(part)), "PixelSlash"].join(" · ");
}

/** What a route's `head` returns for that title. */
export const titled = (...parts: (string | null | undefined)[]) => ({
  meta: [{ title: pageTitle(...parts) }],
});
