import { CopyLine, EmptyState, Step, Steps, Text } from "@slashsuite/ui-react";

/** An org with no projects: what a project is, and the two steps to a first build. The header holds the one "+ New project". */
export function EmptyOrg({ serverUrl, hydrated }: { serverUrl: string; hydrated: boolean }) {
  const command = `PIXELSLASH_TOKEN=… pixelslash upload DIR --server ${serverUrl}`;
  return (
    <EmptyState data-testid="empty-org" title="No projects yet">
      <Text tone="muted">
        A project holds one app's builds. Make one, issue a token in its settings, then upload from
        CI or your machine.
      </Text>
      <Steps>
        <Step
          title={
            <>
              Create a project and open{" "}
              <Text as="span" strong>
                Settings → Issue token
              </Text>
              .
            </>
          }
        />
        <Step title="Upload a build:">
          <CopyLine
            label="upload command"
            text={command}
            disabled={!hydrated}
            data-testid="upload-command"
          />
        </Step>
      </Steps>
    </EmptyState>
  );
}
