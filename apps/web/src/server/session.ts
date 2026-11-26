import { redirect } from "@tanstack/react-router";
import { deleteCookie, getCookie, getRequestUrl, setCookie } from "@tanstack/react-start/server";
import { type User, createSession, endSession, sessionUser } from "#/db/users";
import { signInAllowed } from "#/lib/logins";
import { allowedGithubLogins, database } from "./env";

const COOKIE = "ps_session";

/**
 * The signed-in user, or null. A session from before the login was taken off the allowlist (or
 * before there was one) counts as signed out.
 */
export async function viewer(): Promise<User | null> {
  const token = getCookie(COOKIE);
  const user = token ? await sessionUser(database(), token) : null;
  return user && signInAllowed(user.login, allowedGithubLogins()) ? user : null;
}

/** For a signed-in page or action: no session sends the browser to sign in. */
export async function requireViewer(): Promise<User> {
  const user = await viewer();
  if (!user) throw redirect({ to: "/" });
  return user;
}

export async function startSession(userId: string): Promise<void> {
  setCookie(COOKIE, await createSession(database(), userId), {
    httpOnly: true,
    secure: getRequestUrl().protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
}

export async function stopSession(): Promise<void> {
  const token = getCookie(COOKIE);
  if (token) await endSession(database(), token);
  deleteCookie(COOKIE, { path: "/" });
}
