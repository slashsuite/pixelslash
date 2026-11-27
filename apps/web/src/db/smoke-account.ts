import { sha256Hex } from "#/lib/crypto";
import { USER_PREFIX } from "./tokens";

/**
 * The deployed smoke's account: one user, one synthetic org (`is_smoke`, so no count or admin figure
 * includes it, `synthetic.ts`), one project, and one personal token. The ids are fixed, so applying
 * the SQL again changes nothing but the token, and the smoke itself only reads: a run adds no row.
 */
export const SMOKE = {
  userId: "smoke-user",
  // GitHub logins have no underscore, so no real sign-in can ever take this one.
  login: "pixelslash_smoke",
  orgId: "smoke-org",
  orgName: "PixelSlash smoke",
  projectId: "smoke-project",
  projectName: "smoke",
  tokenId: "smoke-token",
} as const;

/**
 * The statements that make (or refresh) the smoke account on a migrated database, as one SQL text
 * for `wrangler d1 execute --file`. Only the token's hash is in it, never the token. A token
 * already there is replaced, and a revoked one is live again.
 */
export async function smokeAccountSql(token: string): Promise<string> {
  if (!token.startsWith(USER_PREFIX))
    throw new Error(`the smoke token must start with ${USER_PREFIX}`);
  const hash = await sha256Hex(token);
  const prefix = token.slice(0, USER_PREFIX.length + 4);
  if (!/^[A-Za-z0-9_-]+$/.test(prefix))
    throw new Error("the smoke token is not one randomToken made");
  const s = SMOKE;
  return [
    `INSERT INTO users (id, login, name) VALUES ('${s.userId}', '${s.login}', 'PixelSlash smoke') ON CONFLICT(id) DO NOTHING;`,
    `INSERT INTO orgs (id, name, is_smoke) VALUES ('${s.orgId}', '${s.orgName}', 1) ON CONFLICT(id) DO UPDATE SET is_smoke = 1;`,
    `INSERT INTO members (org_id, user_id, role) VALUES ('${s.orgId}', '${s.userId}', 'owner') ON CONFLICT(org_id, user_id) DO UPDATE SET role = 'owner';`,
    `INSERT INTO projects (id, org_id, name) VALUES ('${s.projectId}', '${s.orgId}', '${s.projectName}') ON CONFLICT(id) DO NOTHING;`,
    `INSERT INTO user_tokens (id, user_id, name, prefix, hash) VALUES ('${s.tokenId}', '${s.userId}', 'smoke', '${prefix}', '${hash}') ON CONFLICT(id) DO UPDATE SET prefix = excluded.prefix, hash = excluded.hash, revoked_at = NULL, expires_at = NULL;`,
    "",
  ].join("\n");
}
