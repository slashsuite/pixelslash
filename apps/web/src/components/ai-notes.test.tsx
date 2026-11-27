// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { render, screen } from "#/test/render";
import { AiExplanation, aiFiltered, type JudgedShot } from "./ai-notes";

/** Only the fields the section reads; the rest of a snapshot row is not its business. */
const changed = (over: Partial<JudgedShot>): JudgedShot => ({
  diffStatus: "changed",
  aiReview: null,
  aiPending: false,
  aiError: null,
  reviewState: "pending",
  reviewedBy: null,
  ...over,
});

const section = (snapshot: JudgedShot) => render(<AiExplanation snapshot={snapshot} />);

test("a failed judge says it failed and why, never that there is no judge", async () => {
  await section(changed({ aiError: "the model answered 502" }));
  expect(
    screen.getByText(/judge failed: the model answered 502\. Review the pixels\./),
  ).toBeTruthy();
  expect(screen.queryByText(/no judge/)).toBeNull();
});

test("a failure that already ends in a full stop does not double it", async () => {
  await section(changed({ aiError: "timed out." }));
  expect(screen.getByText(/judge failed: timed out\. Review/)).toBeTruthy();
});

test("with no error and no explanation the shot is reviewed as plain pixels", async () => {
  await section(changed({}));
  expect(screen.getByText(/skip: no judge\. Review the pixels\./)).toBeTruthy();
  expect(screen.queryByText(/judge failed/)).toBeNull();
});

test("a shot still waiting on the queue is explaining, whatever an earlier run said", async () => {
  await section(changed({ aiPending: true, aiError: "old failure" }));
  expect(screen.getByText(/explaining…/)).toBeTruthy();
  expect(screen.queryByText(/judge failed/)).toBeNull();
});

const auto = { model: "m", at: 0, regions: [], autoPassed: true };

test.each<[string, Partial<JudgedShot>, boolean]>([
  ["auto-passed and no person decided", { aiReview: auto, reviewState: "accepted" }, true],
  [
    "auto-passed, then a person decided",
    { aiReview: auto, reviewState: "accepted", reviewedBy: "ada" },
    false,
  ],
  ["auto-pass not applied yet", { aiReview: auto, reviewState: "pending" }, false],
  ["no model", {}, false],
])("a shot %s is AI-filtered: %s", (_, over, filtered) => {
  expect(aiFiltered(changed(over))).toBe(filtered);
});
