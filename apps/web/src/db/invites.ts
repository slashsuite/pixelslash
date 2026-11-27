import { type SQL, and, eq, isNotNull, notExists, or, sql } from "drizzle-orm";
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
 * The delete that leaves a member who left or was removed no pending invite of the org naming them
 * to rejoin by; with `sentByThem` (a removal), the invites they sent go too, since one may name
 * another account of theirs. It deletes only once they are no longer a member: it runs in the same
 * batch as the membership's delete, so a refused removal leaves the invites as they are. Held in
 * an object: a bare query builder is a thenable, and the promise would run it.
 */
export async function dropInvitesOf(
  db: Db,
  orgId: string,
  userId: string,
  { sentByThem }: { sentByThem: boolean },
) {
  const [user] = await db
    .select({ githubId: users.githubId, login: users.login, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  const names = [
    ...(user ? namesOf(user) : []),
    ...(sentByThem ? [eq(invites.invitedBy, userId)] : []),
  ];
  if (names.length === 0) return {};
  const stillIn = db
    .select({ one: sql`1` })
    .from(members)
    .where(and(eq(members.orgId, orgId), eq(members.userId, userId)));
  return {
    drop: db.delete(invites).where(and(eq(invites.orgId, orgId), or(...names), notExists(stillIn))),
  };
}

/**
 * `who` is a GitHub login, or an email when it holds an `@` (no GitHub login can, PS-274). The
 * invite is written only while the inviter is still a member, in the same statement, so one removed
 * meanwhile cannot leave an invite behind.
 */
export async function inviteMember(
  db: Db,
  inviter: User,
  orgId: string,
  who: string,
): Promise<void> {
  await requireMember(db, inviter.id, orgId);
  const name = who.trim().toLowerCase();
  await refuseMemberInvite(db, orgId, name);
  const email = name.includes("@") ? name : null;
  await db
    .insert(invites)
    .select(
      db
        .select({
          id: sql<string>`${crypto.randomUUID()}`.as("id"),
          orgId: members.orgId,
          githubLogin: sql<string | null>`${email ? null : name}`.as("github_login"),
          email: sql<string | null>`${email}`.as("email"),
          invitedBy: members.userId,
          createdAt: sql<Date>`(unixepoch() * 1000)`.as("created_at"),
        })
        .from(members)
        .where(and(eq(members.orgId, orgId), eq(members.userId, inviter.id))),
    )
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
