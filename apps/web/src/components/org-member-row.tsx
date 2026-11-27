import { Avatar, Button, Caption, Cluster, ListRow, Pill, Text } from "@slashsuite/ui-react";
import { useState } from "react";
import type { OrgMember } from "#/db/orgs";
import type { MemberRole } from "#/db/schema";
import { formatDay } from "#/lib/format";

/** What an owner, or a member about themselves, can do to a membership. */
export type MemberActions = {
  onRemove: (member: OrgMember) => Promise<unknown>;
  onSetRole: (member: OrgMember, role: MemberRole) => Promise<unknown>;
  onLeave: () => Promise<unknown>;
};

/** A row's button: busy while it runs, and the server's refusal shown beside it. */
function RowAction({
  label,
  busyLabel,
  ariaLabel,
  hydrated,
  disabledReason,
  run,
  onError,
}: {
  label: string;
  busyLabel: string;
  ariaLabel: string;
  hydrated: boolean;
  disabledReason?: string | undefined;
  run: () => Promise<unknown>;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={!hydrated}
      disabledReason={disabledReason}
      busy={busy && busyLabel}
      aria-label={ariaLabel}
      onClick={() => {
        setBusy(true);
        onError(null);
        run().then(
          () => setBusy(false),
          (e: unknown) => {
            setBusy(false);
            onError(e instanceof Error ? e.message : String(e));
          },
        );
      }}
    >
      {label}
    </Button>
  );
}

const LAST_OWNER = "An organization needs an owner: make another member an owner first.";

/** A row's member as the viewer sees them. */
type Seat = { member: OrgMember; isViewer: boolean; viewerIsOwner: boolean; lastOwner: boolean };

type Control = {
  label: string;
  busy: string;
  aria: string;
  reason?: string | undefined;
  run: () => Promise<unknown>;
};

const lastOwnerReason = (seat: Seat) => (seat.lastOwner ? LAST_OWNER : undefined);

/** An owner's role button: make a member an owner, or step an owner down (themselves included). */
function roleControl(seat: Seat, actions: MemberActions): Control | null {
  const { member, isViewer } = seat;
  if (!seat.viewerIsOwner) return null;
  if (member.role === "member")
    return {
      label: "Make owner",
      busy: "Saving…",
      aria: `Make ${member.login} an owner`,
      run: () => actions.onSetRole(member, "owner"),
    };
  return {
    label: isViewer ? "Step down" : "Make member",
    busy: "Saving…",
    aria: isViewer ? "Step down as owner" : `Make ${member.login} a member`,
    reason: lastOwnerReason(seat),
    run: () => actions.onSetRole(member, "member"),
  };
}

/** Leave on the viewer's own row; on anyone else's, Remove for an owner. */
function exitControl(seat: Seat, actions: MemberActions): Control | null {
  const { member } = seat;
  if (seat.isViewer)
    return {
      label: "Leave",
      busy: "Leaving…",
      aria: "Leave this organization",
      reason: lastOwnerReason(seat),
      run: actions.onLeave,
    };
  if (!seat.viewerIsOwner) return null;
  return {
    label: "Remove",
    busy: "Removing…",
    aria: `Remove ${member.login}`,
    reason: lastOwnerReason(seat),
    run: () => actions.onRemove(member),
  };
}

/**
 * The controls a row shows the viewer. An owner can change any member's role and remove them; on
 * their own row anyone can leave, and an owner can step down, except the org's last owner.
 * A member sees no controls on anyone else's row.
 */
const memberControls = (seat: Seat, actions: MemberActions): Control[] =>
  [roleControl(seat, actions), exitControl(seat, actions)].filter((c) => c !== null);

export function MemberRow({
  member,
  isViewer,
  viewerIsOwner,
  owners,
  hydrated,
  actions,
}: {
  member: OrgMember;
  isViewer: boolean;
  viewerIsOwner: boolean;
  owners: number;
  hydrated: boolean;
  actions: MemberActions;
}) {
  const [error, setError] = useState<string | null>(null);
  const lastOwner = member.role === "owner" && owners <= 1;
  const controls = memberControls({ member, isViewer, viewerIsOwner, lastOwner }, actions);
  return (
    <ListRow
      data-testid="member-row"
      leading={<Avatar name={member.login} />}
      trailing={
        <Cluster gap="sm">
          {error && (
            <span role="alert">
              <Caption as="span" tone="danger">
                {error}
              </Caption>
            </span>
          )}
          <Pill data-testid="member-role">{member.role}</Pill>
          <Text as="span" tone="muted">
            joined {formatDay(member.joinedAt)}
          </Text>
        </Cluster>
      }
      actions={
        controls.length > 0 ? (
          <Cluster gap="xs">
            {controls.map((c) => (
              <RowAction
                key={c.label}
                label={c.label}
                busyLabel={c.busy}
                ariaLabel={c.aria}
                hydrated={hydrated}
                disabledReason={c.reason}
                run={c.run}
                onError={setError}
              />
            ))}
          </Cluster>
        ) : undefined
      }
    >
      <Text strong as="b">
        {member.login}
      </Text>
      <Caption>{[member.name, isViewer ? "you" : null].filter(Boolean).join(" · ") || " "}</Caption>
    </ListRow>
  );
}
