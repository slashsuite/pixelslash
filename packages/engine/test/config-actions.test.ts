import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";

const base = { baseUrl: "http://127.0.0.1:3000", routes: ["/"] };
const withActions = (actions: unknown, extra: Record<string, unknown> = {}) =>
  parseConfig({ ...base, routes: [{ path: "/menu", actions }], ...extra });

describe("route actions", () => {
  test("click, hover, type and advance are kept in order; a route without them has none", () => {
    const actions = [
      { click: "#open" },
      { hover: ".item" },
      { type: "input", text: "hi" },
      { advance: 150 },
    ];
    expect(withActions(actions).routes[0]?.actions).toEqual(actions);
    expect(parseConfig(base).routes[0]).not.toHaveProperty("actions");
  });

  test.each([
    [[], "routes[0].actions must be a non-empty array of actions"],
    [{ click: "#a" }, "routes[0].actions must be a non-empty array of actions"],
    [[{ click: "" }], "routes[0].actions[0].click must be a non-empty CSS selector"],
    [[{ click: "#a", hover: "#b" }], "routes[0].actions[0] must be { click }, { hover }"],
    [[{ type: "input" }], "routes[0].actions[0] must be { click }, { hover }"],
    [[{ type: "input", text: 1 }], "routes[0].actions[0].text must be a string"],
    [[{ advance: 0 }], "routes[0].actions[0].advance must be a positive whole number of ms"],
    [[{ advance: 1.5 }], "routes[0].actions[0].advance must be a positive whole number of ms"],
    [[{ wait: 100 }], "routes[0].actions[0] must be { click }, { hover }"],
  ])("%j is a config error", (actions, message) => {
    expect(() => withActions(actions)).toThrow(message);
  });

  test("an advance needs the paused clock; a click does not", () => {
    expect(() => withActions([{ advance: 150 }], { stabilise: { timers: false } })).toThrow(
      "routes[0].actions advance needs the paused clock",
    );
    expect(() => withActions([{ advance: 150 }], { stabilise: { clock: false } })).toThrow(
      "routes[0].actions advance needs the paused clock",
    );
    expect(
      withActions([{ click: "#a" }], { stabilise: { timers: false } }).routes[0]?.actions,
    ).toEqual([{ click: "#a" }]);
    expect(() =>
      parseConfig({
        storybook: { url: "http://127.0.0.1:6006", actions: { "a--b": [{ advance: 5 }] } },
        stabilise: { timers: false },
      }),
    ).toThrow("storybook.actions.a--b advance needs the paused clock");
  });
});
