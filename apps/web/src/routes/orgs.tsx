import { Button, EmptyState, FieldDialog, SidebarLayout, Stack, Text } from "@slashsuite/ui-react";
import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ModelSettings } from "#/components/model-settings";
import type { MemberActions } from "#/components/org-member-row";
import { MembersPanel } from "#/components/org-members";
import { type OrgToken, OrgTokensPanel } from "#/components/org-tokens";
import { TimingsPanel } from "#/components/org-timings";
import { EmptyOrg } from "#/components/org-empty";
import { ProjectTable, WaitingStrip } from "#/components/org-projects";
import { type DialogKind, OrgHeader, type Tab } from "#/components/org-tabs";
import { OrgRail } from "#/components/org-rail";
import { Page, useHydrated } from "#/components/ui";
import type { ModelView } from "#/db/models";
import type { OrgOverview } from "#/db/orgs";
import type { ProjectTimings } from "#/db/timings-stats";
import { getOrgs, invite, newOrg, newProject, withdrawOrgInvite } from "#/server/fns";
import { leaveOrgFn, removeOrgMember, setOrgMemberRole } from "#/server/member-fns";
import { getOrgTimings } from "#/server/timings";
import { titled } from "#/lib/page-title";

type OrgsSearch = { org?: string; tab?: "members" | "tokens" | "model" | "timings" };

const rootRoute = getRouteApi("__root__");

export const Route = createFileRoute("/orgs")({
  validateSearch: (search: Record<string, unknown>): OrgsSearch => {
    const out: OrgsSearch = {};
    if (typeof search.org === "string" && search.org) out.org = search.org;
    if (
      search.tab === "members" ||
      search.tab === "tokens" ||
      search.tab === "model" ||
      search.tab === "timings"
    )
      out.tab = search.tab;
    return out;
  },
  // The org is a dep only on the Timings tab, which reads its builds; switching org elsewhere stays a re-render.
  loaderDeps: ({ search }) => ({
    org: search.tab === "timings" ? search.org : undefined,
    timings: search.tab === "timings",
  }),
  loader: async ({ deps }) => {
    const data = await getOrgs();
    // The Timings tab reads the builds' numbers; the other tabs do not pay for them.
    const timingsOf = data.orgs.find((org) => org.id === deps.org) ?? data.orgs[0];
    const timings: ProjectTimings[] | null =
      deps.timings && timingsOf ? await getOrgTimings({ data: { orgId: timingsOf.id } }) : null;
    return { ...data, timings };
  },
  head: ({ loaderData, match }) => {
    const orgs = loaderData?.orgs ?? [];
    const org = orgs.find((o) => o.id === match.search.org) ?? orgs[0];
    if (!org) return titled("Organizations");
    const tab = match.search.tab ?? "projects";
    return titled(tab[0]?.toUpperCase() + tab.slice(1), org.name);
  },
  component: Orgs,
});

function Orgs() {
  const { orgs, orgTokens, orgModels, timings, now, serverUrl } = Route.useLoaderData();
  const search = Route.useSearch();
  const { viewer } = rootRoute.useLoaderData();
  const router = useRouter();
  const hydrated = useHydrated();
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const refresh = () => router.invalidate();
  const selected = orgs.find((org) => org.id === search.org) ?? orgs[0] ?? null;
  const onInvite = (login: string) =>
    selected ? invite({ data: { orgId: selected.id, login } }).then(refresh) : Promise.resolve();
  const memberActions = useMemberActions(selected);

  return (
    <Page>
      <SidebarLayout
        aside={
          <OrgRail
            orgs={orgs}
            selectedId={selected?.id ?? null}
            onNew={() => setDialog("org")}
            hydrated={hydrated}
          />
        }
      >
        {selected ? (
          <OrgPanel
            org={selected}
            tokens={orgTokens.filter((t) => t.orgId === selected.id)}
            model={orgModels.find((m) => m.orgId === selected.id) ?? null}
            timings={timings}
            now={now}
            serverUrl={serverUrl}
            tab={search.tab ?? "projects"}
            viewerLogin={viewer?.login ?? null}
            hydrated={hydrated}
            onDialog={setDialog}
            onInvite={onInvite}
            memberActions={memberActions}
            onWithdraw={(inviteRow) =>
              withdrawOrgInvite({ data: { orgId: selected.id, inviteId: inviteRow.id } }).then(
                refresh,
              )
            }
          />
        ) : (
          <NoOrgs hydrated={hydrated} onNew={() => setDialog("org")} />
        )}
      </SidebarLayout>
      <OrgDialogs
        kind={dialog}
        org={selected}
        onInvite={onInvite}
        onClose={() => setDialog(null)}
      />
    </Page>
  );
}

/** Remove, re-role and leave for the selected org; each reloads the page's data when it is done. */
function useMemberActions(org: OrgOverview | null): MemberActions {
  const router = useRouter();
  const orgId = org?.id ?? "";
  const refresh = () => router.invalidate();
  return {
    onRemove: (member) => removeOrgMember({ data: { orgId, userId: member.userId } }).then(refresh),
    onSetRole: (member, role) =>
      setOrgMemberRole({ data: { orgId, userId: member.userId, role } }).then(refresh),
    // Out of the org, the page falls back to the first one the viewer still belongs to.
    onLeave: () =>
      leaveOrgFn({ data: { orgId } }).then(async () => {
        await router.navigate({ to: "/orgs", search: {} });
        await refresh();
      }),
  };
}

/** The one open dialog, if any. New organization works with no org selected; the others need one. */
function OrgDialogs({
  kind,
  org: selected,
  onInvite,
  onClose,
}: {
  kind: DialogKind | null;
  org: OrgOverview | null;
  onInvite: (login: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const router = useRouter();
  const refresh = () => router.invalidate();
  return (
    <>
      {kind === "project" && selected && (
        <FieldDialog
          title="New project"
          description={`A project holds one app's builds, in ${selected.name}.`}
          label="Project name"
          placeholder="e.g. storefront"
          hint="Shown in lists and in the upload URL."
          emptyReason="Type a name first."
          submit="Create project"
          busyLabel="Creating…"
          onSubmit={(name) => newProject({ data: { orgId: selected.id, name } }).then(refresh)}
          onClose={onClose}
        />
      )}
      {kind === "org" && (
        <FieldDialog
          title="New organization"
          description="An organization owns projects and the people who review them."
          label="Organization name"
          placeholder="e.g. Acme"
          hint="You become its first member and its owner."
          emptyReason="Type a name first."
          submit="Create organization"
          busyLabel="Creating…"
          onSubmit={(name) =>
            newOrg({ data: { name } }).then(async ({ id }) => {
              await router.navigate({ to: "/orgs", search: { org: id } });
              await refresh();
            })
          }
          onClose={onClose}
        />
      )}
      {kind === "invite" && selected && (
        <FieldDialog
          title="Invite to this organization"
          description={`They join ${selected.name} when they sign in with that GitHub login or email.`}
          label="GitHub login or email"
          placeholder="e.g. octo-dev or ada@example.com"
          hint="An email joins them whether they sign in with Google or with a GitHub account that has it."
          emptyReason="Type a GitHub login or an email first."
          submit="Invite"
          busyLabel="Inviting…"
          onSubmit={onInvite}
          onClose={onClose}
        />
      )}
    </>
  );
}

function NoOrgs({ hydrated, onNew }: { hydrated: boolean; onNew: () => void }) {
  return (
    <Stack width="narrow">
      <EmptyState
        data-testid="no-orgs"
        title="No organizations yet"
        actions={
          <Button disabled={!hydrated} onClick={onNew}>
            + New organization
          </Button>
        }
      >
        <Text tone="muted">
          An organization owns your projects and the people who review them. Create one to add
          projects.
        </Text>
      </EmptyState>
    </Stack>
  );
}

function ProjectsPanel({
  org,
  now,
  serverUrl,
  hydrated,
}: {
  org: OrgOverview;
  now: Date;
  serverUrl: string;
  hydrated: boolean;
}) {
  if (org.projects.length === 0) return <EmptyOrg serverUrl={serverUrl} hydrated={hydrated} />;
  return (
    <Stack>
      <WaitingStrip org={org} />
      <ProjectTable org={org} now={now} />
    </Stack>
  );
}

function OrgPanel({
  org,
  tokens,
  model,
  timings,
  now,
  serverUrl,
  tab,
  viewerLogin,
  hydrated,
  onDialog,
  onInvite,
  onWithdraw,
  memberActions,
}: {
  org: OrgOverview;
  tokens: OrgToken[];
  model: ModelView | null;
  timings: ProjectTimings[] | null;
  now: Date;
  serverUrl: string;
  tab: Tab;
  viewerLogin: string | null;
  hydrated: boolean;
  onDialog: (kind: DialogKind) => void;
  onInvite: (login: string) => Promise<unknown>;
  onWithdraw: (invite: OrgOverview["invites"][number]) => Promise<unknown>;
  memberActions: MemberActions;
}) {
  const isOwner = org.members.some((m) => m.login === viewerLogin && m.role === "owner");
  return (
    <>
      <OrgHeader org={org} tab={tab} hydrated={hydrated} onDialog={onDialog} />
      {tab === "tokens" && (
        <OrgTokensPanel
          key={org.id}
          orgId={org.id}
          orgName={org.name}
          tokens={tokens}
          hydrated={hydrated}
          isOwner={isOwner}
        />
      )}
      {tab === "model" && (
        <ModelSettings
          key={org.id}
          scope={{ kind: "org", orgId: org.id }}
          saved={model}
          hydrated={hydrated}
          lockedReason={isOwner ? undefined : "Only an owner sets the org's model."}
        />
      )}
      {tab === "timings" && timings && <TimingsPanel projects={timings} />}
      {tab === "members" && (
        <MembersPanel
          org={org}
          viewerLogin={viewerLogin}
          hydrated={hydrated}
          onInvite={onInvite}
          onWithdraw={onWithdraw}
          actions={memberActions}
        />
      )}
      {tab === "projects" && (
        <ProjectsPanel org={org} now={now} serverUrl={serverUrl} hydrated={hydrated} />
      )}
    </>
  );
}
