import {
  Button,
  Callout,
  Card,
  Cluster,
  ListRow,
  MetaList,
  SectionHeading,
  Stack,
  TextLink,
  Text,
} from "@slashsuite/ui-react";
import { ShotThumb, measured } from "#/components/shot-card";
import { ReviewChip, StatusBadge, useHydrated } from "#/components/ui";
import type { MemberBuild } from "#/db/commit-group";
import type { ChangeTotals, CommitReviewGroup } from "#/db/commit-review";
import type { SnapshotView } from "#/db/review";
import { awaitsDecision } from "#/lib/snapshot-groups";
import { hrefTo } from "#/lib/href";
import { viewportLabel } from "#/lib/viewport-label";

/*
 * The parts of the commit's combined review (`/projects/$projectId/commits/$sha`): a section per
 * member that ran, its change rows with accept and reject in place, and the members that did not run.
 */

type Group = CommitReviewGroup;
/** A member that ran on the commit. */
export type Ran = Group & { build: MemberBuild };
export type Shot = SnapshotView;

export const short = (sha: string) => sha.slice(0, 7);
export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** "3 changes · 1 waiting · 2 accepted", leaving out what is zero. */
export function totalsText(t: ChangeTotals): string {
  if (t.changes === 0) return "no changes";
  const parts = [plural(t.changes, "change")];
  if (t.waiting > 0) parts.push(`${t.waiting} waiting`);
  if (t.accepted > 0) parts.push(`${t.accepted} accepted`);
  if (t.rejected > 0) parts.push(`${t.rejected} rejected`);
  return parts.join(" · ");
}

/** A build takes decisions once it is diffed: a change waits, or every one is decided. */
export const decidable = (group: Group) =>
  group.build?.status === "changes" || group.build?.status === "passed";

function RowActions({
  shot,
  open,
  busy,
  onReview,
}: {
  shot: Shot;
  open: boolean;
  busy: boolean;
  onReview: (state: "accepted" | "rejected") => void;
}) {
  const hydrated = useHydrated();
  if (!open) return shot.reviewState !== "pending" && <ReviewChip state={shot.reviewState} />;
  const disabled = !hydrated || busy;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onReview("rejected")}
        data-testid="commit-reject"
      >
        Reject
      </Button>
      <Button
        size="sm"
        disabled={disabled}
        onClick={() => onReview("accepted")}
        data-testid="commit-accept"
      >
        Accept
      </Button>
    </>
  );
}

function ChangeRow({
  group,
  shot,
  src,
  focused,
  busy,
  onReview,
}: {
  group: Ran;
  shot: Shot;
  src: string | undefined;
  focused: boolean;
  busy: boolean;
  onReview: (state: "accepted" | "rejected") => void;
}) {
  const open = decidable(group) && awaitsDecision(shot);
  return (
    <ListRow
      id={`shot-${shot.id}`}
      data-testid="commit-row"
      data-state={shot.reviewState}
      focused={focused}
      data-focused={focused ? "true" : undefined}
      leadingWidth="thumbnail"
      leading={src === undefined ? null : <ShotThumb shot={shot} src={src} />}
      actions={<RowActions shot={shot} open={open} busy={busy} onReview={onReview} />}
    >
      <Stack gap="xs">
        <Cluster gap="xs">
          <TextLink
            data-testid="commit-row-name"
            href={hrefTo("/projects/$projectId/builds/$buildId/snapshots/$snapshotId", {
              projectId: group.projectId,
              buildId: group.build.id,
              snapshotId: shot.id,
            })}
          >
            {shot.name}
          </TextLink>
          <MetaList>
            {shot.platform}
            {shot.browser}
            {viewportLabel(shot.viewport)}
            {shot.theme}
          </MetaList>
        </Cluster>
        <Text>{measured(shot, false)}</Text>
        {shot.reviewedBy && (
          <Text tone="muted" data-testid="commit-row-who">
            {shot.reviewState} by {shot.reviewedBy}
          </Text>
        )}
      </Stack>
    </ListRow>
  );
}

/** A subproject that did not run here: what it holds is its last build's, so it counts nothing. */
function NotRunRow({ group }: { group: Group }) {
  const last = group.lastBuild;
  return (
    <ListRow data-testid="commit-not-run-row">
      <Cluster gap="xs">
        <Text as="span">{group.name}</Text>
        <Text as="span" tone="muted">
          not run on this commit (unchanged)
        </Text>
        {last && (
          <TextLink
            mono
            data-testid="commit-last-build"
            href={hrefTo("/projects/$projectId/builds/$buildId", {
              projectId: group.projectId,
              buildId: last.id,
            })}
          >
            last build {short(last.commitSha)}
          </TextLink>
        )}
      </Cluster>
    </ListRow>
  );
}

/** The subprojects that did not run on the commit, after the ones that did. */
export function NotRun({ groups }: { groups: Group[] }) {
  if (groups.length === 0) return null;
  return (
    <Stack as="section" gap="xs" data-testid="commit-not-run">
      <SectionHeading>
        Not run on this commit{" "}
        <Text as="span" tone="muted">
          ({groups.length})
        </Text>
      </SectionHeading>
      <Card flush>
        <Stack divided>
          {groups.map((group) => (
            <NotRunRow key={group.projectId} group={group} />
          ))}
        </Stack>
      </Card>
    </Stack>
  );
}

/** A member that ran on the commit: its heading, totals, build link and changes. */
export function GroupSection({
  group,
  thumbs,
  focusId,
  busy,
  onReview,
}: {
  group: Ran;
  thumbs: Record<string, string>;
  focusId: string | null;
  /** A decision in flight anywhere on the page: every row waits for it, as the keys do. */
  busy: boolean;
  onReview: (group: Ran, shot: Shot, state: "accepted" | "rejected") => void;
}) {
  return (
    <Stack as="section" gap="xs" data-testid="commit-group" data-project={group.name}>
      <Cluster gap="xs">
        <SectionHeading>{group.name}</SectionHeading>
        <StatusBadge status={group.build.status} />
        <Text as="span" tone="muted" data-testid="commit-group-totals">
          {totalsText(group.totals)}
        </Text>
        <TextLink
          href={hrefTo("/projects/$projectId/builds/$buildId", {
            projectId: group.projectId,
            buildId: group.build.id,
          })}
        >
          build page
        </TextLink>
      </Cluster>
      {group.build.error && (
        <Callout tone="danger" data-testid="commit-group-error">
          {group.build.error}
        </Callout>
      )}
      {group.snapshots.length > 0 && (
        <Card flush>
          <Stack divided>
            {group.snapshots.map((shot) => (
              <ChangeRow
                key={shot.id}
                group={group}
                shot={shot}
                src={thumbs[shot.id]}
                focused={shot.id === focusId}
                busy={busy}
                onReview={(state) => onReview(group, shot, state)}
              />
            ))}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
