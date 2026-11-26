import { and, eq } from "drizzle-orm";
import type { Db } from "./db";
import { builds } from "./schema";

/** What a render token's build is: its project, status, plan and age; null when there is no such build. */
export async function renderBuildRow(db: Db, buildId: string) {
  const [row] = await db
    .select({
      projectId: builds.projectId,
      status: builds.status,
      plan: builds.renderPlan,
      at: builds.createdAt,
    })
    .from(builds)
    .where(eq(builds.id, buildId));
  return row ?? null;
}

/**
 * Error a bundle build whose render failed, only while it is still uploading. False when it had
 * already moved on (its finalise landed first), so nothing else about it is touched.
 */
export async function errorRenderBuild(db: Db, buildId: string, message: string): Promise<boolean> {
  const changed = await db
    .update(builds)
    .set({ status: "errored", error: message })
    .where(and(eq(builds.id, buildId), eq(builds.status, "uploading")))
    .returning({ id: builds.id });
  return changed.length > 0;
}
