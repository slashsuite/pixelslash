import { Callout, Stack, Text } from "@slashsuite/ui-react";
import { RerunErrored } from "./rerun";

type Props = {
  project: { id: string; diffLocation: string };
  build: { id: string; status: string; error: string | null };
};

/** Why the build has no verdict, and how to measure it again. */
export function BuildError({ project, build }: Props) {
  if (!build.error) return null;
  return (
    <Callout
      tone="danger"
      actions={
        project.diffLocation === "server" && build.status === "errored" ? (
          <RerunErrored projectId={project.id} buildId={build.id} />
        ) : undefined
      }
    >
      <Stack gap="xs">
        <span>{build.error}</span>
        {project.diffLocation === "ci" && build.status === "errored" && (
          <Text strong tone="danger" data-testid="rerun-ci">
            This project diffs in CI, so the server cannot measure it again: re-run the CI job.
          </Text>
        )}
      </Stack>
    </Callout>
  );
}
