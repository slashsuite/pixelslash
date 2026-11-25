import {
  Caption,
  Card,
  Cluster,
  ListRow,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Text,
  TextLink,
} from "@slashsuite/ui-react";
import { MixBar, ToReview, stripeToneOf } from "#/components/build-mix";
import { StatusBadge } from "#/components/ui";
import type { BuildSummary } from "#/db/build-list";
import { formatRelative } from "#/lib/format";
import { hrefTo } from "#/lib/href";

/** The builds: a stacked card each on a phone, the table from the kit's `sm` up. */
export function BuildsList({
  projectId,
  defaultBranch,
  builds,
  now,
}: {
  projectId: string;
  defaultBranch: string;
  builds: BuildSummary[];
  now: Date;
}) {
  return (
    <>
      {/* A phone gets one stacked row per build; the table, which the kit scrolls sideways, would hide three of its five columns. */}
      <div className="sm:hidden">
        <Card flush>
          <Stack divided>
            {builds.map((build) => (
              <BuildCard
                key={build.id}
                projectId={projectId}
                defaultBranch={defaultBranch}
                build={build}
                now={now}
              />
            ))}
          </Stack>
        </Card>
      </div>
      <div className="hidden sm:block">
        <Table label="Builds">
          <TableHead>
            <TableRow>
              <TableHeaderCell>Branch</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Snapshots</TableHeaderCell>
              <TableHeaderCell>Review</TableHeaderCell>
              <TableHeaderCell>When</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {builds.map((build) => (
              <BuildRow
                key={build.id}
                projectId={projectId}
                defaultBranch={defaultBranch}
                build={build}
                now={now}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

/**
 * The status a build's row shows. A build stored as `passed` that still has shots to review would
 * read "passed" beside "21 to review", so the list shows it as `changes`, the badge a build with
 * work waiting gets. Builds written under an older verdict rule carry that stale status (the
 * stored value is fixed apart from this view); `verdictOf` and the API are untouched.
 */
function listStatus(build: BuildSummary): string {
  return build.status === "passed" && build.counts.toReview > 0 ? "changes" : build.status;
}

/** The line under a build's branch: its short sha, its PR and a link to the whole branch. */
function BuildMeta({
  projectId,
  defaultBranch,
  build,
}: {
  projectId: string;
  defaultBranch: string;
  build: BuildSummary;
}) {
  return (
    <Cluster gap="xs">
      <Caption as="span" mono>
        {build.commitSha.slice(0, 7)}
      </Caption>
      {build.prNumber !== null && <Caption as="span">PR #{build.prNumber}</Caption>}
      {build.branch !== defaultBranch && (
        <TextLink
          size="sm"
          tone="muted"
          data-testid="branch-link"
          href={hrefTo("/projects/$projectId/branches/$branch", {
            projectId,
            branch: build.branch,
          })}
        >
          whole branch
        </TextLink>
      )}
    </Cluster>
  );
}

/** One build as a stacked block for a phone: branch and status, the mix bar, then review and when. */
function BuildCard({
  projectId,
  defaultBranch,
  build,
  now,
}: {
  projectId: string;
  defaultBranch: string;
  build: BuildSummary;
  now: Date;
}) {
  return (
    <ListRow
      href={hrefTo("/projects/$projectId/builds/$buildId", { projectId, buildId: build.id })}
    >
      <Stack gap="xs" data-testid="build-card">
        <Cluster justify="between" gap="sm">
          <Text as="span" strong>
            {build.branch}
          </Text>
          <StatusBadge status={listStatus(build)} />
        </Cluster>
        <BuildMeta projectId={projectId} defaultBranch={defaultBranch} build={build} />
        <MixBar counts={build.counts} />
        <Cluster justify="between" gap="sm">
          <div>
            <ToReview build={build} defaultBranch={defaultBranch} />
          </div>
          <Text as="span" tone="muted">
            <span data-testid="rel-time" title={build.createdAt.toISOString()}>
              {formatRelative(build.createdAt, now)}
            </span>
          </Text>
        </Cluster>
      </Stack>
    </ListRow>
  );
}

function BuildRow({
  projectId,
  defaultBranch,
  build,
  now,
}: {
  projectId: string;
  defaultBranch: string;
  build: BuildSummary;
  now: Date;
}) {
  return (
    <TableRow data-testid="build-row" stripe={stripeToneOf(build)}>
      <TableCell
        secondary={<BuildMeta projectId={projectId} defaultBranch={defaultBranch} build={build} />}
      >
        <TextLink
          stretch
          href={hrefTo("/projects/$projectId/builds/$buildId", { projectId, buildId: build.id })}
        >
          {build.branch}
        </TextLink>
      </TableCell>
      <TableCell>
        <StatusBadge status={listStatus(build)} />
      </TableCell>
      <TableCell>
        <MixBar counts={build.counts} />
      </TableCell>
      <TableCell>
        <ToReview build={build} defaultBranch={defaultBranch} />
      </TableCell>
      <TableCell tone="muted">
        <span data-testid="rel-time" title={build.createdAt.toISOString()}>
          {formatRelative(build.createdAt, now)}
        </span>
      </TableCell>
    </TableRow>
  );
}
