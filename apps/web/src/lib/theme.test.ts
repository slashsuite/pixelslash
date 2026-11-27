// @vitest-environment happy-dom
import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { THEME_COOKIE, THEME_SCRIPT, parseTheme, rememberTheme } from "./theme";

/**
 * The script in <head> that picks the theme before first paint: a remembered choice beats the
 * system's `prefers-color-scheme`, and with no choice the page follows the system. The toggle,
 * the server-rendered class across a reload, and that no cookie is set until a choice, are the e2e
 * journey's (`e2e/theme.spec.ts`).
 */

/** Runs the script as the page does, with the system preferring `system`. */
function boot(system: "light" | "dark") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-color-scheme: dark)" && system === "dark",
  }));
  runInThisContext(THEME_SCRIPT);
  return themeOn();
}

/** The theme the page is in: the dark theme is `.dark` on <html>, the state the script sets. */
const themeOn = () => (document.documentElement.matches(".dark") ? "dark" : "light");

const clearCookie = () => {
  document.cookie = `${THEME_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
};

afterEach(() => {
  clearCookie();
  document.documentElement.removeAttribute("class");
  vi.unstubAllGlobals();
});

describe("the theme before first paint", () => {
  test.each(["light", "dark"] as const)("with no choice it follows a %s system", (system) => {
    expect(boot(system)).toBe(system);
  });

  test("a light choice beats a dark system", () => {
    rememberTheme("light");
    expect(boot("dark")).toBe("light");
  });

  test("a dark choice beats a light system", () => {
    rememberTheme("dark");
    expect(boot("light")).toBe("dark");
  });

  test("a cookie that names no theme is ignored", () => {
    document.cookie = `${THEME_COOKIE}=purple; Path=/`;
    expect(boot("dark")).toBe("dark");
    expect(parseTheme("purple")).toBeNull();
  });

  test("when the system's preference cannot be read, the page stays as the server rendered it", () => {
    vi.stubGlobal("matchMedia", () => {
      throw new Error("no media queries");
    });
    expect(() => runInThisContext(THEME_SCRIPT)).not.toThrow();
    expect(themeOn()).toBe("light");
  });
});
