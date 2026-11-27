import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import {
  Button,
  Caption,
  Card,
  Checkbox,
  Cluster,
  Code,
  Field,
  Input,
  SectionHeading,
  Stack,
  TextLink,
  Text,
} from "@slashsuite/ui-react";
import type { ModelView, ModelSource } from "#/db/models";
import { removeOrgModel, removeProjectModel, saveOrgModel, saveProjectModel } from "#/server/model";

/** The documented example; any OpenAI-compatible endpoint works. */
const EXAMPLE = { baseUrl: "https://api.deepseek.com", model: "deepseek-flash" };

/** Whose model the form sets: a project's own (ob 1473), or the org's, which its projects share (ob 1789). */
export type ModelScope = { kind: "project"; projectId: string } | { kind: "org"; orgId: string };

/**
 * A vision model: each changed region of a branch build is sent to it as three crops, and its label
 * and sentence are shown with the region. The key is write-only: once saved, the page shows that one
 * is set, never the key. A project's form also says which model applies to it.
 */
export function ModelSettings({
  scope,
  saved,
  source,
  orgSettingsHref,
  hydrated,
  lockedReason,
}: {
  scope: ModelScope;
  saved: ModelView | null;
  /** The project form's resolution: its own model, the org's, or none. */
  source?: ModelSource;
  orgSettingsHref?: string;
  hydrated: boolean;
  /** Why the viewer may only read the form (not an owner of the org): every field and button is off. */
  lockedReason?: string | undefined;
}) {
  const project = scope.kind === "project";
  const editable = hydrated && !lockedReason;
  const { fields, setFields, busy, error, save, remove } = useModelForm(scope, saved);

  return (
    <Card data-testid="model-settings">
      <Stack gap="md">
        <SectionHeading>AI explanations</SectionHeading>
        {source && <ModelInUse source={source} orgSettingsHref={orgSettingsHref} />}
        <Text>
          Any OpenAI-compatible vision endpoint. For each changed region of a branch build, the
          server sends that region&apos;s baseline, new and diff crops to this model only, and shows
          its label (intended, unintended or noise) and one sentence next to the region. With no
          model, or when a call fails, the shot is reviewed as plain pixels. Nothing is sent until
          this is saved.
        </Text>
        {lockedReason && <Caption>{lockedReason}</Caption>}
        <Stack gap="md" as="form" onSubmit={save}>
          <ModelFields
            fields={fields}
            setFields={setFields}
            keySet={!!saved}
            hydrated={editable}
            owner={project ? "project" : "org"}
          />
          <ModelActions
            fields={fields}
            saved={saved}
            busy={busy}
            hydrated={editable}
            onRemove={remove}
            label={removeLabel(scope, source)}
          />
          {error && (
            <div role="alert">
              <Text tone="danger">{error}</Text>
            </div>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}

/** The form's state and its two writes, to the project's or the org's server functions. */
function useModelForm(scope: ModelScope, saved: ModelView | null) {
  const router = useRouter();
  const [fields, setFields] = useState<Fields>({
    baseUrl: saved?.baseUrl ?? "",
    model: saved?.model ?? "",
    apiKey: "",
    autoPassNoise: saved?.autoPassNoise ?? false,
  });
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (which: "save" | "remove", work: () => Promise<unknown>) => {
    setError(null);
    setBusy(which);
    try {
      await work();
      setFields((f) => ({ ...f, apiKey: "" }));
      await router.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    void run("save", () =>
      scope.kind === "project"
        ? saveProjectModel({ data: { projectId: scope.projectId, ...fields } })
        : saveOrgModel({ data: { orgId: scope.orgId, ...fields } }),
    );
  };
  const remove = () =>
    void run("remove", () =>
      scope.kind === "project"
        ? removeProjectModel({ data: { projectId: scope.projectId } })
        : removeOrgModel({ data: { orgId: scope.orgId } }),
    );
  return { fields, setFields, busy, error, save, remove };
}

/** The remove button's words: a project with an org model behind it falls back to that model. */
function removeLabel(scope: ModelScope, source: ModelSource | undefined): string {
  if (scope.kind === "project" && source?.org) return "Use the org's model instead";
  return "Remove model and key";
}

/** Which model this project's builds use, and why: the answer a settings page owes (ob 1789). */
function ModelInUse({
  source,
  orgSettingsHref,
}: {
  source: ModelSource;
  orgSettingsHref: string | undefined;
}) {
  const orgLink = orgSettingsHref ? (
    <TextLink href={orgSettingsHref}>org settings</TextLink>
  ) : (
    "org settings"
  );
  return (
    <Text strong data-testid="model-in-use" data-source={source.source}>
      {source.source === "org" && (
        <>
          Using the org&apos;s model ({source.model.model}). Set a model below to override it for
          this project; change the org&apos;s in its {orgLink}.
        </>
      )}
      {source.source === "project" && "This project's model"}
      {source.source === "none" && (
        <>No model. Set one below, or once for every project in its {orgLink}.</>
      )}
    </Text>
  );
}

type Fields = { baseUrl: string; model: string; apiKey: string; autoPassNoise: boolean };

function ModelFields({
  fields,
  setFields,
  keySet,
  hydrated,
  owner,
}: {
  fields: Fields;
  setFields: (update: (f: Fields) => Fields) => void;
  keySet: boolean;
  hydrated: boolean;
  owner: "project" | "org";
}) {
  const set = (patch: Partial<Fields>) => setFields((f) => ({ ...f, ...patch }));
  return (
    <>
      <Field label="Base URL">
        <Input
          value={fields.baseUrl}
          placeholder={EXAMPLE.baseUrl}
          disabled={!hydrated}
          onChange={(e) => set({ baseUrl: e.target.value })}
          data-testid="model-base-url"
        />
      </Field>
      <Field label="Model">
        <Input
          value={fields.model}
          placeholder={EXAMPLE.model}
          disabled={!hydrated}
          onChange={(e) => set({ model: e.target.value })}
          data-testid="model-name"
        />
      </Field>
      <Caption>
        OpenCode Go works for a personal self-host (
        <Code>https://opencode.ai/inference/go/openai/v1</Code>, a Go model that takes images). A
        deployed service should use OpenCode Zen or the provider's own API, because Go is licensed
        for coding-agent traffic.
      </Caption>
      <Field
        label="API key"
        hint={`Stored for this ${owner} and never shown again. A new base URL needs its key again.`}
      >
        <Input
          type="password"
          autoComplete="off"
          value={fields.apiKey}
          placeholder={keySet ? "key set: leave empty to keep it" : "sk-…"}
          disabled={!hydrated}
          onChange={(e) => set({ apiKey: e.target.value })}
          data-testid="model-key"
        />
      </Field>
      <Checkbox
        checked={fields.autoPassNoise}
        disabled={!hydrated}
        onChange={(checked) => set({ autoPassNoise: checked })}
        data-testid="model-auto-pass"
        label={
          <Text as="span" strong>
            Auto-pass noise
          </Text>
        }
        hint="Accept a shot when the model labels every changed region noise. Off, noise is only labelled and a person still decides."
      />
    </>
  );
}

function ModelActions({
  fields,
  saved,
  busy,
  hydrated,
  onRemove,
  label,
}: {
  fields: Fields;
  saved: ModelView | null;
  busy: "save" | "remove" | null;
  hydrated: boolean;
  onRemove: () => void;
  label: string;
}) {
  const missing =
    !fields.baseUrl.trim() || !fields.model.trim() || (!saved && !fields.apiKey.trim());
  return (
    <Cluster gap="sm">
      <Button
        type="submit"
        disabled={!hydrated}
        disabledReason={missing ? "Give the base URL, the model and the key." : undefined}
        busy={busy === "save" && "Saving…"}
        data-testid="model-save"
      >
        Save model
      </Button>
      {saved && (
        <>
          <Button
            type="button"
            variant="ghost"
            disabled={!hydrated}
            busy={busy === "remove" && "Removing…"}
            onClick={onRemove}
            tone="danger"
            data-testid="model-remove"
          >
            {label}
          </Button>
          <Caption as="span" data-testid="model-key-set">
            Key set for {saved.baseUrl}
          </Caption>
        </>
      )}
    </Cluster>
  );
}
