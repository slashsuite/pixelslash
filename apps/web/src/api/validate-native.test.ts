import { describe, expect, test } from "vitest";
import { BadRequest } from "./errors";
import { fingerprint, platformAndBrowser } from "./validate-native";

/** Native snapshots (PS-293): which platform, browser and fingerprint values a snapshot key takes. */

const WEB_FINGERPRINT = { image: "img", browser: "chromium", fonts: "f" };

describe("platformAndBrowser", () => {
  test.each([
    { platform: "linux", browser: "chromium" },
    { platform: "android", browser: "Pixel 8 API 35" },
    { platform: "ios", browser: "x".repeat(80) },
  ])("$platform takes $browser", (key) => {
    expect(platformAndBrowser(key, "")).toEqual(key);
  });

  test.each([
    { why: "a web browser with a space", platform: "linux", browser: "my browser" },
    { why: "a web browser over 40", platform: "linux", browser: "x".repeat(41) },
    { why: "markup in a device", platform: "android", browser: "<b>" },
    { why: "a device with a leading space", platform: "android", browser: " Pixel" },
    { why: "an empty device", platform: "android", browser: "" },
    { why: "a device over 80", platform: "android", browser: "x".repeat(81) },
    { why: "a platform with a space", platform: "an droid", browser: "Pixel" },
    { why: "no platform", platform: undefined, browser: "chromium" },
  ])("$why is refused", ({ platform, browser }) => {
    expect(() => platformAndBrowser({ platform, browser }, "snapshots[0].")).toThrow(BadRequest);
  });

  test("the error names the field under its prefix", () => {
    expect(() =>
      platformAndBrowser({ platform: "linux", browser: "a b" }, "snapshots[2]."),
    ).toThrow(/snapshots\[2\]\.browser/);
  });
});

describe("fingerprint", () => {
  test("a web fingerprint keeps exactly its three fields", () => {
    expect(fingerprint({ ...WEB_FINGERPRINT, extra: "dropped" })).toEqual(WEB_FINGERPRINT);
  });

  test("a native fingerprint keeps its platform, device and scale", () => {
    const native = { ...WEB_FINGERPRINT, platform: "android", device: "Pixel 8", scale: "2.625" };
    expect(fingerprint(native)).toEqual(native);
  });

  test.each([
    { why: "a word for a scale", over: { scale: "big" } },
    { why: "a negative scale", over: { scale: "-2" } },
    { why: "a scale over 12 characters", over: { scale: "1.00000000000" } },
    { why: "markup in a device", over: { device: "<b>" } },
    { why: "a platform with a space", over: { platform: "an droid" } },
    { why: "no image", over: { image: undefined } },
    { why: "a font list over 300", over: { fonts: "f".repeat(301) } },
  ])("$why is refused", ({ over }) => {
    expect(() => fingerprint({ ...WEB_FINGERPRINT, ...over })).toThrow(BadRequest);
  });
});
