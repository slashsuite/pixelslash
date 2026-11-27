import { describe, expect, test } from "vitest";
import { movedTo } from "./moved";

const at = (href: string, method = "GET") => movedTo(new URL(href), method);
const APEX = "https://pixelslash.dev";

describe("movedTo", () => {
  test("sends the old site's pages to slashslash.build, query kept", () => {
    for (const page of ["/how-it-works", "/compare", "/pricing", "/security", "/self-host"]) {
      const to = `https://slashslash.build/pixelslash${page}`;
      expect(at(`${APEX}${page}`)).toBe(to);
      expect(at(`${APEX}${page}/`)).toBe(to);
      expect(at(`${APEX}${page}?ref=x`)).toBe(`${to}?ref=x`);
      expect(at(`${APEX}${page}`, "HEAD")).toBe(to);
    }
  });

  test("sends the docs, each doc, the search index and the sitemap", () => {
    expect(at(`${APEX}/docs`)).toBe("https://slashslash.build/pixelslash/docs");
    expect(at(`${APEX}/docs/`)).toBe("https://slashslash.build/pixelslash/docs");
    expect(at(`${APEX}/docs/upload`)).toBe("https://slashslash.build/pixelslash/docs/upload");
    expect(at(`${APEX}/docs/upload/?a=1`)).toBe(
      "https://slashslash.build/pixelslash/docs/upload?a=1",
    );
    expect(at(`${APEX}/search-index.json`)).toBe(
      "https://slashslash.build/pixelslash/search-index.json",
    );
    expect(at(`${APEX}/sitemap.xml`)).toBe("https://slashslash.build/sitemap.xml");
  });

  test("never redirects a POST, the app's own pages, or any other host", () => {
    expect(at(`${APEX}/api/v1/builds`, "POST")).toBeNull();
    expect(at(`${APEX}/docs`, "POST")).toBeNull();
    expect(at(`${APEX}/orgs`, "PUT")).toBeNull();
    expect(at(`${APEX}/`)).toBeNull();
    expect(at(`${APEX}/orgs?x=1`)).toBeNull();
    expect(at(`${APEX}/api/v1/me`)).toBeNull();
    expect(at(`${APEX}/docs/a/b`)).toBeNull();
    // The old app host is gone: nothing answers for it any more.
    expect(at("https://app.pixelslash.dev/orgs")).toBeNull();
    expect(at("http://192.168.0.10:8787/docs")).toBeNull();
    expect(at("http://localhost:3000/security")).toBeNull();
  });
});
