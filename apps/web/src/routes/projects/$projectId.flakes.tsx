import {
  Breadcrumbs,
  Button,
  ButtonGroup,
  Caption,
  Card,
  Cluster,
  ClusterGrow,
  Disclosure,
  Input,
  ListLayout,
  Pill,
  Stack,
  TextLink,
  Text,
} from "@slashsuite/ui-react";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { orgCrumb, projectCrumbs } from "#/components/crumbs";
import { useFlagWrite } from "#/components/detection-flag";
import { FlakeHistory, FlakeRuns, FlakyPolicyControl, flakeAnchor } from "#/components/flake";
import { Page, useHydrated } from "#/components/ui";
import { formatRelative } from "#/lib/format";
import { type FlakeView, getFlakesPage, saveFlakeStatus } from "#/server/flakes";
import { hrefTo } from "#/lib/href";
import { titled } from "#/lib/page-title";

export const Route = createFileRoute("/projects/$projectId/flakes")({
  loader: ({ params }) => getFlakesPage({ data: { projectId: params.projectId } }),
  head: ({ loaderData }) => titled("Flakes", loaderData?.project.name),
  component: FlakesPage,
});

/** The flaky shot's variant, as the build page names one: what is not the default reads as a chip. */
const variantOf = (flake: FlakeView) =>
  [flake.platform, flake.browser, flake.viewport, flake.theme].join(" · ");

/** Resolve with an optional note, or reopen a resolved flaky shot. */
function StatusControl({ projectId, flake }: { projectId: string; flake: FlakeView }) {
  const hydrated = useHydrated();
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState("");
  const { busy, error, run } = useFlagWrite(() => setResolving(false));
  const ids = { projectId, flakeId: flake.id };
  const resolve = (event: FormEvent) => {
    event.preventDefault();
    run(() => saveFlakeStatus({ data: { ...ids, open: false, note } }));
  };
  if (flake.status === "resolved") {
    return (
      <Stack gap="xs">
        <Button
          variant="outline"
          busy={busy && "Reopening…"}
          disabledReason={hydrated ? undefined : "Loading"}
          onClick={() => run(() => saveFlakeStatus({ data: { ...ids, open: true, note: null } }))}
          size="sm"
        >
          Reopen
        </Button>
        {error && (
          <div role="alert">
            <Text tone="danger">{error}</Text>
          </div>
        )}
      </Stack>
    );
  }
  if (!resolving) {
    return (
      <Button variant="outline" disabled={!hydrated} onClick={() => setResolving(true)} size="sm">
        Resolve
      </Button>
    );
  }
  return (
    <Stack as="form" gap="xs" onSubmit={resolve} aria-label="Resolve flake">
      <Input
        aria-label="Resolution note (optional)"
        placeholder="What fixed it (optional)"
        value={note}
        maxLength={200}
        onChange={(e) => setNote(e.target.value)}
      />
      {error && (
        <div role="alert">
          <Text tone="danger">{error}</Text>
        </div>
      )}
      <ButtonGroup>
        <Button type="submit" busy={busy && "Resolving…"} size="sm">
          Resolve
        </Button>
        <Button type="button" variant="ghost" onClick={() => setResolving(false)} size="sm">
          Cancel
        </Button>
      </ButtonGroup>
    </Stack>
  );
}

function FlakeItem({ projectId, flake, now }: { projectId: string; flake: FlakeView; now: Date }) {
  const latest = flake.evidence.at(-1);
  // The policy the latest detection was captured under; a hand mark sent none, so review.
  const policy = latest?.policy ?? "review";
  return (
    <li>
      <Card id={flakeAnchor(flake.id)} data-testid="flake" data-status={flake.status}>
        <Stack gap="sm">
          <Cluster gap="sm" align="start" justify="between">
            <ClusterGrow>
              <Cluster gap="xs">
                <Pill tone={flake.status === "open" ? "warn" : "neutral"}>{flake.status}</Pill>
                <ClusterGrow>
                  <Text as="span" strong lines={1} data-testid="flake-name">
                    {flake.name}
                  </Text>
                </ClusterGrow>
              </Cluster>
              <Caption>
                {variantOf(flake)} · {flake.evidence.length} detection
                {flake.evidence.length === 1 ? "" : "s"} · updated{" "}
                {formatRelative(flake.updatedAt, now)}
              </Caption>
            </ClusterGrow>
            <StatusControl projectId={projectId} flake={flake} />
          </Cluster>
          <FlakeHistory flake={flake} />
          {latest && (
            <Stack gap="xs">
              <FlakeRuns evidence={latest} />
              <TextLink
                href={hrefTo("/projects/$projectId/builds/$buildId/snapshots/$snapshotId", {
                  projectId,
                  buildId: latest.buildId,
                  snapshotId: latest.snapshotId,
                })}
              >
                See the shot
              </TextLink>
            </Stack>
          )}
          <Disclosure
            summary={
              <Text as="span" tone="muted">
                Policy: {policy}. Change it in config
              </Text>
            }
          >
            <FlakyPolicyControl policy={policy} />
          </Disclosure>
        </Stack>
      </Card>
    </li>
  );
}

function FlakesPage() {
  const { project, org, flakes, now } = Route.useLoaderData();
  const open = flakes.filter((f) => f.status === "open").length;
  return (
    <Page>
      <ListLayout
        breadcrumbs={<Breadcrumbs items={[orgCrumb(org), ...projectCrumbs(project), "Flakes"]} />}
        title={`${project.name} · flakes`}
        description={
          flakes.length === 0
            ? "No flakes. A shot is flaky when the CLI captured it again and the captures disagreed, or when a reviewer marked it."
            : `${open} open, ${flakes.length - open} resolved. Open flakes first.`
        }
      >
        <Stack as="ul" gap="sm">
          {flakes.map((flake) => (
            <FlakeItem key={flake.id} projectId={project.id} flake={flake} now={now} />
          ))}
        </Stack>
      </ListLayout>
    </Page>
  );
}
