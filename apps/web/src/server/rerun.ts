import { createServerFn } from "@tanstack/react-start";
import { database } from "./env";
import { field } from "./input";
import { rerunFor } from "./rerun-for";
import { requireViewer } from "./session";

/* Partial re-runs on the page (ob 1738): the build page's "Re-run errored shots" and a shot's "Re-run diff". */

/** The picked shot's id; absent means every errored shot of the build. */
function pickedInput(d: unknown): string | null {
  const raw = typeof d === "object" && d !== null ? Reflect.get(d, "snapshotId") : undefined;
  return raw === undefined || raw === null ? null : field(d, "snapshotId");
}

export const rerunInput = (d: unknown) => ({
  projectId: field(d, "projectId"),
  buildId: field(d, "buildId"),
  snapshotId: pickedInput(d),
});

export type RerunInput = ReturnType<typeof rerunInput>;

export const rerunBuildShots = createServerFn({ method: "POST" })
  .validator(rerunInput)
  .handler(async ({ data }) => rerunFor(database(), await requireViewer(), data));
