// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { type DecisionReply, type DecisionState, useDecision } from "#/lib/use-decision";
import { act, renderHook, waitFor } from "#/test/render";

/**
 * A decision is one server call. The hook is driven with a stubbed `review` (the server fn) and
 * `go`, so the calls it makes are the whole proof: nothing here can read the build again. Where
 * each reply sends the reviewer is `destinationOf`'s table (`use-decision.test.ts`); this proves
 * the hook follows it, holds a second key, and keeps a refusal on screen.
 */

function mount(reply: () => Promise<DecisionReply>, reviewable = true) {
  const calls: string[] = [];
  const { result: hook } = renderHook(() =>
    useDecision({
      reviewable,
      review: (state) => {
        calls.push(`review ${state}`);
        return reply();
      },
      go: (shot) => calls.push(`go ${shot.buildId}/${shot.snapshotId}`),
      toBuild: () => calls.push("build"),
      toCommit: (commit) => calls.push(`commit ${commit.sha}`),
    }),
  );
  /** Presses a decision key and waits until the call it made has settled. */
  const press = async (state: DecisionState) => {
    await act(async () => hook.current.decide(state));
    await waitFor(() => expect(hook.current.busy).toBe(false));
  };
  return { calls, hook, press };
}

const at = (snapshotId: string, buildId = "b1") => ({ projectId: "p1", buildId, snapshotId });
const reply = (
  buildStatus: DecisionReply["buildStatus"],
  next: DecisionReply["next"],
  commit: DecisionReply["commit"] = null,
): DecisionReply => ({ buildStatus, next, commit });

describe("deciding on the shot on screen", () => {
  it("an accept calls the server once, then moves to the shot it named", async () => {
    const { calls, press } = mount(() => Promise.resolve(reply("changes", at("s2"))));
    await press("accepted");
    expect(calls).toEqual(["review accepted", "go b1/s2"]);
  });

  it("a refused decision stays on the shot and says why", async () => {
    const { calls, hook, press } = mount(() => Promise.reject(new Error("build is errored")));
    await press("accepted");
    expect(calls).toEqual(["review accepted"]);
    await waitFor(() => expect(hook.current.error).toBe("build is errored"));
    expect(hook.current.busy).toBe(false);
  });

  it("a second key while the first is in flight is ignored", async () => {
    const { promise: pending, resolve: settle } = Promise.withResolvers<DecisionReply>();
    const { calls, hook } = mount(() => pending);
    // Both keys land in one task, before React re-renders with `busy` set.
    await act(async () => {
      hook.current.decide("accepted");
      hook.current.decide("accepted");
    });
    expect(calls).toEqual(["review accepted"]);
    expect(hook.current.busy).toBe(true);
    await act(async () => settle(reply("changes", at("s2"))));
    await waitFor(() => expect(hook.current.busy).toBe(false));
    expect(calls).toEqual(["review accepted", "go b1/s2"]);
  });

  it("a build that takes no decisions sends nothing", async () => {
    const { calls, press } = mount(() => Promise.resolve(reply("changes", at("s2"))), false);
    await press("accepted");
    expect(calls).toEqual([]);
  });
});
