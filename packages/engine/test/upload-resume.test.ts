import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { UploadError } from "../src/errors.ts";
import { uploadSnapshots } from "../src/upload.ts";
import { fakeServer } from "./fake-server.ts";
import { cleanup, entry, gitOpts, repo, snapshotDir } from "./upload-fixtures.ts";

afterAll(cleanup);
afterEach(() => vi.restoreAllMocks());

/** A finalise that answers each call with the next reply in `replies`. */
async function upload(replies: object[], onFinalise?: () => void) {
  let n = 0;
  const server = fakeServer((c) => {
    if (!c.url.endsWith("/finalize")) return undefined;
    onFinalise?.();
    return Response.json(replies[n++] ?? replies.at(-1));
  });
  const { dir: cwd } = await repo(1, 1);
  const dir = await snapshotDir([entry("home")]);
  const warnings: string[] = [];
  const run = uploadSnapshots(
    { dir, server: "https://ps.example", token: "t", git: gitOpts(cwd) },
    { fetch: server.fetch, warn: (m) => warnings.push(m), sleep: async () => {} },
  );
  const finalises = () => server.calls.filter((c) => c.url.endsWith("/finalize")).length;
  return { run, warnings, finalises };
}

const errored = (unmeasured: number) => ({
  id: "b1",
  status: "errored",
  error: `diff ceiling: ${unmeasured} left`,
  unmeasured,
});

describe("uploadSnapshots resumes a diff the server stopped at its budget (ob 1645)", () => {
  test("finalises again while shots are left, until the build has a verdict", async () => {
    const { run, warnings, finalises } = await upload([
      errored(40),
      errored(5),
      { id: "b1", status: "changes", error: null, unmeasured: 0 },
    ]);
    await expect(run).resolves.toMatchObject({ buildId: "b1" });
    expect(finalises()).toBe(3);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/40 of 1 shots still to measure/);
  });

  test("goes on when a slow finalise measured nothing, until the server finishes", async () => {
    const { run, warnings, finalises } = await upload([
      errored(69),
      errored(69),
      { id: "b1", status: "changes", error: null, unmeasured: 0 },
    ]);
    await expect(run).resolves.toMatchObject({ buildId: "b1" });
    expect(finalises()).toBe(3);
    expect(warnings).toEqual([
      "upload: 69 of 1 shots still to measure on the server; continuing",
      "upload: 69 of 1 shots still to measure on the server; continuing",
    ]);
  });

  test("a fall resets the count of finalises that measured nothing", async () => {
    const { run, finalises } = await upload([
      errored(69),
      errored(69),
      errored(69),
      errored(40),
      errored(40),
      errored(40),
      { id: "b1", status: "changes", error: null, unmeasured: 0 },
    ]);
    await expect(run).resolves.toMatchObject({ buildId: "b1" });
    expect(finalises()).toBe(7);
  });

  test("gives up after three finalises in a row measure nothing, and fails the upload (PS-228)", async () => {
    const { run, warnings, finalises } = await upload([errored(69)]);
    const failure = await run.catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UploadError);
    expect(failure).toHaveProperty(
      "message",
      "upload failed: build b1 errored on the server: diff ceiling: 69 left",
    );
    // The first reply sets the count; three more that did not fall end it.
    expect(finalises()).toBe(4);
    expect(warnings).toHaveLength(3);
  });

  test("gives up once ten minutes have passed, even while the count falls", async () => {
    // Each finalise takes four minutes: the third reply comes at twelve, past the ten allowed.
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { run, finalises } = await upload(
      [errored(60), errored(50), errored(40), errored(30)],
      () => (clock += 4 * 60_000),
    );
    await expect(run).rejects.toThrow(
      "upload failed: build b1 errored on the server: diff ceiling: 40 left",
    );
    expect(finalises()).toBe(3);
  });

  test("a reply without a count is not retried, and fails the upload with the server's page", async () => {
    const { run, finalises } = await upload([
      {
        id: "b1",
        status: "errored",
        error: "boom",
        web_url: "https://ps.example/projects/p/builds/b1",
      },
    ]);
    await expect(run).rejects.toThrow(
      "upload failed: build b1 errored on the server: boom (https://ps.example/projects/p/builds/b1)",
    );
    expect(finalises()).toBe(1);
  });
});
