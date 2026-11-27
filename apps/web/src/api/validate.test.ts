import { describe, expect, test } from "vitest";
import {
  BadRequest,
  MAX_ANCESTORS,
  isPng,
  parseCiInput,
  parseDiff,
  parseFinalise,
  parseNewBuild,
  parseRect,
  parseSnapshotInput,
  parseSnapshotKey,
  pngSize,
  projectName,
} from "./validate";

/** The upload API's parsers: what each takes and what it refuses, without a store. */

const SHA = "a".repeat(40);
const KEY = {
  name: "pricing",
  platform: "linux",
  browser: "chromium",
  viewport: "1280x720",
  theme: "light",
};
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG's first 24 bytes: the signature, then an IHDR chunk's length, type, width and height. */
function pngHead(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(24);
  bytes.set(SIGNATURE);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes.buffer;
}

const META = { ...KEY, fingerprint: { image: "img", browser: "chromium", fonts: "f" } };

describe("projectName", () => {
  test("is trimmed", () => {
    expect(projectName("  web  ")).toBe("web");
    expect(projectName("x".repeat(100))).toHaveLength(100);
  });

  test.each([
    { why: "no name", v: undefined },
    { why: "an empty name", v: "" },
    { why: "only spaces", v: "   " },
    { why: "a number", v: 3 },
    { why: "a name over 100", v: "x".repeat(101) },
  ])("$why is refused", ({ v }) => {
    expect(() => projectName(v)).toThrow(BadRequest);
  });
});

describe("parseNewBuild", () => {
  test("takes the commit, branch and lineage, and defaults what is absent", () => {
    expect(parseNewBuild({ commitSha: SHA, branch: "main" })).toEqual({
      commitSha: SHA,
      branch: "main",
      mergeBaseSha: null,
      ancestorShas: [],
      prNumber: null,
      ciRunId: null,
      brief: null,
    });
    const sha256 = "b".repeat(64);
    expect(
      parseNewBuild({
        commitSha: sha256,
        branch: "feat/x",
        mergeBaseSha: SHA,
        ancestorShas: Array(MAX_ANCESTORS).fill(SHA),
        prNumber: 7,
        ciRunId: 9,
      }),
    ).toMatchObject({ commitSha: sha256, mergeBaseSha: SHA, prNumber: 7, ciRunId: 9 });
  });

  test.each([
    { why: "a body that is not an object", body: "build" },
    { why: "a commit that is not a SHA", body: { commitSha: "xyz", branch: "main" } },
    { why: "an uppercase SHA", body: { commitSha: SHA.toUpperCase(), branch: "main" } },
    { why: "no branch", body: { commitSha: SHA } },
    { why: "a branch over 255", body: { commitSha: SHA, branch: "b".repeat(256) } },
    { why: "a bad merge base", body: { commitSha: SHA, branch: "main", mergeBaseSha: "no" } },
    {
      why: "ancestors past the cap",
      body: { commitSha: SHA, branch: "main", ancestorShas: Array(MAX_ANCESTORS + 1).fill(SHA) },
    },
    { why: "a bad ancestor", body: { commitSha: SHA, branch: "main", ancestorShas: ["no"] } },
    { why: "a zero PR number", body: { commitSha: SHA, branch: "main", prNumber: 0 } },
    { why: "a fractional CI run", body: { commitSha: SHA, branch: "main", ciRunId: 1.5 } },
    { why: "a brief that is not text", body: { commitSha: SHA, branch: "main", brief: 7 } },
  ])("$why is refused", ({ body }) => {
    expect(() => parseNewBuild(body)).toThrow(BadRequest);
  });
});

describe("parseDiff", () => {
  test("absent is {}, and each option is kept as sent", () => {
    expect(parseDiff(undefined)).toEqual({});
    const all = {
      threshold: 1,
      minChangedPixels: 0,
      minChangedRatio: 0.5,
      mergeDistance: 4,
      minRegionArea: 9,
      noiseAmplitude: 0,
      maxShift: 0.25,
    };
    expect(parseDiff(all)).toEqual(all);
  });

  test.each([
    { why: "a share over 1", diff: { threshold: 2 } },
    { why: "a noise amplitude over 1", diff: { noiseAmplitude: 2 } },
    { why: "a max shift over 1", diff: { maxShift: 2 } },
    { why: "a fractional count", diff: { mergeDistance: 2.5 } },
    { why: "a negative count", diff: { minRegionArea: -1 } },
    { why: "a count as text", diff: { minChangedPixels: "3" } },
    { why: "an infinite share", diff: { minChangedRatio: Infinity } },
    { why: "an unknown option", diff: { blur: 1 } },
    { why: "a number for the options", diff: 0.2 },
  ])("$why is refused", ({ diff }) => {
    expect(() => parseDiff(diff)).toThrow(BadRequest);
  });
});

describe("parseRect", () => {
  test("takes a rectangle at the origin of at least 1 by 1", () => {
    const rect = { x: 0, y: 0, width: 1, height: 1 };
    expect(parseRect({ ...rect, extra: true }, "ignore[0]")).toEqual(rect);
  });

  const box = { x: 1, y: 2, width: 3, height: 4 };
  test.each([
    { why: "a word", rect: "video" },
    { why: "a number", rect: 3 },
    { why: "a negative x", rect: { ...box, x: -1 } },
    { why: "a fractional y", rect: { ...box, y: 1.5 } },
    { why: "a zero width", rect: { ...box, width: 0 } },
    { why: "a height as text", rect: { ...box, height: "9" } },
  ])("$why is refused, naming where", ({ rect }) => {
    expect(() => parseRect(rect, "ignore[3]")).toThrow(/ignore\[3\]/);
  });
});

describe("parseSnapshotKey", () => {
  test("takes the name and the variant", () => {
    expect(parseSnapshotKey({ ...KEY, theme: "dark", viewport: "99999x1" })).toEqual({
      ...KEY,
      theme: "dark",
      viewport: "99999x1",
    });
  });

  test.each([
    { why: "a theme that is neither light nor dark", over: { theme: "sepia" } },
    { why: "a viewport that is not WxH", over: { viewport: "wide" } },
    { why: "a viewport side over five digits", over: { viewport: "100000x1" } },
    { why: "an empty name", over: { name: "" } },
    { why: "a name over 200", over: { name: "n".repeat(201) } },
  ])("$why is refused", ({ over }) => {
    expect(() => parseSnapshotKey({ ...KEY, ...over })).toThrow(BadRequest);
  });
});

describe("parseSnapshotInput", () => {
  test("an old client's meta (no tags, diff or ignore) defaults each", () => {
    expect(parseSnapshotInput(META)).toMatchObject({
      tags: [],
      diff: {},
      ignore: [],
      changeNote: null,
    });
  });

  test.each([
    { why: "tags that are not a list", over: { tags: "web" } },
    { why: "more than 50 tags", over: { tags: Array(51).fill("t") } },
    { why: "a tag over 100", over: { tags: ["t".repeat(101)] } },
    {
      why: "more than 200 ignore areas",
      over: { ignore: Array.from({ length: 201 }, () => ({ x: 0, y: 0, width: 1, height: 1 })) },
    },
    { why: "no fingerprint", over: { fingerprint: undefined } },
  ])("$why is refused", ({ over }) => {
    expect(() => parseSnapshotInput({ ...META, ...over })).toThrow(BadRequest);
  });

  // The judge's sentence (ob 1745) is only ever shown, so a malformed one is dropped, never refused.
  test.each([
    {
      why: "line breaks are folded and the full stop dropped",
      note: "  The button\nturned red. ",
      kept: "The button turned red",
    },
    { why: "a long note is cut to 300", note: "a".repeat(500), kept: "a".repeat(300) },
    { why: "only full stops is none", note: "...", kept: null },
    { why: "a number is none", note: 42, kept: null },
    { why: "only spaces is none", note: "   ", kept: null },
    { why: "null is none", note: null, kept: null },
  ])("the change note: $why", ({ note, kept }) => {
    expect(parseSnapshotInput({ ...META, changeNote: note }).changeNote).toBe(kept);
  });
});

describe("parseFinalise", () => {
  test("takes a count, and timings that do not parse are none", () => {
    expect(parseFinalise({ snapshots: 0 })).toEqual({ snapshots: 0, timings: null });
    expect(parseFinalise({ snapshots: 2, timings: "slow" })).toEqual({
      snapshots: 2,
      timings: null,
    });
  });

  test.each([
    { why: "no count", body: {} },
    { why: "a negative count", body: { snapshots: -1 } },
    { why: "a fractional count", body: { snapshots: 1.5 } },
    { why: "a body that is not an object", body: [1] },
  ])("$why is refused", ({ body }) => {
    expect(() => parseFinalise(body)).toThrow(BadRequest);
  });
});

describe("isPng and pngSize", () => {
  test("a PNG's signature and IHDR size are read", () => {
    const bytes = pngHead(1280, 720);
    expect(isPng(bytes)).toBe(true);
    expect(pngSize(bytes)).toEqual({ width: 1280, height: 720 });
  });

  test.each([
    { why: "nine bytes that are not a PNG", bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) },
    { why: "fewer than eight bytes", bytes: new Uint8Array([0x89, 0x50]) },
  ])("$why is not a PNG", ({ bytes }) => {
    expect(isPng(bytes.buffer)).toBe(false);
  });

  test("a signature with no IHDR, or a PNG with no pixels, is refused", () => {
    expect(() => pngSize(pngHead(1, 1).slice(0, 16))).toThrow(/too short/);
    expect(() => pngSize(pngHead(0, 720))).toThrow(/no pixels/);
  });
});

describe("parseCiInput", () => {
  const result = { baselineId: "b1", status: "unchanged", diffResult: {} };

  test("absent is none, and the envelope is kept with each result as sent", () => {
    expect(parseCiInput(undefined)).toBeNull();
    expect(parseCiInput({ engineVersion: "0.4.0", results: [result] })).toEqual({
      engineVersion: "0.4.0",
      results: [result],
    });
  });

  test.each([
    { why: "no results", ci: { engineVersion: "0.4.0", results: [] } },
    {
      why: "three results",
      ci: {
        engineVersion: "0.4.0",
        results: [result, { ...result, baselineId: "b2" }, { ...result, baselineId: "b3" }],
      },
    },
    { why: "one baseline twice", ci: { engineVersion: "0.4.0", results: [result, result] } },
    {
      why: "a baseline id with a slash",
      ci: { engineVersion: "0.4.0", results: [{ ...result, baselineId: "a/b" }] },
    },
    { why: "an engine version with a space", ci: { engineVersion: "0 4", results: [result] } },
  ])("$why is refused", ({ ci }) => {
    expect(() => parseCiInput(ci)).toThrow(BadRequest);
  });
});
