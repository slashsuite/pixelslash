import { describe, expect, test } from "vitest";
import {
  type Send,
  type SizeAlertBody,
  checkDatabaseSize,
  overAlertLine,
  shareLabel,
  webhookPost,
} from "./size-alert";

const GB = 1e9;
const NOW = new Date("2026-10-28T12:00:00Z");

/** The deps with a recording webhook and an in-memory day marker. */
function harness(bytes: number, { webhook = true, fail = false } = {}) {
  const sent = new Set<string>();
  const posts: SizeAlertBody[] = [];
  const lines: string[] = [];
  const at = (now: Date) => ({
    bytes: { ok: true as const, value: bytes },
    now,
    log: (line: string) => lines.push(line),
    ...(webhook && {
      post: async (body: SizeAlertBody) => {
        if (fail) throw new Error("HTTP 500");
        posts.push(body);
      },
    }),
    alreadySent: async (day: string) => sent.has(day),
    markSent: async (day: string) => void sent.add(day),
  });
  return { at, posts, lines, sent };
}

/** A webhook that answers each call with the next of `statuses`, recording what it was sent. */
function answering(statuses: number[]) {
  const calls: [string, Parameters<Send>[1]][] = [];
  const send: Send = async (url, init) => {
    calls.push([url, init]);
    return new Response(null, { status: statuses[calls.length - 1] ?? 500 });
  };
  return { send, calls };
}

describe("the alert line and its words", () => {
  test.each([
    [6.9 * GB, false],
    [7 * GB, false],
    [7.1 * GB, true],
    [10 * GB, true],
  ])("%d bytes is past the line at 70%% of the cap: %s", (bytes, over) => {
    expect(overAlertLine(bytes)).toBe(over);
  });

  test.each([
    [7.1 * GB, "7.1 GB, 71% of the 10 GB cap"],
    [7.04 * GB, "7 GB, 70% of the 10 GB cap"],
    [10 * GB, "10 GB, 100% of the 10 GB cap"],
  ])("%d bytes reads %s", (bytes, label) => {
    expect(shareLabel(bytes)).toBe(label);
  });
});

describe("the database size alert", () => {
  test("7.1 GB alerts once a day, and again the next day", async () => {
    const h = harness(7.1 * GB);
    expect(await checkDatabaseSize(h.at(NOW))).toBe("sent");
    expect(await checkDatabaseSize(h.at(new Date("2026-10-28T13:17:00Z")))).toBe("already-sent");
    expect(await checkDatabaseSize(h.at(new Date("2026-10-28T23:59:00Z")))).toBe("already-sent");
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({ bytes: 7.1 * GB, capBytes: 10 * GB, share: 0.71 });
    expect(h.posts[0]?.text).toContain("7.1 GB, 71% of the 10 GB cap");
    // Every run logs, so the operator reading the log sees it hourly.
    expect(h.lines).toHaveLength(3);
    expect(await checkDatabaseSize(h.at(new Date("2026-10-29T00:17:00Z")))).toBe("sent");
    expect(h.posts).toHaveLength(2);
  });

  test("6.9 GB does not alert", async () => {
    const h = harness(6.9 * GB);
    expect(await checkDatabaseSize(h.at(NOW))).toBe("under");
    expect(h.posts).toEqual([]);
    expect(h.lines).toEqual([]);
  });

  test("with no webhook the log line is the alert", async () => {
    const h = harness(7.1 * GB, { webhook: false });
    expect(await checkDatabaseSize(h.at(NOW))).toBe("logged");
    expect(h.lines).toEqual([expect.stringContaining("database size alert: 7.1 GB")]);
    expect(h.sent.size).toBe(0);
  });

  test("a failed push is not marked, so the next run tries again", async () => {
    const h = harness(7.1 * GB, { fail: true });
    expect(await checkDatabaseSize(h.at(NOW))).toBe("failed");
    expect(h.sent.size).toBe(0);
    expect(h.lines.at(-1)).toContain("the webhook failed: HTTP 500");
  });

  test("a size that could not be read alerts nothing", async () => {
    const h = harness(0);
    const deps = { ...h.at(NOW), bytes: { ok: false as const, why: "no size" } };
    expect(await checkDatabaseSize(deps)).toBe("unknown");
    expect(h.lines).toEqual([]);
  });

  test("the webhook is a JSON POST, and a status that is not 2xx throws", async () => {
    const { send, calls } = answering([204, 500]);
    const post = webhookPost("https://hooks.example.test/x", send);
    const body = { text: "t", bytes: 1, capBytes: 2, share: 0.5 };
    await post(body);
    expect(calls).toEqual([
      ["https://hooks.example.test/x", expect.objectContaining({ method: "POST" })],
    ]);
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual(body);
    await expect(post(body)).rejects.toThrow("HTTP 500");
  });
});
