import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ABANDONED_AFTER_MS, ABANDONED_REASON } from "#/db/abandoned";
import { must } from "#/test/must";
import { builds } from "#/db/schema";
import { d1Db, seededStore } from "#/test/store";

// The Worker reads its bindings from `cloudflare:workers`, which Node does not have: the test hands it
// a real local D1 and an R2 bucket over a map, and the Worker's own env module reads them.
const bindings = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock("cloudflare:workers", () => bindings);
vi.mock("@tanstack/react-start/server-entry", () => ({ default: { fetch: () => new Response() } }));

type Listed = { key: string; size: number; uploaded: Date };

/** The slice of an R2 bucket the sweep uses, over a map; any delete is refused. */
function r2Bucket(objects: Map<string, Listed>) {
  return {
    head: async (key: string) => objects.get(key) ?? null,
    get: async () => null,
    put: async () => {
      throw new Error("the sweep writes no blob");
    },
    delete: async () => {
      throw new Error("deleting is off: nothing may be deleted");
    },
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...objects.values()].filter((o) => o.key.startsWith(prefix)),
      truncated: false,
    }),
  };
}

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

describe("the Worker's scheduled sweep", () => {
  test("with retention off it still ends an abandoned build, and deletes nothing", async () => {
    const d1 = await d1Db();
    disposers.push(d1.dispose);
    const { db, org, project } = await seededStore({ db: d1.db });
    await db.insert(builds).values({
      id: "gone",
      projectId: project.id,
      commitSha: "abc",
      branch: "feat/x",
      status: "uploading",
      createdAt: new Date(Date.now() - ABANDONED_AFTER_MS - 60 * 60 * 1000),
    });
    // An image no shot names: the orphan sweep lists it, and with deleting off leaves it.
    const key = `orgs/${org.id}/images/ab.png`;
    const objects = new Map([[key, { key, size: 4, uploaded: new Date(0) }]]);
    bindings.env = {
      DB: d1.d1,
      BLOBS: r2Bucket(objects),
      GITHUB_OAUTH_BASE: "https://github.com",
      GITHUB_API_BASE: "https://api.github.com",
    };
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { default: worker } = await import("./server");
    await Reflect.apply(must(worker.scheduled, "the scheduled handler"), worker, [{}, {}, {}]);

    const [row] = await db.select().from(builds).where(eq(builds.id, "gone"));
    expect(row).toMatchObject({ status: "errored", error: ABANDONED_REASON });
    expect([...objects.keys()]).toEqual([key]);
    expect(logged).toHaveBeenCalledWith(
      expect.stringMatching(/^orphaned images dry run: would delete 1,/),
    );
  });
});
