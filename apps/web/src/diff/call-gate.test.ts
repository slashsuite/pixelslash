import { describe, expect, test } from "vitest";
import { type CallGate, callGate } from "./call-gate";

const LEASE_MS = 1000;

/** A clock that only moves when a waiter sleeps, so a test never waits on real time. */
function fakeTime() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      await Promise.resolve();
    },
  };
}

/** A call the test ends by hand, and the order calls began in. `began` resolves when the call runs. */
function started(gate: CallGate, order: string[], name: string) {
  const held = Promise.withResolvers<void>();
  const began = Promise.withResolvers<void>();
  const done = gate(async () => {
    order.push(name);
    began.resolve();
    await held.promise;
  });
  return { finish: held.resolve, done, began: began.promise };
}

/**
 * The gate's poll timer, counted and held: a waiter's sleep ends only when the test calls `tick`, and
 * a test awaits `polled(n)` to know the waiters have looked `n` times in all. No real time passes.
 */
function countedPolls() {
  let polls = 0;
  const waiters: { at: number; resolve: () => void }[] = [];
  let sleeping: (() => void)[] = [];
  return {
    sleep: () => {
      polls++;
      for (const w of waiters) if (polls >= w.at) w.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      sleeping.push(resolve);
      return promise;
    },
    /** End every sleep in progress: each waiter looks again. */
    tick: () => {
      const woken = sleeping;
      sleeping = [];
      for (const wake of woken) wake();
    },
    polled: (n: number) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push({ at: n, resolve });
      for (const w of waiters) if (polls >= w.at) w.resolve();
      return promise;
    },
  };
}

/** A sleep whose first call never returns (a cancelled waiter), and every later one is `sleep`. */
function firstSleepNeverEnds(sleep: (ms: number) => Promise<void>) {
  let polls = 0;
  return (ms: number) => (++polls === 1 ? new Promise<void>(() => {}) : sleep(ms));
}

describe("callGate", () => {
  test("runs one call at a time, in the order they came", async () => {
    const order: string[] = [];
    const { sleep, tick, polled } = countedPolls();
    const gate = callGate(1, LEASE_MS, { sleep });
    const a = started(gate, order, "a");
    const b = started(gate, order, "b");
    const c = started(gate, order, "c");
    // b and c each look while a runs, and neither is let in; then each looks again.
    await a.began;
    await polled(2);
    tick();
    await polled(4);
    expect(order).toEqual(["a"]);
    a.finish();
    await a.done;
    tick();
    await b.began;
    // c looks again while b runs.
    await polled(5);
    tick();
    await polled(6);
    expect(order).toEqual(["a", "b"]);
    b.finish();
    await b.done;
    tick();
    await c.began;
    expect(order).toEqual(["a", "b", "c"]);
    c.finish();
    await c.done;
  });

  test("a call that throws gives its place up and the throw reaches its caller", async () => {
    const gate = callGate(1, LEASE_MS);
    await expect(gate(() => Promise.reject(new Error("no")))).rejects.toThrow("no");
    await expect(gate(async () => "next")).resolves.toBe("next");
  });

  test("a call cancelled mid-run never finishes, and its lease lets the next one in", async () => {
    const time = fakeTime();
    const gate = callGate(1, LEASE_MS, time);
    void gate(() => new Promise(() => {})); // Its request is gone: no finally will ever run.
    await Promise.resolve();
    await expect(gate(async () => "next")).resolves.toBe("next");
    expect(time.now()).toBeGreaterThanOrEqual(LEASE_MS);
  });

  test("a call that renews at each yield keeps its turn past the lease; once it stops, the lease ends it", async () => {
    let t = 0;
    const gate = callGate(1, LEASE_MS, {
      now: () => t,
      sleep: async () => {
        await Promise.resolve();
      },
    });
    const order: string[] = [];
    const step = Promise.withResolvers<void>();
    void gate(async (renew) => {
      for (let i = 0; i < 5; i++) {
        t += LEASE_MS / 2;
        renew();
        await Promise.resolve();
      }
      order.push("long, still running");
      await step.promise; // Cancelled here: no more renewals and no finally.
    });
    const next = gate(async () => order.push("next"));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(order).toEqual(["long, still running"]);
    t += LEASE_MS + 1;
    await next;
    expect(order).toEqual(["long, still running", "next"]);
  });

  test("a waiter cancelled in the queue does not hold up the one behind it", async () => {
    const time = fakeTime();
    // The first waiter's poll never returns: its request was cancelled while it waited.
    const gate = callGate(1, LEASE_MS, { now: time.now, sleep: firstSleepNeverEnds(time.sleep) });
    const first = Promise.withResolvers<void>();
    const running = gate(() => first.promise);
    await Promise.resolve();
    void gate(async () => "cancelled before it ran");
    const behind = gate(async () => "behind");
    first.resolve();
    await running;
    await expect(behind).resolves.toBe("behind");
  });

  test("a live waiter that was thought gone joins again and still gets its turn", async () => {
    let t = 0;
    const gate = callGate(1, LEASE_MS, {
      now: () => t,
      sleep: async () => {
        // One long stall of the thread: every waiter looks gone at the next look.
        t += 6000;
        await Promise.resolve();
      },
    });
    const results = await Promise.all([
      gate(async () => "a"),
      gate(async () => "b"),
      gate(async () => "c"),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
  });
});
