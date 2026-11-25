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
} from "@hackcove/ui-react";
import { Link } from "@tanstack/react-router";
import { ShotThumb, measured } from "#/components/shot-card";
import { ReviewChip, StatusBadge, useHydrated } from "#/components/ui";
import type { MemberBuild } from "#/db/commit-group";
import type { ChangeTotals, CommitReviewGroup } from "#/db/commit-review";
import type { SnapshotView } from "#/db/review";
import { awaitsDecision } from "#/lib/snapshot-groups";

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
  divided,
  onReview,
}: {
  group: Ran;
  shot: Shot;
  src: string | undefined;
  focused: boolean;
  busy: boolean;
  divided: boolean;
  onReview: (state: "accepted" | "rejected") => void;
}) {
  const open = decidable(group) && awaitsDecision(shot);
  return (
    <ListRow
      static
      divided={divided}
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
        <Cluster gap="xs" wrap>
          <TextLink
            data-testid="commit-row-name"
            render={(props) => (
              <Link
                to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
                params={{
                  projectId: group.projectId,
                  buildId: group.build.id,
                  snapshotId: shot.id,
                }}
                {...props}
              />
            )}
          >
            {shot.name}
          </TextLink>
          <MetaList>
            {shot.platform}
            {shot.browser}
            {shot.viewport}
            {shot.theme}
          </MetaList>
        </Cluster>
        <Text as="p">{measured(shot, false)}</Text>
        {shot.reviewedBy && (
          <Text as="p" tone="muted" data-testid="commit-row-who">
            {shot.reviewState} by {shot.reviewedBy}
          </Text>
        )}
      </Stack>
    </ListRow>
  );
}

/** A subproject that did not run here: what it holds is its last build's, so it counts nothing. */
function NotRunRow({ group, divided }: { group: Group; divided: boolean }) {
  const last = group.lastBuild;
  return (
    <ListRow static divided={divided} data-testid="commit-not-run-row">
      <Cluster gap="xs" wrap>
        <Text>{group.name}</Text>
        <Text tone="muted">not run on this commit (unchanged)</Text>
        {last && (
          <TextLink
            mono
            data-testid="commit-last-build"
            render={(props) => (
              <Link
                to="/projects/$projectId/builds/$buildId"
                params={{ projectId: group.projectId, buildId: last.id }}
                {...props}
              />
            )}
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
        Not run on this commit <Text tone="muted">({groups.length})</Text>
      </SectionHeading>
      <Card as="div" flush>
        {groups.map((group, index) => (
          <NotRunRow key={group.projectId} group={group} divided={index > 0} />
        ))}
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
      <Cluster gap="xs" wrap>
        <SectionHeading>{group.name}</SectionHeading>
        <StatusBadge status={group.build.status} />
        <Text tone="muted" data-testid="commit-group-totals">
          {totalsText(group.totals)}
        </Text>
        <TextLink
          render={(props) => (
            <Link
              to="/projects/$projectId/builds/$buildId"
              params={{ projectId: group.projectId, buildId: group.build.id }}
              {...props}
            />
          )}
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
        <Card as="div" flush>
          {group.snapshots.map((shot, index) => (
            <ChangeRow
              key={shot.id}
              group={group}
              shot={shot}
              src={thumbs[shot.id]}
              focused={shot.id === focusId}
              busy={busy}
              divided={index > 0}
              onReview={(state) => onReview(group, shot, state)}
            />
          ))}
        </Card>
      )}
    </Stack>
  );
}
