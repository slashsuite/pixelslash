import { describe, expect, test } from "vitest";
import { must } from "#/test/must";
import { parseTimings } from "./validate-timings";

/**
 * The CLI's timings (ob 1791) as finalize stores them: a body of the wrong shape is none, and each
 * extra added later is dropped alone when malformed. The finalize wiring is `handler.test.ts`'s.
 */

const settle = { fontsMs: 5, imagesMs: 6, networkIdleMs: 500, framesMs: 30, idleMs: 12 };
const profile = {
  totalMs: 2000,
  browserLaunchMs: 300,
  captureWallMs: 900,
  workers: { capture: 4, upload: 4 },
  host: { cores: 16, loadStart: 1.5, loadEnd: 3.25 },
  captureMs: 3200,
  navigateMs: 400,
  settleMs: 2500,
  screenshotMs: 200,
  setupMs: 60,
  storyMs: 120,
  measureMs: 40,
  settle,
  diffMs: 40,
  upload: {
    totalMs: 700,
    batches: [
      { step: "upload", count: 4, ms: 600, p50Ms: 140, p90Ms: 220, maxMs: 230, wallMs: 300 },
    ],
  },
  shots: [
    {
      name: "pricing",
      captureMs: 3200,
      diffMs: 40,
      navigateMs: 400,
      settleMs: 2500,
      screenshotMs: 200,
      setupMs: 60,
      storyMs: 120,
      measureMs: 40,
      settle,
    },
  ],
};

/** Timings with one upload batch whose server split is `server`. */
const withServer = (server: unknown) => ({
  totalMs: 100,
  upload: { totalMs: 50, batches: [{ step: "upload", count: 3, ms: 90, server }] },
  shots: [],
});
const batchOf = (server: unknown) => parseTimings(withServer(server))?.upload?.batches[0];

describe("parseTimings", () => {
  test("the full capture profile is kept whole", () => {
    expect(parseTimings(profile)).toEqual(profile);
  });

  test("a body of the old shape, with none of the extras, is kept as sent", () => {
    const old = {
      totalMs: 1200,
      captureMs: 800,
      upload: { totalMs: 300, batches: [{ step: "upload", count: 1, ms: 250 }] },
      shots: [{ name: "pricing", captureMs: 800 }],
    };
    expect(parseTimings(old)).toEqual(old);
  });

  test("an older CLI's settle split has no idle wait: kept without one, and a malformed one is dropped alone", () => {
    const { idleMs: _idle, ...olderSettle } = settle;
    const older = { totalMs: 1200, captureMs: 800, settle: olderSettle, shots: [] };
    expect(parseTimings(older)).toEqual(older);
    expect(parseTimings({ ...older, settle: { ...olderSettle, idleMs: "x" } })).toEqual(older);
  });

  test("each malformed extra is dropped on its own; the rest is kept", () => {
    const kept = parseTimings({
      ...profile,
      captureWallMs: "slow",
      workers: { capture: 0, upload: 4 },
      host: { cores: 16, loadStart: "high", loadEnd: 3 },
      storyMs: -5,
      settle: { fontsMs: 1 },
      upload: {
        totalMs: 700,
        batches: [{ step: "upload", count: 4, ms: 600, p50Ms: "x", p90Ms: 220, maxMs: -1 }],
      },
      shots: [{ name: "pricing", captureMs: 3200, setupMs: "x", measureMs: 40, settle: 3 }],
    });
    const {
      captureWallMs: _wall,
      host: _host,
      storyMs: _story,
      settle: _settle,
      ...rest
    } = profile;
    expect(kept).toEqual({
      ...rest,
      workers: { upload: 4 },
      upload: { totalMs: 700, batches: [{ step: "upload", count: 4, ms: 600, p90Ms: 220 }] },
      shots: [{ name: "pricing", captureMs: 3200, measureMs: 40 }],
    });
  });

  test.each([
    { why: "no timings", raw: undefined },
    { why: "text", raw: "slow" },
    { why: "a negative total", raw: { totalMs: -1, shots: [] } },
    { why: "no shots", raw: { totalMs: 5 } },
    { why: "a shot's step as text", raw: { totalMs: 5, shots: [{ name: "x", captureMs: "1" }] } },
    { why: "a shot with no name", raw: { totalMs: 5, shots: [{ captureMs: 1 }] } },
    { why: "a run step that is not a time", raw: { totalMs: 5, diffMs: Infinity, shots: [] } },
    { why: "an upload that is not one", raw: { totalMs: 5, upload: { totalMs: 1 }, shots: [] } },
    {
      why: "a malformed batch",
      raw: { totalMs: 5, upload: { totalMs: 1, batches: [{ step: "upload", ms: 1 }] }, shots: [] },
    },
  ])("$why is none", ({ raw }) => {
    expect(parseTimings(raw)).toBeNull();
  });

  test("a batch's server split is kept in whole ms", () => {
    expect(batchOf({ db: 21.6, blob: 3, total: 40 })).toEqual({
      step: "upload",
      count: 3,
      ms: 90,
      server: { db: 22, blob: 3, total: 40 },
    });
  });

  test("a server split keeps at most 16 parts, and drops a name over 32", () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, i]));
    const kept = batchOf({ ["x".repeat(33)]: 1, ...many });
    expect(Object.keys(must(kept?.server))).toEqual(Object.keys(many).slice(0, 16));
  });

  test.each([
    { why: "only bad parts", server: { ["x".repeat(33)]: 1, db: -4, blob: "slow" } },
    { why: "a Server-Timing header string", server: "db;dur=3" },
  ])("a server split of $why is dropped alone", ({ server }) => {
    expect(batchOf(server)).toEqual({ step: "upload", count: 3, ms: 90 });
  });
});
