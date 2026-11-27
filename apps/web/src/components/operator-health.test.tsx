// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { type Reading, ok, unavailable } from "#/lib/reading";
import { render, screen } from "#/test/render";
import { DbSizeMark } from "./operator-health";

/**
 * The /_admin mark beside the database size: there past the alert line, absent under it or when
 * the size was not read. Where the line sits and its words are `lib/size-alert.test.ts`'s tables.
 */

test("past 70% of the cap the size is marked, with what happens at the cap", async () => {
  await render(<DbSizeMark reading={ok(7.1e9)} />);
  expect(
    screen.getByText("Over the alert line: 7.1 GB, 71% of the 10 GB cap. Writes fail at the cap."),
  ).toBeTruthy();
});

test.each<[string, Reading<number>]>([
  ["under the line", ok(6.9e9)],
  ["unread", unavailable("no binding")],
])("%s, there is no mark", async (_, reading) => {
  const { container } = await render(<DbSizeMark reading={reading} />);
  expect(container.textContent).toBe("");
});
