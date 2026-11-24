import { Breadcrumbs, Callout, Cluster, ListLayout, Text } from "@hackcove/ui-react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  GroupSection,
  NotRun,
  type Ran,
  type Shot,
  decidable,
  plural,
  short,
  totalsText,
} from "#/components/commit-review";
import { orgCrumb, projectCrumbs } from "#/components/crumbs";
import { ShortcutHelp } from "#/components/snapshot-panels";
import { Page } from "#/components/ui";
import type { CommitReview } from "#/db/commit-review";
import { awaitsDecision } from "#/lib/snapshot-groups";
import { useReviewKeys } from "#/lib/use-review-keys";
import { getCommitReview } from "#/server/commit-review";
import { reviewShot } from "#/server/fns";

export const Route = createFileRoute("/projects/$projectId/commits/$sha")({
  loader: ({ params }) =>
    getCommitReview({ data: { projectId: params.projectId, sha: params.sha } }),
  component: CommitReviewPage,
});

type Step = { group: Ran; shot: Shot };
type Decision = "accepted" | "rejected";

const waits = ({ group, shot }: Step) => decidable(group) && awaitsDecision(shot);

/** The steps either side of `at`, where j and k go. */
const neighbours = (walk: Step[], at: number) => ({
  nextId: walk[at + 1]?.shot.id ?? null,
  previousId: at > 0 ? (walk[at - 1]?.shot.id ?? null) : null,
});

/**
 * The keyboard walk over every change, group by group, as the page lists them: focus starts on the
 * first that waits, j and k move, a and r decide the focused one and move on to the next that waits.
 */
function useWalk(ran: Ran[]) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const walk: Step[] = ran.flatMap((group) => group.snapshots.map((shot) => ({ group, shot })));
  const [chosen, setFocusId] = useState<string | null>(null);
  // The first that waits until one is chosen, and again when the chosen one is gone (a rerun, another commit).
  const fallback = (walk.find(waits) ?? walk[0])?.shot.id ?? null;
  const focusId = walk.some((step) => step.shot.id === chosen) ? chosen : fallback;
  const at = walk.findIndex((step) => step.shot.id === focusId);
  const focused = walk[at];

  useEffect(() => {
    if (focusId) document.getElementById(`shot-${focusId}`)?.scrollIntoView({ block: "nearest" });
  }, [focusId]);

  const review = async (group: Ran, shot: Shot, state: Decision) => {
    setError(null);
    setFocusId(shot.id);
    setBusy(true);
    try {
      // The member's own decision, on its own build's row: the build page shows the same.
      await reviewShot({ data: { projectId: group.projectId, snapshotId: shot.id, state } });
      const from = walk.findIndex((step) => step.shot.id === shot.id);
      const later = walk.slice(from + 1).find(waits);
      if (later) setFocusId(later.shot.id);
      await router.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useReviewKeys({
    canDecide: focused !== undefined && waits(focused) && !busy,
    ...neighbours(walk, at),
    go: (id) => {
      if (id) setFocusId(id);
    },
    decide: (state) => {
      if (focused) void review(focused.group, focused.shot, state);
    },
    help: () => setHelpOpen(true),
    helpOpen,
  });

  return { focusId, busy, error, review, helpOpen, closeHelp: () => setHelpOpen(false) };
}

function Meta({ head, totals, ran }: Pick<CommitReview, "head" | "totals"> & { ran: number }) {
  return (
    <Cluster gap="xs" wrap data-testid="commit-meta">
      {head && <Text tone="muted">{head.branch}</Text>}
      {head && head.prNumber !== null && <Text>PR #{head.prNumber}</Text>}
      <Text data-testid="commit-totals">{totalsText(totals)}</Text>
      <Text tone="muted">
        across {plural(ran, "project")}; j and k move, a and r decide, ? lists the keys
      </Text>
    </Cluster>
  );
}

function CommitReviewPage() {
  const { org, project, sha, groups, totals, head, thumbs } = Route.useLoaderData();
  const ran = groups.flatMap((g): Ran[] => (g.build ? [{ ...g, build: g.build }] : []));
  const walk = useWalk(ran);
  return (
    <Page>
      <ListLayout
        breadcrumbs={
          <Breadcrumbs
            crumbs={[orgCrumb(org), ...projectCrumbs(project), `commit ${short(sha)}`]}
          />
        }
        title={`${project.name} · ${short(sha)}`}
      >
        <Meta head={head} totals={totals} ran={ran.length} />
        {walk.error && (
          <Callout tone="danger" role="alert">
            {walk.error}
          </Callout>
        )}
        {ran.map((group) => (
          <GroupSection
            key={group.projectId}
            group={group}
            thumbs={thumbs}
            focusId={walk.focusId}
            busy={walk.busy}
            onReview={(g, shot, state) => void walk.review(g, shot, state)}
          />
        ))}
        <NotRun groups={groups.filter((g) => g.build === null)} />
      </ListLayout>
      {walk.helpOpen && <ShortcutHelp onClose={walk.closeHelp} />}
    </Page>
  );
}
