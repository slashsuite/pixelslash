import { getBuild } from "#/db/builds";
import type { Db } from "#/db/db";
import type { User } from "#/db/users";
import { getProjectWithOrg } from "#/db/orgs";
import { NoRecoveryError } from "#/diff/claim";
import { RerunError, rerunShots } from "#/diff/rerun";
import { orgBlobs } from "#/storage/blobs";
import { blobStore, diffLimitMpx, explainQueue, modelKeySecret, syncChecks } from "./env";
import { or404 } from "./input";
import type { RerunInput } from "./rerun";

/** The re-run as the viewer asked it, on `db`: split from the server function so a DOM test can bind it. It is its own module so the client bundle, where the compiler drops the handler, never reaches `./env`. */
export async function rerunFor(db: Db, user: User, data: RerunInput) {
  const { project } = await or404(getProjectWithOrg(db, user.id, data.projectId));
  const build = await or404(getBuild(db, project.id, data.buildId));
  const blobs = orgBlobs(blobStore(), project.orgId);
  try {
    const rerun = await rerunShots(
      {
        db,
        blobs,
        diffLimitMpx: diffLimitMpx(),
        modelKeySecret: modelKeySecret(),
        explainQueue: explainQueue(),
      },
      build,
      data.snapshotId,
    );
    await syncChecks(db, [build.id]);
    return rerun;
  } catch (error) {
    // A refusal is a message the page states, not a 500.
    if (error instanceof RerunError || error instanceof NoRecoveryError)
      throw new Error(error.message, { cause: error });
    throw error;
  }
}
