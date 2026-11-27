import { describe, expect, test } from "vitest";
import { belowMinimum } from "./cli-version";

/** The oldest CLI the API takes (ob 1729): only a `pixelslash/x.y.z` client below the minimum is refused. */

const from = (ua: string | null) =>
  new Request("http://app.test/api/v1/projects", {
    headers: ua === null ? {} : { "user-agent": ua },
  });

describe("belowMinimum", () => {
  test.each([
    { ua: "pixelslash/0.1.9", min: "0.2.0", below: true },
    { ua: "pixelslash/0.0.1", min: "0.2.0", below: true },
    { ua: "pixelslash/1.9.9", min: "2.0.0", below: true },
    { ua: "pixelslash/0.2.0", min: "0.2.0", below: false },
    { ua: "pixelslash/0.10.0", min: "0.2.0", below: false },
    { ua: "pixelslash/1.0.0", min: "0.2.0", below: false },
    { ua: "pixelslash/0.2.0 (linux)", min: "0.2.1", below: true },
    { ua: "pixelslash/0.1.0", min: "0.2", below: true },
    { ua: "curl/8.0", min: "0.2.0", below: false },
    { ua: "pixelslash/dev", min: "0.2.0", below: false },
    { ua: null, min: "0.2.0", below: false },
    { ua: "pixelslash/0.0.1", min: undefined, below: false },
    { ua: "pixelslash/0.0.1", min: "0.x.0", below: false },
  ])("$ua against $min is below: $below", ({ ua, min, below }) => {
    expect(belowMinimum(from(ua), min)).toBe(below);
  });
});
