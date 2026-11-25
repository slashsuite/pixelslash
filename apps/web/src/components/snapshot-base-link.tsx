import { TextLink } from "@slashsuite/ui-react";
import type { BuildLink } from "#/lib/viewer-bases";
import { hrefTo } from "#/lib/href";

/** The earlier build's name in the left pane links to its shot. */
export const linkToBuild =
  (projectId: string): BuildLink =>
  (build, text) => (
    <TextLink
      href={hrefTo("/projects/$projectId/builds/$buildId/snapshots/$snapshotId", {
        projectId,
        buildId: build.buildId,
        snapshotId: build.snapshotId,
      })}
    >
      {text}
    </TextLink>
  );
