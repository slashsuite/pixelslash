import { type ReactNode, useState } from "react";
import {
  Button,
  Card,
  Cluster,
  ListRow,
  MetaList,
  SectionHeading,
  Stack,
  TextLink,
  Text,
} from "@slashsuite/ui-react";
import { ShotThumb } from "#/components/shot-card";
import { ReviewChip, useHydrated } from "#/components/ui";
import {
  MAIN_GROUPS,
  type BranchShot,
  type MainGroup,
  decisionText,
  measuredFacts,
} from "#/lib/branch-review";
import { hrefTo } from "#/lib/href";

const MAIN_HEADING: Record<MainGroup, string> = {
  rejected: "Rejected",
  waiting: "Waiting",
  accepted: "Accepted",
  same: "Same as main",
  unmeasured: "Not measured against main",
};

/** What was measured against main, in the row's words. */
function againstMainText(shot: BranchShot): string {
  if (shot.mainGroup === "unmeasured") return "not measured against main";
  if (shot.mainDiffStatus === "new") return "new: no accepted shot on main at the merge-base";
  return `${measuredFacts(shot.mainDiffStatus, shot.mainDiffResult)} against main`;
}

/** Accept or reject a waiting shot; any other shot shows its decision. */
function MainRowActions({
  shot,
  reviewable,
  onReview,
}: {
  shot: BranchShot;
  reviewable: boolean;
  onReview: (snapshotId: string, state: "accepted" | "rejected") => Promise<void>;
}) {
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  if (shot.mainGroup !== "waiting") {
    return shot.decision && <ReviewChip state={shot.decision.state} />;
  }
  const review = (state: "accepted" | "rejected") => {
    setBusy(true);
    void onReview(shot.id, state).finally(() => setBusy(false));
  };
  const disabled = !hydrated || busy || !reviewable;
  return (
    <>
      <Button
        variant="outline"
        disabled={disabled}
        onClick={() => review("rejected")}
        size="sm"
        data-testid="main-reject"
      >
        Reject
      </Button>
      <Button
        disabled={disabled}
        onClick={() => review("accepted")}
        size="sm"
        data-testid="main-accept"
      >
        Accept
      </Button>
    </>
  );
}

function MainRow({
  projectId,
  buildId,
  shot,
  src,
  reviewable,
  onReview,
}: {
  projectId: string;
  buildId: string;
  shot: BranchShot;
  src: string | undefined;
  reviewable: boolean;
  onReview: (snapshotId: string, state: "accepted" | "rejected") => Promise<void>;
}) {
  const shown = shot.mainDiffStatus === "changed" || shot.mainDiffStatus === "new";
  // The thumbnail draws the boxes measured against main, over the same branch shot.
  const thumb = { ...shot, diffStatus: shot.mainDiffStatus, diffResult: shot.mainDiffResult };
  return (
    <ListRow
      data-testid="main-row"
      data-group={shot.mainGroup}
      leadingWidth="thumbnail"
      leading={shown ? <ShotThumb shot={thumb} src={src} /> : null}
      actions={<MainRowActions shot={shot} reviewable={reviewable} onReview={onReview} />}
    >
      <Stack gap="xs">
        <Cluster gap="xs">
          <TextLink
            data-testid="main-row-name"
            href={hrefTo("/projects/$projectId/builds/$buildId/snapshots/$snapshotId", {
              projectId,
              buildId,
              snapshotId: shot.id,
            })}
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
        <Text data-testid="main-row-what">{againstMainText(shot)}</Text>
        {shot.decision && (
          <Text tone="muted" data-testid="main-row-who">
            {decisionText(shot)}
          </Text>
        )}
      </Stack>
    </ListRow>
  );
}

function Fold({ count, noun, children }: { count: number; noun: string; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  if (shown) return children;
  return (
    <Button variant="dashed" data-testid="main-fold-show" onClick={() => setShown(true)}>
      {count} shot{count === 1 ? "" : "s"} folded away: {noun}. Show
    </Button>
  );
}

const FOLDED: Partial<Record<MainGroup, string>> = {
  same: "identical to main's accepted shots",
  unmeasured: "not measured against main, so not counted",
};

/** The against-main groups: what stops a merge first; shots that match main are folded away. */
export function MainGroups({
  projectId,
  buildId,
  shots,
  thumbs,
  reviewable,
  onReview,
}: {
  projectId: string;
  buildId: string;
  shots: BranchShot[];
  thumbs: Record<string, string>;
  reviewable: boolean;
  onReview: (snapshotId: string, state: "accepted" | "rejected") => Promise<void>;
}) {
  return (
    <Stack>
      {MAIN_GROUPS.map((group) => {
        const rows = shots.filter((shot) => shot.mainGroup === group);
        if (rows.length === 0) return null;
        const list = (
          <Card flush>
            <Stack divided>
              {rows.map((shot) => (
                <MainRow
                  key={shot.id}
                  projectId={projectId}
                  buildId={buildId}
                  shot={shot}
                  src={thumbs[shot.id]}
                  reviewable={reviewable}
                  onReview={onReview}
                />
              ))}
            </Stack>
          </Card>
        );
        const folded = FOLDED[group];
        return (
          <Stack as="section" key={group} gap="xs" data-testid={`main-group-${group}`}>
            <SectionHeading>
              {MAIN_HEADING[group]}{" "}
              <Text as="span" tone="muted">
                ({rows.length})
              </Text>
            </SectionHeading>
            {folded ? (
              <Fold count={rows.length} noun={folded}>
                {list}
              </Fold>
            ) : (
              list
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}
