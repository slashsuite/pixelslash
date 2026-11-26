/**
 * A deployment's lists of GitHub logins (`PIXELSLASH_ADMIN_LOGINS`, `PIXELSLASH_ALLOWED_GITHUB_LOGINS`):
 * comma-separated, compared lowercased because GitHub logins are case-insensitive.
 */

/** The logins of the list, lowercased; blanks are dropped. */
export function loginsOf(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter((login) => login.length > 0);
}

/**
 * Whether a login may sign in under `PIXELSLASH_ALLOWED_GITHUB_LOGINS`: anyone when the list is
 * unset or empty (the default, and the hosted app), else only a login on it.
 */
export function signInAllowed(login: string, raw: string | undefined): boolean {
  const allowed = loginsOf(raw);
  return allowed.length === 0 || allowed.includes(login.toLowerCase());
}
