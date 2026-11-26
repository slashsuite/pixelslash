import { describe, expect, test } from "vitest";
import { signInAllowed } from "./logins";

describe("signInAllowed", () => {
  test("no list, or an empty one, lets anyone in", () => {
    expect(signInAllowed("ada", undefined)).toBe(true);
    expect(signInAllowed("ada", " , ")).toBe(true);
  });

  test("a list lets in only its logins, case-insensitively", () => {
    expect(signInAllowed("ADA", "ada,grace")).toBe(true);
    expect(signInAllowed("grace", "Ada, Grace")).toBe(true);
    expect(signInAllowed("eve", "ada,grace")).toBe(false);
    // A Google-only user's login is their email, never on a list of GitHub logins.
    expect(signInAllowed("ada@example.com", "ada")).toBe(false);
  });
});
