import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ok, unavailable } from "#/lib/reading";
import { DbSizeMark } from "./operator-health";

// The /_admin mark beside the database size: there past the alert line, absent under it.
const mark = (reading: Parameters<typeof DbSizeMark>[0]["reading"]) =>
  renderToStaticMarkup(<DbSizeMark reading={reading} />);

test("past 70% of the cap the size is marked", () => {
  const html = mark(ok(7.1e9));
  expect(html).toContain('data-testid="admin-db-alert"');
  expect(html).toContain("7.1 GB, 71% of the 10 GB cap");
});

test("under the line, or unread, there is no mark", () => {
  expect(mark(ok(6.9e9))).toBe("");
  expect(mark(unavailable("no binding"))).toBe("");
});
