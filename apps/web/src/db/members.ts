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

/** Delete or demote the member unless they are the org's last owner; a missing member is a 404. */
async function guarded(
  db: Db,
  orgId: string,
  userId: string,
  change: "remove" | "demote",
): Promise<void> {
  const where = and(memberRow(orgId, userId), notLastOwner(orgId, userId));
  const done =
    change === "remove"
      ? await db.delete(members).where(where).returning({ userId: members.userId })
      : await db
          .update(members)
          .set({ role: "member" })
          .where(where)
          .returning({ userId: members.userId });
  if (done.length > 0) return;
  const [still] = await db
    .select({ userId: members.userId })
    .from(members)
    .where(memberRow(orgId, userId));
  if (!still) throw new NotFoundError("member");
  throw new LastOwnerError();
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
  await guarded(db, orgId, userId, "remove");
  await dropInvitesOf(db, orgId, userId, { sentByThem: true });
}

/** An owner makes a member an owner, or steps an owner (themselves included) down, unless the last. */
export async function setMemberRole(
  db: Db,
  ownerId: string,
  { orgId, userId }: { orgId: string; userId: string },
  role: MemberRole,
): Promise<void> {
  await requireOwner(db, ownerId, orgId);
  if (role === "member") return guarded(db, orgId, userId, "demote");
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
  await guarded(db, orgId, userId, "remove");
  await dropInvitesOf(db, orgId, userId, { sentByThem: false });
}
