import type { Page } from "playwright";
import type { Fail } from "./diff-options.ts";

/**
 * One step a route or story takes on its settled page before the shot: click, hover or type into
 * what a selector matches, or advance the paused page clock by a set number of ms. An advance fires
 * the timers due in that time and no others, so a shot after one is as byte-stable as one without.
 */
export type Action =
  | { click: string }
  | { hover: string }
  | { type: string; text: string }
  | { advance: number };

const SHAPES = "{ click }, { hover }, { type, text } or { advance }";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function selector(v: unknown, where: string, fail: Fail): string {
  if (typeof v !== "string" || v === "") fail(where, "must be a non-empty CSS selector");
  return v;
}

function action(v: unknown, where: string, fail: Fail): Action {
  if (!isObj(v)) fail(where, `must be ${SHAPES}`);
  const keys = Object.keys(v).toSorted().join(",");
  if (keys === "click") return { click: selector(v.click, `${where}.click`, fail) };
  if (keys === "hover") return { hover: selector(v.hover, `${where}.hover`, fail) };
  if (keys === "text,type") {
    if (typeof v.text !== "string") fail(`${where}.text`, "must be a string");
    return { type: selector(v.type, `${where}.type`, fail), text: v.text };
  }
  if (keys === "advance") {
    const ms = v.advance;
    if (typeof ms !== "number" || !Number.isInteger(ms) || ms <= 0)
      fail(`${where}.advance`, "must be a positive whole number of ms");
    return { advance: ms };
  }
  return fail(where, `must be ${SHAPES}`);
}

/** A route's or story's `actions`: undefined when it has none, so a shot without them is taken as before. */
export function parseActions(v: unknown, where: string, fail: Fail): Action[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0) fail(where, "must be a non-empty array of actions");
  return v.map((a, i) => action(a, `${where}[${i}]`, fail));
}

/**
 * An `advance` moves the paused clock `stabilise.timers` installs; without it there is no clock to
 * move, so the first list (by its config path) that advances is a config error.
 */
export function checkAdvances(
  routes: { actions?: Action[] }[],
  storybook: { actions: Record<string, Action[]> } | undefined,
  timers: boolean,
  fail: Fail,
): void {
  if (timers) return;
  const lists: [string, Action[] | undefined][] = routes.map((r, i) => [
    `routes[${i}].actions`,
    r.actions,
  ]);
  for (const [id, a] of Object.entries(storybook?.actions ?? {}))
    lists.push([`storybook.actions.${id}`, a]);
  const at = lists.find(([, actions]) => actions?.some((a) => "advance" in a));
  if (at) fail(at[0], "advance needs the paused clock: set stabilise.timers (and clock)");
}

function describe(a: Action): string {
  if ("click" in a) return `click ${a.click}`;
  if ("hover" in a) return `hover ${a.hover}`;
  if ("type" in a) return `type into ${a.type}`;
  return `advance ${a.advance}ms`;
}

/**
 * Run the actions in order on the settled page. A selector must match one element, which
 * Playwright waits for within `timeoutMs`; the clock only moves on an `advance`, never by a wall-clock wait.
 */
export async function runActions(page: Page, actions: Action[], timeoutMs: number): Promise<void> {
  for (const a of actions) {
    try {
      if ("click" in a) await page.locator(a.click).click({ timeout: timeoutMs });
      else if ("hover" in a) await page.locator(a.hover).hover({ timeout: timeoutMs });
      else if ("type" in a)
        await page.locator(a.type).pressSequentially(a.text, { timeout: timeoutMs });
      else await page.clock.runFor(a.advance);
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
      throw new Error(`action "${describe(a)}" failed: ${msg}`, { cause: e });
    }
  }
}
