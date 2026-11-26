import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { RenderJob } from "@slashsuite/pixelslash-engine";
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

const tick = () => new Promise((r) => setTimeout(r, 0));

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
    for (let i = 0; i < 3; i++) {
      next.release();
      await tick();
    }
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
    let stopped = false;
    const stopping = first.stop().then(() => (stopped = true));
    await tick();
    expect(stopped).toBe(false);
    expect(store.saved.map((j) => j.buildId)).toEqual(["killer"]);
    answers.shift()?.(false);
    await stopping;
    expect(store.saved).toEqual([{ buildId: "killer", token: "psr_killer.x", starts: MAX_STARTS }]);

    const second = renderWorker(gatedRender().render, () => {}, { store, giveUp });
    const resumed = second.resume();
    await tick();
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
    let stopped = false;
    const stopping = worker.stop().then(() => (stopped = true));
    expect((await worker.handle(post({ buildId: "c", token: "t" }))).status).toBe(202);
    await tick();
    expect(stopped).toBe(false);
    gated.release();
    await stopping;
    expect(gated.events).toEqual(["start a", "end a"]);
    expect(store.saved.map((j) => j.buildId)).toEqual(["b", "c"]);
  });

  test("a stop with nothing rendering resolves at once", async () => {
    const worker = renderWorker(gatedRender().render, () => {}, { store: memoryStore() });
    await worker.stop();
    expect((await worker.handle(post({ buildId: "a", token: "t" }))).status).toBe(202);
    expect(await (await worker.handle(new Request("http://127.0.0.1:3100/health"))).json()).toEqual(
      {
        queued: 1,
        rendering: null,
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
