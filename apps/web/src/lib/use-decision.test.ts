import { describe, expect, test } from "vitest";
import {
  type DecisionReply,
  type DecisionState,
  type Destination,
  destinationOf,
} from "./use-decision";

/** Where a landed decision sends the reviewer. The hook that calls it is `use-decision.hook.test.tsx`. */

const shot = (snapshotId: string, buildId = "b1") => ({ projectId: "p1", buildId, snapshotId });
const commit = { projectId: "top", sha: "abc" };

describe("where a decision sends the reviewer", () => {
  test.each<[string, DecisionState, DecisionReply, Destination]>([
    [
      "an accept moves to the shot the reply named",
      "accepted",
      { buildStatus: "changes", next: shot("s2"), commit: null },
      { to: "shot", shot: shot("s2") },
    ],
    [
      "an accept moves on to a shot in another build of the commit's change set",
      "accepted",
      { buildStatus: "passed", next: shot("s9", "b2"), commit },
      { to: "shot", shot: shot("s9", "b2") },
    ],
    [
      "an accept with nothing left in the change set goes to the commit's page",
      "accepted",
      { buildStatus: "passed", next: null, commit },
      { to: "commit", commit },
    ],
    [
      "an accept with nothing left in a lone build goes to the build page",
      "accepted",
      { buildStatus: "passed", next: null, commit: null },
      { to: "build" },
    ],
    [
      "an accept whose build failed meanwhile goes to the build page, whatever shot the reply named",
      "accepted",
      { buildStatus: "failed", next: shot("s2"), commit },
      { to: "build" },
    ],
    [
      "an accept on a build no longer taking decisions goes to the build page",
      "accepted",
      { buildStatus: "errored", next: shot("s2"), commit: null },
      { to: "build" },
    ],
    [
      "a reject goes to the build page",
      "rejected",
      { buildStatus: "failed", next: null, commit: null },
      { to: "build" },
    ],
    [
      "a reject goes to the build page even when the reply names a next shot",
      "rejected",
      { buildStatus: "changes", next: shot("s2"), commit },
      { to: "build" },
    ],
  ])("%s", (_, state, reply, where) => {
    expect(destinationOf(state, reply)).toEqual(where);
  });
});
