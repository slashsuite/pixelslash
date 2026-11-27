import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { snapshots } from "#/db/schema";
import { META, call, openBuild, setup, snapshotForm } from "./test-support";

describe("snapshot ignore areas", () => {
  test("an upload stores the rects the diff skips", async () => {
    const { db, deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const put = await call(deps, `PUT /api/v1/builds/${id}/snapshots`, acme.token, snapshotForm());
    expect(put.status).toBe(200);

    const [snap] = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
    expect(snap?.ignore).toEqual(META.ignore);
  });

  test("a snapshot sent without ignore areas stores []", async () => {
    const { db, deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const { ignore: _ignore, ...old } = META;
    const put = await call(
      deps,
      `PUT /api/v1/builds/${id}/snapshots`,
      acme.token,
      snapshotForm(old),
    );
    expect(put.status).toBe(200);
    const [snap] = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
    expect(snap?.ignore).toEqual([]);
  });

  test("sending a snapshot again replaces its ignore areas", async () => {
    const { db, deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const path = `/api/v1/builds/${id}/snapshots`;
    await call(deps, `PUT ${path}`, acme.token, snapshotForm());
    await call(deps, `PUT ${path}`, acme.token, snapshotForm({ ...META, ignore: [] }));

    const [snap] = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
    expect(snap?.ignore).toEqual([]);
  });

  test("a malformed rect is a 400 and writes nothing", async () => {
    const { db, deps, blobs, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const bad = async (ignore: unknown) =>
      (
        await call(
          deps,
          `PUT /api/v1/builds/${id}/snapshots`,
          acme.token,
          snapshotForm({ ...META, ignore }),
        )
      ).status;

    // Which rects are refused is `validate.test.ts`'s parseRect table; this is the wiring.
    expect(await bad([{ ...META.ignore[0], x: -1 }])).toBe(400);
    expect(await db.select().from(snapshots)).toHaveLength(0);
    expect(blobs.data.size).toBe(0);
  });
});
