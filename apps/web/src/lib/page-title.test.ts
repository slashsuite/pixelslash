import { describe, expect, test } from "vitest";
import { pageTitle } from "./page-title";

describe("pageTitle", () => {
  test("the page, then its org or project, then the product", () => {
    expect(pageTitle("Members", "hackcove")).toBe("Members · hackcove · PixelSlash");
  });

  test("a page with no parts is the product alone", () => {
    expect(pageTitle()).toBe("PixelSlash");
  });

  test("an empty part is left out", () => {
    expect(pageTitle("Settings", undefined, "")).toBe("Settings · PixelSlash");
  });
});
