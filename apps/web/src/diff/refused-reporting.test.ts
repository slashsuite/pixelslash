import { Buffer } from "node:buffer";
import * as Sentry from "@sentry/cloudflare";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { context, onlyShot, sha, upload } from "./test-builds";

/**
 * What `reportError` hands the SDK: a real client whose `beforeSend` keeps each event and drops it,
 * so nothing is sent and no app module is mocked.
 */
const reported: Sentry.ErrorEvent[] = [];
const noSend = Sentry.createTransport({ recordDroppedEvent: () => undefined }, () =>
  Promise.resolve({}),
);

beforeEach(() => {
  reported.length = 0;
  const client = new Sentry.CloudflareClient({
    dsn: "https://key@sentry.test/1",
    integrations: [],
    stackParser: () => [],
    transport: () => noSend,
    beforeSend: (event) => {
      reported.push(event);
      return null;
    },
  });
  Sentry.setCurrentClient(client);
  client.init();
});

afterEach(() => {
  Sentry.getCurrentScope().setClient(undefined);
});

/** Each reported error as its message and tags. */
const sent = () => reported.map((event) => [event.exception?.values?.[0]?.value, event.tags]);

/** Only the head of a PNG: the limit reads the size and nothing may get as far as decoding it. */
const tall = (height: number) => {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(1280, 16);
  head.writeUInt32BE(height, 20);
  return new Uint8Array(head);
};

/** A build of one tall shot against a baseline one pixel taller, so the two are not the same bytes. */
async function pair(height: number, options: Parameters<typeof upload>[2]) {
  const ctx = await context();
  await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: tall(height) }] }, options);
  const build = await upload(
    ctx,
    { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: tall(height - 1) }] },
    options,
  );
  return { build, held: await onlyShot(ctx, build) };
}

describe("what reaches Sentry from a build with an unmeasured shot (PS-328)", () => {
  test("a shot over the size limit is an outcome of the upload: stored and shown, never reported", async () => {
    const { build, held } = await pair(40_000, { diffLimitMpx: 24.5 });
    const said =
      "too large for a server diff on this server: 1280x40000 = 51.2 Mpx, limit 24.5 Mpx";
    expect(build.status).toBe("errored");
    expect(build.error).toContain("1 of 1 shots could not be measured");
    expect(build.error).toContain(`(${held.viewport}, ${held.theme}): ${said}`);
    expect(build.error).not.toContain("re-run");
    expect(held.diffError).toBe(said);
    expect(sent()).toEqual([]);
  });

  test("a shot that fails for another reason is reported once, at the shot, and can be re-run", async () => {
    const boom = new Error("boom");
    const { build, held } = await pair(100, {
      diff: () => {
        throw boom;
      },
    });
    expect(build.status).toBe("errored");
    expect(build.error).toMatch(
      /^1 of 1 shots could not be measured; re-run them from the build page\./,
    );
    expect(held.diffError).toBe("boom");
    expect(sent()).toEqual([["boom", { area: "diff", step: "shot" }]]);
  });
});
