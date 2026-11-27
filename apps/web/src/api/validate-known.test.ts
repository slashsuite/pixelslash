import { describe, expect, test } from "vitest";
import { BadRequest } from "./errors";
import { MAX_KNOWN, parseKnown } from "./validate-known";

/** The hashes one `/known` call asks about (PS-424). */

const many = (n: number) => Array.from({ length: n }, (_, i) => i.toString(16).padStart(64, "0"));

describe("parseKnown", () => {
  test("each hash is asked once, in the order first sent", () => {
    const [a = "", b = ""] = many(2);
    expect(parseKnown({ sha256: [a, b, a] })).toEqual([a, b]);
    expect(parseKnown({ sha256: [] })).toEqual([]);
  });

  test("takes MAX_KNOWN hashes, and refuses one more", () => {
    expect(parseKnown({ sha256: many(MAX_KNOWN) })).toHaveLength(MAX_KNOWN);
    expect(() => parseKnown({ sha256: many(MAX_KNOWN + 1) })).toThrow(BadRequest);
  });

  test.each([
    { why: "no list", body: {} },
    { why: "a hash that is not one", body: { sha256: ["not-a-hash"] } },
    { why: "an uppercase hash", body: { sha256: ["A".repeat(64)] } },
    { why: "a sha1", body: { sha256: ["a".repeat(40)] } },
    { why: "a number", body: { sha256: [7] } },
  ])("$why is refused", ({ body }) => {
    expect(() => parseKnown(body)).toThrow(BadRequest);
  });
});
