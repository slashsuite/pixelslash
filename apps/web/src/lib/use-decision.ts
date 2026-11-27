import { useCallback, useRef, useState } from "react";
import type { ShotRef } from "#/db/change-set";
import type { BuildStatus } from "#/db/schema";

export type DecisionState = "accepted" | "rejected";

/** A commit's change set, by its top-level project and sha. */
export type CommitRef = { projectId: string; sha: string };

/**
 * What a decision on the server answers: the build's status after the write, the next shot to
 * review (in this build, or another build of the commit's change set), and the change set's commit.
 */
export type DecisionReply = {
  buildStatus: BuildStatus;
  next: ShotRef | null;
  commit: CommitRef | null;
};

type Options = {
  /** False when the build takes no decisions: `decide` then does nothing. */
  reviewable: boolean;
  /** Sends the decision to the server. */
  review: (state: DecisionState) => Promise<DecisionReply>;
  /** Moves to another shot, of this build or another. */
  go: (shot: ShotRef) => void;
  /** Moves to the build page. */
  toBuild: () => void;
  /** Moves to the commit's page, where its whole change set is listed. */
  toCommit: (commit: CommitRef) => void;
};

/** Where the reviewer goes once a decision lands. */
export type Destination =
  | { to: "shot"; shot: ShotRef }
  | { to: "commit"; commit: CommitRef }
  | { to: "build" };

/**
 * Where a landed decision sends the reviewer: an accept on a build that still takes decisions goes
 * to the next shot the reply names, else the change set's commit, else the build page. A reject, or
 * a build failed meanwhile (another reviewer's reject can land between this accept and the reply),
 * goes to the build page.
 */
export function destinationOf(state: DecisionState, reply: DecisionReply): Destination {
  const stillDecidable = reply.buildStatus === "changes" || reply.buildStatus === "passed";
  if (state !== "accepted" || !stillDecidable) return { to: "build" };
  if (reply.next) return { to: "shot", shot: reply.next };
  if (reply.commit) return { to: "commit", commit: reply.commit };
  return { to: "build" };
}

/**
 * Accept or reject the shot on screen. An accept that lands moves the reviewer on to the next shot
 * still awaiting one: in this build first, then in the other builds of the commit's change set (a
 * project and its subprojects). With none left it goes to the commit's page for a change set, and
 * to the build page for a lone build; the reply carries that shot, read
 * after the decision because this shot's loaded data predates decisions made on the others since it
 * was opened, so a decision is one server call. A reject always goes to the build page: it fails
 * the build, and a failed build takes no more decisions, so the next shot would be a dead screen.
 * Only a refused decision is an error.
 */
export function useDecision({ reviewable, review, go, toBuild, toCommit }: Options) {
  const [busy, setBusy] = useState(false);
  // A ref as well as state: a second key in the same task as the first must see the first in flight.
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const decide = useCallback(
    (state: DecisionState) => {
      if (!reviewable || inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      review(state)
        .then(
          (reply) => {
            const where = destinationOf(state, reply);
            if (where.to === "shot") go(where.shot);
            else if (where.to === "commit") toCommit(where.commit);
            else toBuild();
          },
          (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
        )
        .finally(() => {
          inFlight.current = false;
          setBusy(false);
        });
    },
    [reviewable, review, go, toBuild, toCommit],
  );
  return { busy, error, decide };
}
