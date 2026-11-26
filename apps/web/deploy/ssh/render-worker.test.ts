import { describe, expect, test } from "vitest";
import type { RenderJob } from "@slashsuite/pixelslash-engine";
import { MAX_QUEUED, renderWorker } from "./render-worker";

const post = (body: unknown) =>
  new Request("http://127.0.0.1:3100/jobs", { method: "POST", body: JSON.stringify(body) });

/** A render that waits for `release` before it ends, recording when each job starts and ends. */
function gatedRender() {
  const events: string[] = [];
  const waiting: (() => void)[] = [];
  const render = async (job: RenderJob) => {
    events.push(`start ${job.buildId}`);
    await new Promise<void>((done) => waiting.push(done));
    events.push(`end ${job.buildId}`);
    return { ok: true as const, snapshots: 1 };
  };
  return { events, render, release: () => waiting.shift()?.() };
}

describe("the render worker", () => {
  test("takes a job, answers 202 at once, and renders one build at a time in order", async () => {
    const gated = gatedRender();
    const lines: string[] = [];
    const worker = renderWorker(gated.render, (l) => lines.push(l));
    expect((await worker.handle(post({ buildId: "a", token: "psr_a.x" }))).status).toBe(202);
    expect((await worker.handle(post({ buildId: "b", token: "psr_b.x" }))).status).toBe(202);
    const health = await worker.handle(new Request("http://127.0.0.1:3100/health"));
    expect(await health.json()).toEqual({ queued: 1, rendering: "a" });
    expect(gated.events).toEqual(["start a"]);
    gated.release();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(gated.events).toEqual(["start a", "end a", "start b"]);
    gated.release();
    await worker.settled();
    expect(gated.events).toEqual(["start a", "end a", "start b", "end b"]);
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("psr_");
  });

  test("refuses a malformed job and a full queue, and logs a failed render without its token", async () => {
    const gated = gatedRender();
    const lines: string[] = [];
    const worker = renderWorker(gated.render, (l) => lines.push(l));
    expect((await worker.handle(post({ buildId: "a" }))).status).toBe(400);
    expect((await worker.handle(post({ buildId: "", token: "t" }))).status).toBe(400);
    for (let i = 0; i <= MAX_QUEUED; i++)
      expect((await worker.handle(post({ buildId: `b${i}`, token: "t" }))).status).toBe(202);
    expect((await worker.handle(post({ buildId: "late", token: "t" }))).status).toBe(503);
    expect((await worker.handle(new Request("http://127.0.0.1:3100/other"))).status).toBe(404);

    const failing = renderWorker(
      async () => ({ ok: false, error: "story x never settled\nmore" }),
      (l) => lines.push(l),
    );
    await failing.handle(post({ buildId: "c", token: "psr_c.secret" }));
    await failing.settled();
    expect(lines.at(-1)).toMatch(/^render c: failed in [\d.]+ s: story x never settled$/);
  });
});
