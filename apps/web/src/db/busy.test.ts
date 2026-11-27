import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { memoryStore } from "#/api/test-support";
import { type Uploads, diffFinalised, finalised, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { orgBlobs } from "#/storage/blobs";
import { retryBusy } from "./busy";
import type { Db } from "./db";
import { d1Db, seededStore } from "#/test/store";

/**
 * A deploy migrating the self-host's D1 holds its write lock, and SQLite answers SQLITE_BUSY (PS-228).
 * The retry is proved on a stand-in binding under fake timers; one run on a local D1 (miniflare)
 * proves the diff's writes go through it.
 */

const LOCKED = "D1_ERROR: database is locked: SQLITE_BUSY";

/** A binding whose every statement and batch throws `error` its first `failures` runs. */
function standIn(failures: number, error = LOCKED) {
  const state = { tries: 0 };
  const attempt = async () => {
    state.tries++;
    if (state.tries <= failures) throw new Error(error);
    return { results: [], success: true, meta: {} };
  };
  const statement = {
    bind: () => statement,
    run: attempt,
    all: attempt,
    raw: attempt,
    first: attempt,
  };
  const binding: unknown = { prepare: () => statement, batch: attempt };
  if (!isBinding(binding)) throw new Error("the stand-in is not a binding");
  return { binding, state };
}

/** Enough of a D1 binding for `retryBusy`: it reaches only `prepare` and `batch`. */
function isBinding(x: unknown): x is D1Database {
  return typeof x === "object" && x !== null && "prepare" in x && "batch" in x;
}

/** What a send rejected with, read as text; a send that resolved fails the test. */
const rejection = (sent: Promise<unknown>) =>
  sent.then(
    () => {
      throw new Error("the send resolved");
    },
    (e: unknown) => String(e),
  );

/** The two ways a write reaches the binding. */
const send = {
  statement: (d1: D1Database) => d1.prepare("update x set y = 1").run(),
  batch: (d1: D1Database) => d1.batch([]),
} as const;

describe("retryBusy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test.each([
    ["a statement busy twice, then free", "statement", 2, 3],
    ["a batch busy twice, then free", "batch", 2, 3],
    ["a statement free at once", "statement", 0, 1],
  ] as const)("%s resolves", async (_, via, failures, tries) => {
    const { binding, state } = standIn(failures);
    const sent = send[via](retryBusy(binding));
    await vi.runAllTimersAsync();
    await expect(sent).resolves.toMatchObject({ success: true });
    expect(state.tries).toBe(tries);
  });

  test.each([
    { what: "a statement busy for good", via: "statement", error: LOCKED, tries: 5 },
    { what: "a batch busy for good", via: "batch", error: LOCKED, tries: 5 },
    { what: "an error that is not a lock", via: "statement", error: "no such table", tries: 1 },
  ] as const)("$what rejects", async ({ via, error, tries }) => {
    const { binding, state } = standIn(Infinity, error);
    const settled = rejection(send[via](retryBusy(binding)));
    await vi.runAllTimersAsync();
    expect(await settled).toContain(error);
    expect(state.tries).toBe(tries);
  });

  test("waits 25, 50, 100 and 200 ms between its five tries", async () => {
    const { binding, state } = standIn(Infinity);
    const settled = rejection(send.statement(retryBusy(binding)));
    const seen: number[] = [];
    for (const wait of [25, 50, 100, 200]) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      seen.push(state.tries);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(await settled).toContain("SQLITE_BUSY");
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(state.tries).toBe(5);
  });
});

/**
 * The binding, but a statement whose SQL matches `sql`, or a batch holding one, throws SQLITE_BUSY its
 * every run.
 */
function locked(d1: D1Database, sql: RegExp) {
  const state = { tries: 0 };
  const busy = () => {
    state.tries++;
    throw new Error(LOCKED);
  };
  const statement = (inner: D1PreparedStatement, hit: boolean): D1PreparedStatement =>
    new Proxy(inner, {
      get(target, prop) {
        if (prop === "bind") return (...v: unknown[]) => statement(target.bind(...v), hit);
        const member = Reflect.get(target, prop, target);
        if (typeof member !== "function") return member;
        if (!hit || !["run", "all", "raw", "first"].includes(String(prop)))
          return member.bind(target);
        return async () => busy();
      },
    });
  const binding = new Proxy(d1, {
    get(target, prop) {
      if (prop === "prepare")
        return (query: string) => statement(target.prepare(query), sql.test(query));
      if (prop === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (statements.some((s) => sql.test(String(Reflect.get(s, "statement"))))) busy();
          return target.batch(statements);
        };
      const member = Reflect.get(target, prop, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { binding, state };
}

// The write the repro failed on: a shot's resolved diff, stored when the run starts measuring it.
const RESOLVED = /update "snapshots" set .*"resolved_diff"/;

/** The test's own local D1 with main's baseline and a finalised branch build; disposed when the test ends. */
async function branchOnD1() {
  const held = await d1Db();
  onTestFinished(() => held.dispose());
  const { db, org, project } = await seededStore<Db>({ db: held.db });
  const ctx: Uploads = { db, projectId: project.id, scoped: orgBlobs(memoryStore().store, org.id) };
  await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: shot() }] });
  const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
  const build = await finalised(ctx, {
    branch: "feat/b",
    commit: sha(3),
    mergeBase: sha(1),
    shots: [{ png: red }],
  });
  return { ctx, d1: held.d1, build };
}

describe("a D1 write that meets the lock (PS-228)", () => {
  // The setup's budget, which the shared hook had before each test owned its D1.
  test("busy for good: the build ends errored and names the lock", async () => {
    const { ctx, d1, build } = await branchOnD1();
    const { binding, state } = locked(d1, RESOLVED);
    const db: Db = drizzle(retryBusy(binding));

    const ended = await diffFinalised(ctx, build, { db });

    expect(ended.status).toBe("errored");
    expect(ended.error).toMatch(/SQLITE_BUSY/);
    // Bounded: the first try and one more after each of the four waits.
    expect(state.tries).toBe(5);
  }, 60_000);
});
