import {
  Avatar,
  Button,
  Caption,
  Card,
  Cluster,
  Input,
  ListRow,
  Pill,
  Stack,
  Text,
} from "@slashsuite/ui-react";
import { useState } from "react";
import type { OrgInvite, OrgOverview } from "#/db/orgs";
import { type MemberActions, MemberRow } from "./org-member-row";

function InviteRow({
  invite,
  onWithdraw,
  hydrated,
}: {
  invite: OrgInvite;
  onWithdraw: (invite: OrgInvite) => Promise<unknown>;
  hydrated: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ListRow
      data-testid="invite-row"
      leading={<Avatar name="?" />}
      trailing={
        <Cluster gap="sm">
          {error && (
            <span role="alert">
              <Caption as="span" tone="danger">
                {error}
              </Caption>
            </span>
          )}
          <Pill>pending</Pill>
        </Cluster>
      }
      actions={
        <Button
          variant="ghost"
          disabled={!hydrated}
          busy={busy && "Withdrawing…"}
          aria-label={`Withdraw invite for ${inviteName(invite)}`}
          onClick={() => {
            setBusy(true);
            setError(null);
            onWithdraw(invite).then(undefined, (e: unknown) => {
              setBusy(false);
              setError(e instanceof Error ? e.message : String(e));
            });
          }}
          size="sm"
        >
          Withdraw
        </Button>
      }
    >
      <Text strong as="b">
        {inviteName(invite)}
      </Text>
      <Caption>
        {invite.githubLogin === null
          ? "signs in with that email to join"
          : "signs in with GitHub to join"}
      </Caption>
    </ListRow>
  );
}

/** Who an invite names: a GitHub login or an email (PS-274). */
const inviteName = (invite: OrgInvite): string => invite.githubLogin ?? invite.email ?? "";

/** One field that sends an invite, with why it is grey or what happens next under it. */
function InviteForm({
  hydrated,
  onInvite,
}: {
  hydrated: boolean;
  onInvite: (login: string) => Promise<unknown>;
}) {
  const [login, setLogin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = login.trim().length === 0;
  return (
    <Stack
      as="form"
      gap="xs"
      onSubmit={(event) => {
        event.preventDefault();
        if (empty || busy) return;
        setError(null);
        setBusy(true);
        void onInvite(login.trim()).then(
          () => {
            setLogin("");
            setBusy(false);
          },
          (e: unknown) => {
            setBusy(false);
            setError(e instanceof Error ? e.message : String(e));
          },
        );
      }}
    >
      <Cluster gap="sm">
        <Input
          aria-label="Invite a member by GitHub login or email"
          placeholder="GitHub login or email, e.g. octo-dev"
          value={login}
          disabled={!hydrated}
          autoComplete="off"
          onChange={(e) => setLogin(e.target.value)}
          width="lg"
        />
        <Button
          type="submit"
          disabled={!hydrated}
          disabledReason={empty ? "Type a GitHub login or an email first." : undefined}
          busy={busy && "Inviting…"}
        >
          Invite
        </Button>
      </Cluster>
      {error ? (
        <div role="alert">
          <Text tone="danger">{error}</Text>
        </div>
      ) : (
        <Caption>
          {empty
            ? "Type a GitHub login or an email first."
            : "They join when they sign in with that login or email."}
        </Caption>
      )}
    </Stack>
  );
}

/** The members, then the invites nobody has taken up yet, under one field that sends an invite. */
export function MembersPanel({
  org,
  viewerLogin,
  hydrated,
  onInvite,
  onWithdraw,
  actions,
}: {
  org: OrgOverview;
  viewerLogin: string | null;
  hydrated: boolean;
  onInvite: (login: string) => Promise<unknown>;
  onWithdraw: (invite: OrgInvite) => Promise<unknown>;
  actions: MemberActions;
}) {
  const owners = org.members.filter((m) => m.role === "owner").length;
  const viewerIsOwner = org.members.some((m) => m.login === viewerLogin && m.role === "owner");
  return (
    <Stack>
      <InviteForm hydrated={hydrated} onInvite={onInvite} />
      <Card flush>
        <Stack divided>
          {org.members.map((member) => (
            <MemberRow
              key={`${org.id}:${member.userId}`}
              member={member}
              isViewer={member.login === viewerLogin}
              viewerIsOwner={viewerIsOwner}
              owners={owners}
              hydrated={hydrated}
              actions={actions}
            />
          ))}
          {org.invites.map((invite) => (
            <InviteRow
              key={invite.id}
              invite={invite}
              onWithdraw={onWithdraw}
              hydrated={hydrated}
            />
          ))}
        </Stack>
      </Card>
    </Stack>
  );
}
