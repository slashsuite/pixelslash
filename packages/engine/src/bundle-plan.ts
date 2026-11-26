import { type CaptureConfig, parseConfig } from "./config.ts";
import { MAX_PLAN_BYTES } from "./bundle-tar.ts";
import { UsageError } from "./errors.ts";

/**
 * What a bundle is rendered with on the server: the part of the config a Storybook capture reads,
 * as written, minus the Storybook's address (the renderer serves the bundle itself). JSON, so it
 * travels with the build; the renderer checks it again with `parseConfig` before it shoots.
 */
export type RenderPlan = Record<string, unknown> & { storybook: Record<string, unknown> };

/** The config keys a plan carries. */
const PLAN_KEYS = [
  "storybook",
  "masks",
  "tags",
  "variants",
  "diff",
  "ignore",
  "flaky",
  "flake",
  "stabilise",
  "a11y",
  "metrics",
  "concurrency",
] as const;

/** Keys a bundle render cannot honour: they need the app, a file beside the config, or a page that is not a story. */
const REFUSED: Record<string, string> = {
  setup: "signs in to a running app, and a bundle has none",
  routes: "names pages of a running app; a bundle renders its stories only",
  composition: "reads a component library beside the config",
  features: "reads spec and ref files beside the config",
};

/** Keys a bundle render has no use for: the renderer serves the bundle, and the upload is the CLI's. */
const DROPPED = ["start", "baseUrl", "upload"];

/** An address the plan is checked at before it is sent; the renderer puts its own in. */
const CHECK_URL = "http://127.0.0.1:1";

/** Whether a value is set to something: `[]`, `{}` and `undefined` say nothing. */
function given(v: unknown): boolean {
  if (v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object" && v !== null) return Object.keys(v).length > 0;
  return true;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPlan(v: unknown): v is RenderPlan {
  return isRecord(v) && isRecord(v["storybook"]);
}

/** The plan keys of `config`, as JSON: what the build carries. */
function planOf(config: Record<string, unknown>, storybook: Record<string, unknown>): RenderPlan {
  const plan: RenderPlan = { storybook };
  for (const key of PLAN_KEYS)
    if (key !== "storybook" && config[key] !== undefined) plan[key] = config[key];
  const json = JSON.stringify(plan);
  if (new TextEncoder().encode(json).length > MAX_PLAN_BYTES)
    throw new UsageError(`config: the render plan is larger than ${MAX_PLAN_BYTES} bytes`);
  const sent: unknown = JSON.parse(json);
  if (!isPlan(sent)) throw new UsageError("config: the storybook block does not survive JSON");
  return sent;
}

/**
 * The render plan from a config as written (`loadRawConfig`). The config must have a `storybook`
 * block; `setup`, `routes`, `composition` and `features` are refused by name, since the server
 * renders the bundle's stories and nothing else. `start`, `baseUrl` and `storybook.url` are left
 * out (the renderer serves the bundle), and `notes` says so. The plan is checked here as the
 * renderer will check it, so a config it cannot run fails on the developer's machine.
 */
export function renderPlan(raw: unknown): { plan: RenderPlan; notes: string[] } {
  if (!isRecord(raw)) throw new UsageError("config: must hold an object");
  const sb = raw["storybook"];
  if (!isRecord(sb)) throw new UsageError("config: upload --bundle needs a storybook block");
  for (const [key, why] of Object.entries(REFUSED))
    if (given(raw[key])) throw new UsageError(`config: ${key} does not go with --bundle: ${why}`);
  const { url, ...storybook } = sb;
  const plan = planOf(raw, storybook);
  planConfig(plan, CHECK_URL);
  const dropped = DROPPED.filter((k) => raw[k] !== undefined);
  if (url !== undefined) dropped.push("storybook.url");
  const notes =
    dropped.length === 0
      ? []
      : [`bundle: ${dropped.join(", ")} not sent: the server serves the bundle itself`];
  return { plan, notes };
}

const PLAN_KEY_SET: ReadonlySet<string> = new Set(PLAN_KEYS);

/** The capture config a plan renders with, the bundle served at `url`: checked as any config is. */
export function planConfig(plan: unknown, url: string): CaptureConfig {
  if (!isRecord(plan)) throw new UsageError("render plan: must be an object");
  const { storybook } = plan;
  if (!isRecord(storybook)) throw new UsageError("render plan: has no storybook block");
  for (const key of Object.keys(plan))
    if (!PLAN_KEY_SET.has(key)) throw new UsageError(`render plan: ${key} is not a plan key`);
  return parseConfig({ ...plan, storybook: { ...storybook, url } });
}
