import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { RenderJob, RenderOutcome } from "@slashsuite/pixelslash-engine";
import { type Kept, MAX_QUEUED, MAX_STARTS, fileStore, renderWorker } from "./render-worker";

const post = (body: unknown, type = "application/json") =>
  new Request("http://127.0.0.1:3100/jobs", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": type },
  });

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

/** A store in memory: `saved` is what a new worker would load. */
function memoryStore(start: Kept[] = []) {
  const store = {
    saved: start,
    load: () => store.saved,
    save: (jobs: Kept[]) => (store.saved = jobs),
  };
  return store;
}

describe("the render worker", () => {
  test("takes a job, answers 202 at once, and renders one build at a time in order", async () => {
    const gated = gatedRender();
    const lines: string[] = [];
    const worker = renderWorker(gated.render, (l) => lines.push(l));
    expect((await worker.handle(post({ buildId: "a", token: "psr_a.x" }))).status).toBe(202);
    expect((await worker.handle(post({ buildId: "b", token: "psr_b.x" }))).status).toBe(202);
    // The same build handed again (a retried finalise), rendering or queued, is not queued twice.
    for (const id of ["a", "b"])
      expect((await worker.handle(post({ buildId: id, token: `psr_${id}.x` }))).status).toBe(202);
    const health = await worker.handle(new Request("http://127.0.0.1:3100/health"));
    expect(await health.json()).toEqual({ queued: 1, rendering: ["a"] });
    expect(gated.events).toEqual(["start a"]);
    gated.release();
    await vi.waitFor(() => expect(gated.events).toEqual(["start a", "end a", "start b"]));
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
    // What a page's script can send without a preflight (a no-cors fetch, a form) is not a job.
    const plain = post({ buildId: "a", token: "t" }, "text/plain");
    expect((await worker.handle(plain)).status).toBe(415);
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

  test("keeps the queue and the build being rendered in its store, and a new worker renders them again", async () => {
    const store = memoryStore();
    const gated = gatedRender();
    const first = renderWorker(gated.render, () => {}, { store });
    for (const id of ["a", "b", "c"])
      await first.handle(post({ buildId: id, token: `psr_${id}.x` }));
    // a is being rendered (started once), b and c wait: the worker is killed here.
    expect(store.saved).toEqual([
      { buildId: "a", token: "psr_a.x", starts: 1 },
      { buildId: "b", token: "psr_b.x", starts: 0 },
      { buildId: "c", token: "psr_c.x", starts: 0 },
    ]);

    const next = gatedRender();
    const lines: string[] = [];
    const second = renderWorker(next.render, (l) => lines.push(l), { store });
    await second.resume();
    expect(lines[0]).toBe("resumed 3 build(s) left by the last worker: a, b, c");
    expect(next.events).toEqual(["start a"]);
    expect(store.saved[0]).toEqual({ buildId: "a", token: "psr_a.x", starts: 2 });
    // A finalise retried while a is rendered again is still taken once.
    await second.handle(post({ buildId: "a", token: "psr_a.x" }));
    expect(store.saved).toHaveLength(3);
    next.release();
    await vi.waitFor(() => expect(next.events).toContain("start b"));
    next.release();
    await vi.waitFor(() => expect(next.events).toContain("start c"));
    next.release();
    await second.settled();
    expect(next.events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(store.saved).toEqual([]);
    expect(lines.join("\n")).not.toContain("psr_");
  });

  test("ends a build the worker keeps dying under errored, after MAX_STARTS starts", async () => {
    const store = memoryStore([
      { buildId: "killer", token: "psr_killer.x", starts: MAX_STARTS },
      { buildId: "next", token: "psr_next.x", starts: MAX_STARTS - 1 },
    ]);
    const given: string[] = [];
    const rendered: string[] = [];
    const lines: string[] = [];
    const worker = renderWorker(
      async (job) => {
        rendered.push(job.buildId);
        return { ok: true, snapshots: 1 };
      },
      (l) => lines.push(l),
      {
        store,
        giveUp: async (job, error) => {
          given.push(`${job.buildId}: ${error}`);
          return true;
        },
      },
    );
    await worker.resume();
    await worker.settled();
    expect(rendered).toEqual(["next"]);
    expect(given).toEqual([
      `killer: the renderer stopped ${MAX_STARTS} times while rendering this build (a crash or its memory limit); send the build again`,
    ]);
    expect(lines).toContain(`render killer: given up: ${given[0]?.slice("killer: ".length)}`);
    expect(store.saved).toEqual([]);
  });

  test("keeps a build given up on in the store until the server has its error, and a stop waits for that", async () => {
    const store = memoryStore([{ buildId: "killer", token: "psr_killer.x", starts: MAX_STARTS }]);
    const answers: ((reached: boolean) => void)[] = [];
    const giveUp = () => new Promise<boolean>((answer) => answers.push(answer));
    const first = renderWorker(gatedRender().render, () => {}, { store, giveUp });
    void first.resume();
    const order: string[] = [];
    const stopping = first.stop().then(() => order.push("stopped"));
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    expect(store.saved.map((j) => j.buildId)).toEqual(["killer"]);
    order.push("answered");
    answers.shift()?.(false);
    await stopping;
    // The stop resolved only after the server's answer, not while the give-up was in flight.
    expect(order).toEqual(["answered", "stopped"]);
    expect(store.saved).toEqual([{ buildId: "killer", token: "psr_killer.x", starts: MAX_STARTS }]);

    const second = renderWorker(gatedRender().render, () => {}, { store, giveUp });
    const resumed = second.resume();
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    answers.shift()?.(true);
    await resumed;
    expect(store.saved).toEqual([]);
  });

  test("a stop lets the build being rendered finish, starts no other, and still takes jobs into the store", async () => {
    const store = memoryStore();
    const gated = gatedRender();
    const worker = renderWorker(gated.render, () => {}, { store });
    await worker.handle(post({ buildId: "a", token: "t" }));
    await worker.handle(post({ buildId: "b", token: "t" }));
    const stopping = worker.stop().then(() => gated.events.push("stopped"));
    expect((await worker.handle(post({ buildId: "c", token: "t" }))).status).toBe(202);
    expect(store.saved.map((j) => j.buildId)).toEqual(["a", "b", "c"]);
    gated.release();
    await stopping;
    // The stop waited for a to end, and b never started.
    expect(gated.events).toEqual(["start a", "end a", "stopped"]);
    expect(store.saved.map((j) => j.buildId)).toEqual(["b", "c"]);
  });

  test("with builds: 2, renders two at once, starts the next as either ends, and keeps both in its store", async () => {
    const store = memoryStore();
    const gated = gatedRender();
    const worker = renderWorker(gated.render, () => {}, { store, builds: 2 });
    for (const id of ["a", "b", "c", "d"])
      await worker.handle(post({ buildId: id, token: `psr_${id}.x` }));
    expect(gated.events).toEqual(["start a", "start b"]);
    const health = await worker.handle(new Request("http://127.0.0.1:3100/health"));
    expect(await health.json()).toEqual({ queued: 2, rendering: ["a", "b"] });
    // Killed here, a new worker would render a and b again, then c and d.
    expect(store.saved.map((j) => `${j.buildId} ${j.starts}`)).toEqual([
      "a 1",
      "b 1",
      "c 0",
      "d 0",
    ]);
    // A build already rendering, handed again, is taken once.
    await worker.handle(post({ buildId: "b", token: "psr_b.x" }));
    expect(store.saved).toHaveLength(4);
    gated.release();
    await vi.waitFor(() =>
      expect(gated.events).toEqual(["start a", "start b", "end a", "start c"]),
    );
    expect(store.saved.map((j) => j.buildId)).toEqual(["b", "c", "d"]);
    const stopping = worker.stop().then(() => gated.events.push("stopped"));
    gated.release();
    await vi.waitFor(() => expect(gated.events).toContain("end b"));
    gated.release();
    await stopping;
    // d is never started, and the stop waited for c, still rendering when b ended.
    expect(gated.events).toEqual([
      "start a",
      "start b",
      "end a",
      "start c",
      "end b",
      "end c",
      "stopped",
    ]);
    expect(store.saved.map((j) => j.buildId)).toEqual(["d"]);
  });

  test("with builds: 2, a build left by a killed worker renders alone, then two run at once again", async () => {
    const gated = gatedRender();
    const store = memoryStore([
      { buildId: "a", token: "t", starts: 1 },
      { buildId: "b", token: "t", starts: 0 },
      { buildId: "c", token: "t", starts: 0 },
    ]);
    const worker = renderWorker(gated.render, () => {}, { store, builds: 2 });
    await worker.resume();
    await vi.waitFor(() => expect(gated.events).toEqual(["start a"]));
    gated.release();
    // b and c start only after a ends: the order shows a rendered alone.
    await vi.waitFor(() =>
      expect(gated.events).toEqual(["start a", "end a", "start b", "start c"]),
    );
    gated.release();
    gated.release();
    await worker.settled();
    expect(store.saved).toEqual([]);
  });

  test("a DELETE drops a queued build from the queue and its store, stops one being rendered, and answers null for one it does not hold", async () => {
    const store = memoryStore();
    const lines: string[] = [];
    const signals = new Map<string, AbortSignal>();
    const render = (job: RenderJob, signal: AbortSignal) => {
      signals.set(job.buildId, signal);
      return new Promise<RenderOutcome>((done) =>
        signal.addEventListener("abort", () => done({ ok: false, error: "render cancelled" })),
      );
    };
    const worker = renderWorker(render, (l) => lines.push(l), { store });
    for (const id of ["a", "b", "c"])
      await worker.handle(post({ buildId: id, token: `psr_${id}.x` }));
    const del = (id: string) =>
      worker.handle(new Request(`http://127.0.0.1:3100/jobs/${id}`, { method: "DELETE" }));
    expect(await (await del("b")).json()).toEqual({ dropped: "queued" });
    expect(store.saved.map((j) => j.buildId)).toEqual(["a", "c"]);
    expect(await (await del("a")).json()).toEqual({ dropped: "rendering" });
    expect(signals.get("a")?.aborted).toBe(true);
    // a stopped, so c, the next in the queue, starts; b never does.
    await vi.waitFor(() => expect(worker.rendering()).toEqual(["c"]));
    expect(await (await del("zz")).json()).toEqual({ dropped: null });
    expect(
      (await worker.handle(new Request("http://127.0.0.1:3100/jobs/a", { method: "GET" }))).status,
    ).toBe(404);
    await del("c");
    await worker.settled();
    expect(signals.has("b")).toBe(false);
    expect(store.saved).toEqual([]);
    expect(lines.join("\n")).not.toContain("psr_");
  });

  test("a stop with nothing rendering resolves at once", async () => {
    const worker = renderWorker(gatedRender().render, () => {}, { store: memoryStore() });
    await worker.stop();
    expect((await worker.handle(post({ buildId: "a", token: "t" }))).status).toBe(202);
    expect(await (await worker.handle(new Request("http://127.0.0.1:3100/health"))).json()).toEqual(
      {
        queued: 1,
        rendering: [],
      },
    );
  });
});

describe("the queue's file", () => {
  test("is written whole, mode 600, read back as written, and a file it did not write is an empty queue", () => {
    const dir = mkdtempSync(join(tmpdir(), "render-queue-"));
    try {
      const path = join(dir, "queue.json");
      const warnings: string[] = [];
      const store = fileStore(path, (l) => warnings.push(l));
      expect(store.load()).toEqual([]);
      const jobs = [{ buildId: "a", token: "psr_a.x", starts: 1 }];
      store.save(jobs);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(jobs);
      expect(fileStore(path, () => {}).load()).toEqual(jobs);
      expect(warnings).toEqual([]);

      for (const junk of ["{not json", '[{"buildId":"a"}]', '{"buildId":"a"}']) {
        writeFileSync(path, junk);
        expect(store.load()).toEqual([]);
      }
      expect(warnings).toHaveLength(3);
      expect(warnings[0]).toContain("starting with an empty queue");

      // A save that cannot be written is warned of; the worker goes on.
      fileStore(join(dir, "missing", "queue.json"), (l) => warnings.push(l)).save(jobs);
      expect(warnings.at(-1)).toContain("was not saved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
