import { describe, expect, test } from "vitest";
import { BRIEF_LIMIT } from "@slashsuite/pixelslash-engine/brief";
import { BadRequest, Unprocessable } from "./errors";
import { brief } from "./validate-brief";

/** The uploader's brief (PS-232): trimmed, none when blank, a 400 when not text, a 422 past the limit. */

describe("brief", () => {
  test.each([
    { why: "absent is none", v: undefined, kept: null },
    { why: "null is none", v: null, kept: null },
    { why: "only spaces is none", v: "   ", kept: null },
    {
      why: "it is trimmed",
      v: "  Move the card's corner to red.\n",
      kept: "Move the card's corner to red.",
    },
    { why: "the limit itself is kept", v: "x".repeat(BRIEF_LIMIT), kept: "x".repeat(BRIEF_LIMIT) },
  ])("$why", ({ v, kept }) => {
    expect(brief(v)).toBe(kept);
  });

  test.each([
    { why: "a number", v: 7 },
    { why: "a list", v: ["brief"] },
    { why: "true", v: true },
  ])("$why is a 400", ({ v }) => {
    expect(() => brief(v)).toThrow(BadRequest);
  });

  test("one character past the limit is a 422", () => {
    expect(() => brief("x".repeat(BRIEF_LIMIT + 1))).toThrow(Unprocessable);
  });
});
