import { describe, expect, test } from "vitest";
import { BadRequest } from "./errors";
import { MAX_BATCH, parseBatch } from "./validate-batch";

/** What one batch request takes: each item is a PUT's meta with its sha256, and one bad item fails all. */

const SHA256 = "1".repeat(64);
const META = {
  name: "pricing",
  platform: "linux",
  browser: "chromium",
  viewport: "1280x720",
  theme: "light",
  fingerprint: { image: "img", browser: "chromium", fonts: "f" },
};

const shots = (n: number) => ({
  snapshots: Array.from({ length: n }, (_, i) => ({ ...META, name: `shot-${i}`, sha256: SHA256 })),
});

describe("parseBatch", () => {
  test("each item is parsed as a PUT's meta, with its hash and flaky policy", () => {
    const [held] = parseBatch({ snapshots: [{ ...META, sha256: SHA256, flaky: "skip" }] });
    expect(held).toMatchObject({
      sha256: SHA256,
      input: { name: "pricing", flaky: "skip", tags: [] },
    });
  });

  test("takes MAX_BATCH shots, and refuses one more", () => {
    expect(parseBatch(shots(MAX_BATCH))).toHaveLength(MAX_BATCH);
    expect(() => parseBatch(shots(MAX_BATCH + 1))).toThrow(BadRequest);
  });

  test.each([
    { why: "a hash that is not one", item: { ...META, sha256: "not-a-hash" } },
    { why: "no hash", item: META },
    { why: "an uppercase hash", item: { ...META, sha256: "A".repeat(64) } },
    { why: "a name that is not text", item: { ...META, name: 7, sha256: SHA256 } },
    { why: "a flake record", item: { ...META, flake: { runs: 2 }, sha256: SHA256 } },
    {
      why: "CI results",
      item: { ...META, ci: { engineVersion: "x", results: [] }, sha256: SHA256 },
    },
    { why: "an item that is not an object", item: "shot" },
  ])("$why fails the batch, naming the item", ({ item }) => {
    const good = { ...META, sha256: SHA256 };
    expect(() => parseBatch({ snapshots: [good, item] })).toThrow(/snapshots\[1\]/);
  });

  test.each([
    { why: "no list", body: {} },
    { why: "a list that is not one", body: { snapshots: "all" } },
    { why: "a body that is not an object", body: [] },
  ])("$why is refused", ({ body }) => {
    expect(() => parseBatch(body)).toThrow(BadRequest);
  });
});
