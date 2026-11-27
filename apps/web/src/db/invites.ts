import { type SQL, and, eq, isNotNull, or, sql } from "drizzle-orm";
import { type Db, ForbiddenError, NotFoundError } from "./db";
import { requireMember } from "./orgs";
import { members, users } from "./schema";
import { invites } from "./schema-invites";
import type { User } from "./users";

/**
 * The names a sign-in takes an invite up by (`acceptInvites`): a GitHub user's login, lowercased,
 * and a verified email.
 */
function namesOf(user: { githubId: number | null; login: string; email: string | null }): SQL[] {
  return [
    user.githubId === null ? undefined : eq(invites.githubLogin, user.login.toLowerCase()),
    user.email ? eq(invites.email, user.email) : undefined,
  ].filter((c) => c !== undefined);
}

/**
 * An invite for someone already in the org is refused: once they left or were removed it would
 * put them back on their next sign-in, without anyone asking.
 */
async function refuseMemberInvite(db: Db, orgId: string, name: string): Promise<void> {
  const named = name.includes("@")
    ? eq(users.email, name)
    : and(isNotNull(users.githubId), eq(sql`lower(${users.login})`, name));
  const [hit] = await db
    .select({ userId: members.userId })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.orgId, orgId), named));
  if (hit) throw new ForbiddenError(`${name} is already a member of this organization.`);
}

/**
 * A member who left or was removed keeps no pending invite of the org naming them to rejoin by;
 * with `sentByThem` (a removal), the invites they sent go too, since one may name another account
 * of theirs.
 */
export async function dropInvitesOf(
  db: Db,
  orgId: string,
  userId: string,
  { sentByThem }: { sentByThem: boolean },
): Promise<void> {
  const [user] = await db
    .select({ githubId: users.githubId, login: users.login, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  const names = [
    ...(user ? namesOf(user) : []),
    ...(sentByThem ? [eq(invites.invitedBy, userId)] : []),
  ];
  if (names.length === 0) return;
  await db.delete(invites).where(and(eq(invites.orgId, orgId), or(...names)));
}

/** `who` is a GitHub login, or an email when it holds an `@` (no GitHub login can, PS-274). */
export async function inviteMember(
  db: Db,
  inviter: User,
  orgId: string,
  who: string,
): Promise<void> {
  await requireMember(db, inviter.id, orgId);
  const name = who.trim().toLowerCase();
  await refuseMemberInvite(db, orgId, name);
  await db
    .insert(invites)
    .values({
      id: crypto.randomUUID(),
      orgId,
      ...(name.includes("@") ? { email: name } : { githubLogin: name }),
      invitedBy: inviter.id,
    })
    .onConflictDoNothing();
}

/** Takes back an invite that has not been taken up. An id from another org is the same 404 as a missing one. */
export async function withdrawInvite(
  db: Db,
  userId: string,
  orgId: string,
  inviteId: string,
): Promise<void> {
  await requireMember(db, userId, orgId);
  const gone = await db
    .delete(invites)
    .where(and(eq(invites.id, inviteId), eq(invites.orgId, orgId)))
    .returning({ id: invites.id });
  if (gone.length === 0) throw new NotFoundError("invite");
}
