import { describe, expect, test } from "vitest";
import { titled } from "./page-title";

const title = (...parts: (string | null | undefined)[]) => titled(...parts).meta[0]?.title;

describe("titled", () => {
  test("the page, then its org or project, then the product", () => {
    expect(title("Members", "hackcove")).toBe("Members · hackcove · PixelSlash");
  });

  test("a page with no parts is the product alone", () => {
    expect(title()).toBe("PixelSlash");
  });

  test("an empty part is left out", () => {
    expect(title("Settings", undefined, "")).toBe("Settings · PixelSlash");
  });
});
