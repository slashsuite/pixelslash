import { createServerFn } from "@tanstack/react-start";
import { leaveOrg, removeMember, setMemberRole } from "#/db/members";
import { MEMBER_ROLES, type MemberRole } from "#/db/schema";
import { database } from "./env";
import { field, or404 } from "./input";
import { requireViewer } from "./session";

const isRole = (role: string): role is MemberRole => MEMBER_ROLES.some((r) => r === role);

/** An owner removes a member from the org; their org tokens stay. */
export const removeOrgMember = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ orgId: field(d, "orgId"), userId: field(d, "userId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(removeMember(database(), user.id, data.orgId, data.userId));
  });

/** An owner makes a member an owner, or steps an owner down. */
export const setOrgMemberRole = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    const role = field(d, "role");
    if (!isRole(role)) throw new Error("role is owner or member");
    return { orgId: field(d, "orgId"), userId: field(d, "userId"), role };
  })
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const { role, ...member } = data;
    await or404(setMemberRole(database(), user.id, member, role));
  });

/** The viewer leaves the org, unless they are its last owner. */
export const leaveOrgFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ orgId: field(d, "orgId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(leaveOrg(database(), user.id, data.orgId));
  });
