import { and, eq, sql } from "drizzle-orm";
import { type Db, ForbiddenError, NotFoundError } from "./db";
import { dropInvitesOf } from "./invites";
import { requireMember } from "./orgs";
import { type MemberRole, members } from "./schema";

/**
 * What only an owner may do (remove a member, change a role, org tokens, the org's model): not a
 * member reads as not found, a member who is not an owner is refused.
 */
export async function requireOwner(db: Db, userId: string, orgId: string): Promise<void> {
  const [row] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.orgId, orgId), eq(members.userId, userId)));
  if (!row) throw new NotFoundError("org");
  if (row.role !== "owner")
    throw new ForbiddenError("Only an owner of this organization can do that.");
}

/** The change would leave the org with no owner. */
export class LastOwnerError extends ForbiddenError {
  constructor() {
    super("An organization needs an owner: make another member an owner first.");
    this.name = "LastOwnerError";
  }
}

/** The target member's row in the org. */
const memberRow = (orgId: string, userId: string) =>
  and(eq(members.orgId, orgId), eq(members.userId, userId));

/**
 * The row is not an owner's, or the org has another owner. Checked in the same statement as the
 * delete or update it guards, so two owners stepping down at once cannot leave the org with none.
 */
const notLastOwner = (orgId: string, userId: string) =>
  sql`(${members.role} != 'owner' or (select count(*) from members o where o.org_id = ${orgId} and o.role = 'owner' and o.user_id != ${userId}) > 0)`;

const isMember = async (db: Db, orgId: string, userId: string) =>
  (await db.select({ userId: members.userId }).from(members).where(memberRow(orgId, userId)))
    .length > 0;

/** Step an owner down unless they are the org's last owner; a missing member is a 404. */
async function demote(db: Db, orgId: string, userId: string): Promise<void> {
  const done = await db
    .update(members)
    .set({ role: "member" })
    .where(and(memberRow(orgId, userId), notLastOwner(orgId, userId)))
    .returning({ userId: members.userId });
  if (done.length > 0) return;
  if (!(await isMember(db, orgId, userId))) throw new NotFoundError("member");
  throw new LastOwnerError();
}

/**
 * Delete the member unless they are the org's last owner, and their invites (`dropInvitesOf`) in
 * the same batch: a sign-in cannot fall between the two and put them back, and a failure undoes
 * both. A missing member is a 404.
 */
async function remove(
  db: Db,
  orgId: string,
  userId: string,
  invitesToo: { sentByThem: boolean },
): Promise<void> {
  if (!(await isMember(db, orgId, userId))) throw new NotFoundError("member");
  const membership = db
    .delete(members)
    .where(and(memberRow(orgId, userId), notLastOwner(orgId, userId)));
  const { drop } = await dropInvitesOf(db, orgId, userId, invitesToo);
  if (drop) await db.batch([membership, drop]);
  else await membership;
  if (await isMember(db, orgId, userId)) throw new LastOwnerError();
}

/**
 * An owner removes a member (themselves included, unless the last owner). The membership goes, and
 * every pending invite naming them or sent by them (an email of theirs the server has not seen yet
 * included), so no sign-in puts them back; org tokens stay.
 */
export async function removeMember(
  db: Db,
  ownerId: string,
  orgId: string,
  userId: string,
): Promise<void> {
  await requireOwner(db, ownerId, orgId);
  await remove(db, orgId, userId, { sentByThem: true });
}

/** An owner makes a member an owner, or steps an owner (themselves included) down, unless the last. */
export async function setMemberRole(
  db: Db,
  ownerId: string,
  { orgId, userId }: { orgId: string; userId: string },
  role: MemberRole,
): Promise<void> {
  await requireOwner(db, ownerId, orgId);
  if (role === "member") return demote(db, orgId, userId);
  const done = await db
    .update(members)
    .set({ role })
    .where(memberRow(orgId, userId))
    .returning({ userId: members.userId });
  if (done.length === 0) throw new NotFoundError("member");
}

/** Any member may leave, except the last owner. */
export async function leaveOrg(db: Db, userId: string, orgId: string): Promise<void> {
  await requireMember(db, userId, orgId);
  await remove(db, orgId, userId, { sentByThem: false });
}
