import {
  Button,
  Caption,
  Card,
  Cluster,
  Input,
  ListRow,
  Overline,
  Pill,
  Radio,
  RadioGroup,
  Section,
  Stack,
  TextLink,
  Text,
} from "@slashsuite/ui-react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import type { ProjectFlag, SnapshotFlag } from "#/db/flags";
import type { FlagKind, IgnoreRect } from "#/db/schema";
import { flagShot, withdrawShotFlag } from "#/server/flag-fns";
import { hrefTo } from "#/lib/href";
import { FlagFormActions } from "./flag-form-actions";

const FLAG_LABELS: Record<FlagKind, string> = {
  missed: "Missed change",
  false_positive: "False positive",
};

/** In the form's order. Not the schema's FLAG_KINDS: that module is the server's, not the page's. */
const KINDS = ["false_positive", "missed"] as const satisfies readonly FlagKind[];

const KIND_HINTS: Record<FlagKind, string> = {
  missed: "The diff says unchanged or under threshold, but something visibly changed.",
  false_positive: "The diff flags a change that is not real: anti-aliasing, a shift, jitter.",
};

const rectText = (rect: IgnoreRect) => `${rect.width}×${rect.height} at ${rect.x},${rect.y}`;

/**
 * The flag form's draft, owned by the page because the viewer draws its rect. Moving to another
 * shot (j/k keeps the page mounted) drops the draft, so it never follows the reviewer.
 */
export function useFlagDraft(
  snapshotId: string,
  flags: SnapshotFlag[],
  /** False when nothing was measured: there is no image size to draw in. */
  canDraw: boolean,
) {
  const mine = flags.find((flag) => flag.mine) ?? null;
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<IgnoreRect | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [shot, setShot] = useState(snapshotId);
  const close = () => {
    setOpen(false);
    setDrawing(false);
    setRect(null);
  };
  if (shot !== snapshotId) {
    setShot(snapshotId);
    close();
  }
  const toggle = () => {
    if (open) {
      close();
    } else {
      setRect(mine?.rect ?? null);
      setOpen(true);
    }
  };
  // While the form is open, its rect stands in for the viewer's saved one.
  const marks = flags
    .filter((flag) => !(open && flag.mine))
    .flatMap((flag) => (flag.rect ? [flag.rect] : []));
  if (open && rect) marks.push(rect);
  const onDraw = drawing
    ? (drawn: IgnoreRect) => {
        setRect(drawn);
        setDrawing(false);
      }
    : null;
  return { mine, open, toggle, close, rect, setRect, drawing, setDrawing, canDraw, marks, onDraw };
}

type FlagDraft = ReturnType<typeof useFlagDraft>;

/** Every reviewer's flag on this shot: a second reviewer sees the first's kind and note. */
function FlagList({ flags }: { flags: SnapshotFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <Stack as="section" gap="xs">
      <Overline as="h2" tone="muted">
        Detection flags
      </Overline>
      <Stack as="ul" gap="xs">
        {flags.map((flag) => (
          <li key={flag.id} data-testid="detection-flag" data-kind={flag.kind}>
            <Pill tone={flag.kind === "missed" ? "warn" : "info"}>{FLAG_LABELS[flag.kind]}</Pill>{" "}
            <Text as="span" tone="muted">
              by {flag.mine ? "you" : flag.by}
            </Text>
            {flag.note && <Text>{flag.note}</Text>}
            {flag.rect && <Caption tone="muted">{rectText(flag.rect)}</Caption>}
          </li>
        ))}
      </Stack>
    </Stack>
  );
}

function KindPicker({ kind, onKind }: { kind: FlagKind | null; onKind: (kind: FlagKind) => void }) {
  return (
    <RadioGroup
      name="flag-kind"
      label="Kind"
      value={kind ?? ""}
      onChange={(value) => KINDS.filter((option) => option === value).forEach(onKind)}
    >
      {KINDS.map((option) => (
        <Radio key={option} value={option} label={FLAG_LABELS[option]} hint={KIND_HINTS[option]} />
      ))}
    </RadioGroup>
  );
}

function drawLabel(draft: FlagDraft): string {
  if (draft.drawing) return "Drawing…";
  return draft.rect ? "Redraw area" : "Mark an area";
}

/** Mark an optional area on the shot: the button turns drawing on, the viewer takes the drag. */
function AreaPicker({ draft }: { draft: FlagDraft }) {
  const { canDraw } = draft;
  return (
    <Cluster gap="xs">
      <Button
        type="button"
        variant="outline"
        pressed={draft.drawing}
        disabled={!canDraw}
        title={canDraw ? "Drag a box on either shot" : "Nothing was measured to draw on"}
        onClick={() => draft.setDrawing(!draft.drawing)}
        size="sm"
      >
        {drawLabel(draft)}
      </Button>
      {draft.rect && (
        <>
          <Caption as="span" data-testid="flag-rect" tone="muted">
            {rectText(draft.rect)}
          </Caption>
          <Button type="button" variant="ghost" onClick={() => draft.setRect(null)} size="sm">
            Clear
          </Button>
        </>
      )}
    </Cluster>
  );
}

/** Run a flag write, reload the page's data, and close the form; a failure stays on screen. */
export function useFlagWrite(onDone: () => void) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    work()
      .then(() => router.invalidate())
      .then(onDone)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return { busy, error, run };
}

/** Create, edit or withdraw the viewer's own flag. Saving decides nothing about the shot. */
function FlagForm({
  projectId,
  snapshotId,
  draft,
}: {
  projectId: string;
  snapshotId: string;
  draft: FlagDraft;
}) {
  const { mine } = draft;
  const [kind, setKind] = useState<FlagKind | null>(mine?.kind ?? null);
  const [note, setNote] = useState(mine?.note ?? "");
  const { busy, error, run } = useFlagWrite(draft.close);
  const ids = { projectId, snapshotId };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (kind) run(() => flagShot({ data: { ...ids, kind, note, rect: draft.rect } }));
  };

  return (
    <Card size="sm">
      <Stack as="form" gap="sm" onSubmit={save} aria-label="Flag detection">
        <fieldset>
          <legend>
            <Text as="span" strong>
              {mine ? "Edit your flag" : "Flag detection"}
            </Text>
          </legend>
          <KindPicker kind={kind} onKind={setKind} />
        </fieldset>
        <Input
          aria-label="Note (optional)"
          placeholder="Note (optional)"
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
        />
        <AreaPicker draft={draft} />
        {error && (
          <div role="alert">
            <Text tone="danger">{error}</Text>
          </div>
        )}
        <FlagFormActions
          picked={kind !== null}
          mine={Boolean(mine)}
          busy={busy}
          onWithdraw={() => run(() => withdrawShotFlag({ data: ids }))}
          onCancel={draft.close}
        />
      </Stack>
    </Card>
  );
}

/** The side panel's flag section: the form while it is open, then everyone's flags. */
export function FlagPanel({
  projectId,
  snapshotId,
  flags,
  draft,
}: {
  projectId: string;
  snapshotId: string;
  flags: SnapshotFlag[];
  draft: FlagDraft;
}) {
  return (
    <>
      {draft.open && <FlagForm projectId={projectId} snapshotId={snapshotId} draft={draft} />}
      <FlagList flags={flags} />
    </>
  );
}

/**
 * The project's flags, newest first, each linking to its shot; the export is the same list as
 * JSON with the blob keys and rects. Nothing here is sent anywhere: the file is downloaded.
 */
export function ProjectFlags({ projectId, flags }: { projectId: string; flags: ProjectFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <Section
      title={
        <>
          Detection flags{" "}
          <Text as="span" tone="muted">
            {flags.length}
          </Text>
        </>
      }
      actions={
        <Button variant="outline" href={`/projects/${projectId}/flags.json`} download>
          Export JSON
        </Button>
      }
    >
      <Card flush>
        <Stack divided>
          {flags.map((flag) => (
            <ListRow
              key={flag.id}
              data-testid="project-flag"
              leading={
                <Pill tone={flag.kind === "missed" ? "warn" : "info"}>
                  {FLAG_LABELS[flag.kind]}
                </Pill>
              }
            >
              <Cluster gap="xs" align="baseline">
                <TextLink
                  href={hrefTo("/projects/$projectId/builds/$buildId/snapshots/$snapshotId", {
                    projectId,
                    buildId: flag.build.id,
                    snapshotId: flag.snapshot.id,
                  })}
                >
                  {flag.snapshot.name}
                </TextLink>
                <Text as="span" tone="muted">
                  on {flag.build.branch}
                </Text>
                <Caption as="span" tone="muted">
                  by {flag.by}
                </Caption>
              </Cluster>
              {flag.note && <Text>{flag.note}</Text>}
            </ListRow>
          ))}
        </Stack>
      </Card>
    </Section>
  );
}
