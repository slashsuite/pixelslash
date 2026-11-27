import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { memoryStore } from "#/api/test-support";
import { ServerTimer, timeIf, timedBlobs, withServerTiming } from "./server-timing";

/** The `Server-Timing` arithmetic on a fake clock: which part a stretch counts under, and how long. */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["performance"] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** A step that takes 5 ms on the fake clock, then fails. */
const failing = async () => {
  vi.advanceTimersByTime(5);
  throw new Error("r2 down");
};

/** A step that takes `ms` on the fake clock. */
const takes = (ms: number) => async () => {
  vi.advanceTimersByTime(ms);
  return ms;
};

describe("ServerTimer", () => {
  test("a part timed twice adds up, and total runs from the timer's creation, last", async () => {
    const timer = new ServerTimer();
    await timer.time("db", takes(3));
    vi.advanceTimersByTime(10);
    await timer.time("auth", takes(1.254));
    await timer.time("db", takes(4));
    vi.advanceTimersByTime(2);
    expect(timer.header()).toBe("db;dur=7, auth;dur=1.25, total;dur=20.25");
  });

  test("a step that throws is counted, and its error passes through", async () => {
    const timer = new ServerTimer();
    await expect(timer.time("blob", failing)).rejects.toThrow("r2 down");
    expect(timer.header()).toBe("blob;dur=5, total;dur=5");
  });

  test("a timer with no parts has only its total", () => {
    const timer = new ServerTimer();
    vi.advanceTimersByTime(8);
    expect(timer.header()).toBe("total;dur=8");
  });
});

describe("timeIf", () => {
  test("times under the part when there is a timer, and only runs the step without one", async () => {
    const timer = new ServerTimer();
    expect(await timeIf(timer, "measure", takes(6))).toBe(6);
    expect(await timeIf(undefined, "measure", takes(6))).toBe(6);
    expect(timer.header()).toBe("measure;dur=6, total;dur=12");
  });
});

describe("timedBlobs", () => {
  test("counts writes and existence checks under blob, and reads and deletes under nothing", async () => {
    const { store } = memoryStore();
    const slow = {
      ...store,
      put: async (...args: Parameters<typeof store.put>) => {
        vi.advanceTimersByTime(2);
        return store.put(...args);
      },
      has: async (key: string) => {
        vi.advanceTimersByTime(1);
        return store.has(key);
      },
      get: async (key: string) => {
        vi.advanceTimersByTime(50);
        return store.get(key);
      },
    };
    const timer = new ServerTimer();
    const blobs = timedBlobs(slow, timer);
    await blobs.put("a.png", new ArrayBuffer(1), "image/png");
    expect(await blobs.has("a.png")).toBe(true);
    await blobs.get("a.png");
    await blobs.delete("a.png");
    expect(timer.header()).toBe("blob;dur=3, total;dur=53");
  });

  test("without a timer the store is the one given", () => {
    const { store } = memoryStore();
    expect(timedBlobs(store, undefined)).toBe(store);
  });
});

describe("withServerTiming", () => {
  test("sets the header and leaves the status and body alone", async () => {
    const timer = new ServerTimer();
    vi.advanceTimersByTime(4);
    const res = withServerTiming(new Response("gone", { status: 404 }), timer);
    expect(res.status).toBe(404);
    expect(res.headers.get("server-timing")).toBe("total;dur=4");
    expect(await res.text()).toBe("gone");
  });
});
