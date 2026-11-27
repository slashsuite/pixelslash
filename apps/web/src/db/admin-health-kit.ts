import { builds, snapshots } from "./schema";
import { type TestDb, seededStore } from "#/test/store";

/** The org, project and build rows the operator health tests start from. */

export async function setup() {
  const { db, org, project } = await seededStore();
  return { db, org, project };
}

type Row = Partial<typeof builds.$inferInsert> & { projectId: string };

export async function build(db: TestDb, row: Row) {
  const id = crypto.randomUUID();
  await db
    .insert(builds)
    .values({ id, commitSha: "abc", branch: "main", status: "passed", ...row });
  return id;
}

export async function shot(
  db: TestDb,
  buildId: string,
  over: Partial<typeof snapshots.$inferInsert> = {},
) {
  await db.insert(snapshots).values({
    id: crypto.randomUUID(),
    buildId,
    name: `page-${crypto.randomUUID()}`,
    platform: "web",
    browser: "chromium",
    viewport: "1280x720",
    theme: "light",
    envFingerprint: "fp",
    imageKey: "k.png",
    ...over,
  });
}
