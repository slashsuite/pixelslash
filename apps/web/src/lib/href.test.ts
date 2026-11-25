import { describe, expect, it } from "vitest";
import { hrefTo } from "./href";

describe("hrefTo", () => {
  it("fills the params, encoding each one", () => {
    expect(
      hrefTo("/projects/$projectId/branches/$branch", { projectId: "p1", branch: "feat/a b" }),
    ).toBe("/projects/p1/branches/feat%2Fa%20b");
  });

  it("writes the search and the hash as the router does", () => {
    expect(hrefTo("/orgs", {}, { search: { org: "o1", tab: "members" } })).toBe(
      "/orgs?org=o1&tab=members",
    );
    expect(hrefTo("/orgs", {}, { search: {} })).toBe("/orgs");
    expect(hrefTo("/projects/$projectId/flakes", { projectId: "p" }, { hash: "flake-1" })).toBe(
      "/projects/p/flakes#flake-1",
    );
  });

  it("throws on a missing param rather than writing a broken path", () => {
    expect(() => hrefTo("/projects/$projectId", {})).toThrow("$projectId");
  });
});
