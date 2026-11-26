import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { createBuild } from "#/db/builds";
import { createProject } from "#/db/orgs";
import { builds } from "#/db/schema";
import { orgBlobs } from "#/storage/blobs";
import type { ApiDeps } from "./handler";
import { renderToken } from "./render-token";
import { call, idOf, newBuild, setup } from "./test-support";

const PLAN = { storybook: { include: ["ui-*"] } };
const OLD = "c".repeat(40);
const NEW = "d".repeat(40);

/** A bundle build's body at `commitSha` of pull request 7. */
const head = (commitSha: string, extra: object = {}) =>
  newBuild({ commitSha, prNumber: 7, render: { kind: "bundle", plan: PLAN }, ...extra });

/** What the renderer is sent to drop `ids`, in order. */
const dropped = (...ids: string[]) => ids.map((id) => `http://renderer.test/jobs/${id}`).toSorted();

/** A server whose renderer records the builds it is told to drop. */
async function renderingServer(reach = true) {
  const held = await setup();
  const deletes: string[] = [];
  const deps: ApiDeps = {
    ...held.deps,
    render: {
      url: "http://renderer.test/jobs",
      fetch: async (url, init) => {
        if (!reach) throw new Error("connection refused");
        if (init.method === "DELETE") deletes.push(url);
        return Response.json({ dropped: "queued" }, { status: 200 });
      },
    },
  };
  const open = async (body: string) =>
    idOf(await call(deps, "POST /api/v1/builds", held.acme.token, body));
  const statusOf = async (id: string) =>
    (await held.db.select().from(builds).where(eq(builds.id, id)))[0];
  return { ...held, deps, deletes, open, statusOf };
}

describe("a newer head of a pull request", () => {
  test("ends the old head's bundle builds across the project's group and tells the renderer to drop each", async () => {
    const { db, deps, acme, blobs, deletes, open, statusOf } = await renderingServer();
    const old = await open(head(OLD));
    const key = `builds/${old}/bundle.tar.gz`;
    const held = orgBlobs(blobs.store, acme.org.id);
    await held.put(key, new ArrayBuffer(1), "application/gzip");
    // The same head fanned out to a subproject too.
    const sub = await createProject(db, acme.user.id, acme.org.id, {
      name: "web-mobile",
      parentId: acme.project.id,
    });
    const sibling = await createBuild(db, sub.id, {
      commitSha: OLD,
      branch: "feat/x",
      mergeBaseSha: "b".repeat(40),
      ancestorShas: [],
      prNumber: 7,
      renderPlan: JSON.stringify(PLAN),
    });
    const fresh = await open(head(NEW));
    for (const id of [old, sibling]) {
      const row = await statusOf(id);
      expect(row?.status).toBe("errored");
      expect(row?.error).toMatch(/^superseded: commit ddddddd of pull request #7/);
    }
    expect(deletes.toSorted()).toEqual(dropped(old, sibling));
    expect(await held.has(key)).toBe(false);
    // A renderer that missed the cancel is refused the plan, so it renders nothing.
    const token = await renderToken("test-image-secret", old);
    expect((await call(deps, `GET /api/v1/builds/${old}/render`, token)).status).toBe(400);
    expect((await statusOf(fresh))?.status).toBe("uploading");
  });

  test("leaves another pull request, a client capture, a build with no pull request and a newer head alone", async () => {
    const { deletes, open, statusOf } = await renderingServer();
    const client = await open(newBuild({ commitSha: OLD, prNumber: 7 }));
    const same = await open(head(NEW));
    const otherPr = await open(head(OLD, { prNumber: 8 }));
    const noPr = await open(newBuild({ commitSha: OLD, render: { kind: "bundle", plan: PLAN } }));
    // A late build of the old run, after NEW was seen: OLD came first, so NEW's builds stay.
    const late = await open(head(OLD));
    expect((await statusOf(same))?.status).toBe("uploading");
    // E came after both: its arrival ends the late OLD build and NEW's, and nothing else.
    await open(head("e".repeat(40)));
    for (const id of [client, otherPr, noPr])
      expect((await statusOf(id))?.status).toBe("uploading");
    for (const id of [late, same]) expect((await statusOf(id))?.status).toBe("errored");
    expect(deletes.toSorted()).toEqual(dropped(late, same));
  });

  test("orders heads by their CI run, so an older push that uploads late ends nothing of the newer head's", async () => {
    const { deletes, open, statusOf } = await renderingServer();
    // Push OLD (run 100), then NEW (run 101); NEW's run reaches the server first.
    const fresh = await open(head(NEW, { ciRunId: 101 }));
    const late = await open(head(OLD, { ciRunId: 100 }));
    expect((await statusOf(fresh))?.status).toBe("uploading");
    expect(deletes).toEqual([]);
    // NEW's next build (a re-run keeps the run id) ends the late OLD one.
    await open(head(NEW, { ciRunId: 101 }));
    expect((await statusOf(late))?.status).toBe("errored");
    expect((await statusOf(fresh))?.status).toBe("uploading");
    expect(deletes).toEqual(dropped(late));
  });

  test("a force-push back to an older commit is a new run, so it ends the head it replaced", async () => {
    const { open, statusOf } = await renderingServer();
    await open(head(OLD, { ciRunId: 100 }));
    const fresh = await open(head(NEW, { ciRunId: 101 }));
    // OLD again, pushed after NEW: its new run outranks NEW's though OLD's first build came first.
    await open(head(OLD, { ciRunId: 102 }));
    expect((await statusOf(fresh))?.status).toBe("errored");
  });

  test("a head with no CI run is ordered by arrival", async () => {
    const { open, statusOf } = await renderingServer();
    const fresh = await open(head(NEW, { ciRunId: 101 }));
    // OLD has no run id, so it counts as newer by arrival and ends NEW's build.
    await open(head(OLD));
    expect((await statusOf(fresh))?.status).toBe("errored");
  });

  test("a run id that is not a positive integer is a 400", async () => {
    const { deps, acme } = await renderingServer();
    for (const ciRunId of [0, -1, 1.5, "12"])
      expect(
        (await call(deps, "POST /api/v1/builds", acme.token, head(NEW, { ciRunId }))).status,
      ).toBe(400);
  });

  test("a renderer that cannot be reached does not fail the new build", async () => {
    const { deps, acme, open, statusOf } = await renderingServer(false);
    const old = await open(head(OLD));
    expect((await call(deps, "POST /api/v1/builds", acme.token, head(NEW))).status).toBe(201);
    expect((await statusOf(old))?.status).toBe("errored");
  });
});
