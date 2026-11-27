import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { SMOKE } from "#/db/smoke-account";

/**
 * The smoke of a deployed review app (`moon run web:smoke`), run after every deploy against
 * `SMOKE_BASE_URL`: pixelslash.dev or a self-host. It only reads, so a run leaves no row behind (the
 * token's `last_used_at` is the one write, at most every five minutes). The account is the synthetic
 * smoke org's (`src/db/smoke-account.ts`); its token comes from `SMOKE_TOKEN` or `SMOKE_TOKEN_FILE`.
 */

const base = (process.env["SMOKE_BASE_URL"] ?? "").replace(/\/+$/, "");
if (!base)
  throw new Error(
    "SMOKE_BASE_URL is not set: the deployment to check, such as https://pixelslash.dev",
  );

function smokeToken(): string {
  const file = process.env["SMOKE_TOKEN_FILE"];
  const token = (file ? readFileSync(file, "utf8") : (process.env["SMOKE_TOKEN"] ?? "")).trim();
  if (!token) throw new Error("set SMOKE_TOKEN or SMOKE_TOKEN_FILE to the smoke account's token");
  return token;
}

const get = (path: string, token?: string) =>
  fetch(`${base}${path}`, {
    redirect: "manual",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe(`the deployment at ${base}`, () => {
  test("serves the sign-in page", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Sign in with (GitHub|Google)/);
  });

  test("answers an unknown path with a 404", async () => {
    const res = await get(`/smoke-no-such-page-${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  test("signs the smoke account in, and it sees its org", async () => {
    const token = smokeToken();
    const me = await get("/api/v1/me", token);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      kind: "user",
      user: { id: SMOKE.userId, login: SMOKE.login },
    });

    const list = await get("/api/v1/projects", token);
    expect(list.status).toBe(200);
    const { projects } = await list.json<{ projects: { id: string; org: { id: string } }[] }>();
    expect(projects.map((p) => [p.id, p.org.id])).toContainEqual([SMOKE.projectId, SMOKE.orgId]);
  });
});
