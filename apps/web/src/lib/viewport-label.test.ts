import { describe, expect, it } from "vitest";
import { viewportLabel } from "./viewport-label";

describe("viewportLabel", () => {
  it("names the class of screen and keeps the size", () => {
    expect(viewportLabel("390x844")).toBe("Phone 390x844");
    expect(viewportLabel("768x1024")).toBe("Tablet 768x1024");
    expect(viewportLabel("1280x800")).toBe("Desktop 1280x800");
  });

  it("splits at the breakpoints", () => {
    expect(viewportLabel("599x900")).toBe("Phone 599x900");
    expect(viewportLabel("600x900")).toBe("Tablet 600x900");
    expect(viewportLabel("1023x700")).toBe("Tablet 1023x700");
    expect(viewportLabel("1024x700")).toBe("Desktop 1024x700");
  });

  it("shows anything else as it came", () => {
    expect(viewportLabel("pixel-7")).toBe("pixel-7");
    expect(viewportLabel("")).toBe("");
  });
});
