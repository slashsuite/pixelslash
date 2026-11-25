import { AvatarStack, Button, Cluster, PageHeader, Tabs } from "@slashsuite/ui-react";
import { hrefTo } from "#/lib/href";
import type { OrgOverview } from "#/db/orgs";
import { plural } from "./org-projects";

/** The header's two buttons; the page owns the dialogs they open. */
export type DialogKind = "project" | "org" | "invite";

/** The org's name, who is in it, the two things you do from any tab, and the tabs. */
export function OrgHeader({
  org,
  tab,
  hydrated,
  onDialog,
}: {
  org: OrgOverview;
  tab: Tab;
  hydrated: boolean;
  onDialog: (kind: DialogKind) => void;
}) {
  const pending = org.invites.length;
  return (
    <PageHeader
      title={org.name}
      description={
        <Cluster as="span" gap="sm">
          <AvatarStack
            items={org.members.map((member) => ({ name: member.login }))}
            max={4}
            size="md"
            aria-hidden="true"
          />
          <span data-testid="org-people">
            {plural(org.members.length, "member")}
            {" · "}
            {pending} {pending === 1 ? "invite" : "invites"} pending
          </span>
        </Cluster>
      }
      actions={
        <>
          <Button variant="outline" disabled={!hydrated} onClick={() => onDialog("invite")}>
            Invite
          </Button>
          <Button disabled={!hydrated} onClick={() => onDialog("project")}>
            + New project
          </Button>
        </>
      }
      tabs={<OrgTabs org={org} tab={tab} />}
    />
  );
}

export type Tab = "projects" | "members" | "tokens" | "model" | "timings";

function OrgTabs({ org, tab }: { org: OrgOverview; tab: Tab }) {
  const to = (target: Exclude<Tab, "projects"> | undefined) =>
    hrefTo("/orgs", {}, { search: target ? { org: org.id, tab: target } : { org: org.id } });
  return (
    <Tabs
      label="Organization"
      value={tab}
      items={[
        { value: "projects", label: "Projects", count: org.projects.length, href: to(undefined) },
        { value: "members", label: "Members", count: org.members.length, href: to("members") },
        { value: "tokens", label: "Tokens", href: to("tokens") },
        { value: "model", label: "AI model", href: to("model") },
        { value: "timings", label: "Timings", href: to("timings") },
      ]}
    />
  );
}
