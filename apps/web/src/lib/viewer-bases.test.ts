import { describe, expect, test } from "vitest";
import {
  FORMAT,
  MAIN,
  PREVIOUS,
  againstMain,
  input,
  mainsBuild,
  result,
} from "./viewer-bases-test-kit";
import { type BaseId, type Bases, type BasesInput, basesOf, chosenBase } from "./viewer-bases";

/**
 * What the viewer's left pane may show for a shot: main's baseline only when that is what it was
 * compared with, else the earlier build of its branch, with main offered beside it when the shot
 * differs from main. The pane that draws these is `components/snapshot-viewer.test.tsx`.
 */

/** The parts of the bases a reader sees, one entry per option in the switch's order. */
const shape = (bases: Bases) => ({
  options: bases.options.map((o) => o.id),
  initial: bases.initial,
  note: bases.note,
  images: bases.options.map((o) => o.mainUrl),
  summaries: bases.options.map((o) => o.summary),
  boxesByDefault: bases.options.map((o) => o.boxesByDefault),
});

const DIFFERS = "400 changed px (8.0%) in 2 regions";
const SAME_BYTES = "No change: identical bytes, not diffed.";

describe("the bases a shot's viewer offers", () => {
  test.each<[string, BasesInput, ReturnType<typeof shape>]>([
    [
      "compared with main's baseline: main alone, no note",
      input({
        baselineBuild: mainsBuild,
        images: { main: MAIN, mainBaseline: null, diff: null },
        snapshot: { carriedFrom: null, diffResult: againstMain },
      }),
      {
        options: ["main"],
        initial: "main",
        note: null,
        images: [MAIN],
        summaries: [null],
        boxesByDefault: [false],
      },
    ],
    [
      "with no baseline build at all: main alone",
      input({ baselineBuild: null, images: { main: null, mainBaseline: null, diff: null } }),
      {
        options: ["main"],
        initial: "main",
        note: null,
        images: [null],
        summaries: [null],
        boxesByDefault: [false],
      },
    ],
    [
      "carried and off main: opens on main's baseline with its boxes drawn",
      input({}),
      {
        options: ["main", "build"],
        initial: "main",
        note: null,
        images: [MAIN, PREVIOUS],
        summaries: [DIFFERS, SAME_BYTES],
        boxesByDefault: [true, false],
      },
    ],
    [
      "not carried and off main: opens on the earlier build, main one click away",
      input({ snapshot: { carriedFrom: null, diffResult: result({ changedPixels: 10 }) } }),
      {
        options: ["main", "build"],
        initial: "build",
        note: null,
        images: [MAIN, PREVIOUS],
        summaries: [DIFFERS, "10 changed px (0.2%) in 0 regions"],
        boxesByDefault: [false, false],
      },
    ],
    [
      "not measured against main: the earlier build alone, and it says so",
      input({ snapshot: { mainDiffStatus: null, mainDiffResult: null } }),
      {
        options: ["build"],
        initial: "build",
        note: "This shot was not measured against main.",
        images: [PREVIOUS],
        summaries: [SAME_BYTES],
        boxesByDefault: [false],
      },
    ],
    [
      "identical to main's baseline: the earlier build alone, and it says so",
      input({ snapshot: { mainDiffStatus: "unchanged", mainDiffResult: result({}) } }),
      {
        options: ["build"],
        initial: "build",
        note: "Identical to main's baseline.",
        images: [PREVIOUS],
        summaries: [SAME_BYTES],
        boxesByDefault: [false],
      },
    ],
    [
      "new against main: main is offered with no image, and says it is new",
      input({
        images: { main: PREVIOUS, mainBaseline: null, diff: null },
        snapshot: { mainDiffStatus: "new", mainDiffResult: null },
      }),
      {
        options: ["main", "build"],
        initial: "main",
        note: null,
        images: [null, PREVIOUS],
        summaries: ["New against main: main has no such shot.", SAME_BYTES],
        boxesByDefault: [true, false],
      },
    ],
  ])("a shot %s", (_, given, expected) => {
    expect(shape(basesOf(given, FORMAT))).toEqual(expected);
  });

  test("the earlier build is named by its sha in the slider and the switch, not just 'Earlier build'", () => {
    const bases = basesOf(input({}), FORMAT);
    expect(bases.options.map((o) => o.names.short)).toEqual(["Main", "Build 50d549b"]);
    expect(bases.options.map((o) => o.switchLabel)).toEqual([
      "Against main",
      "Against build 50d549b",
    ]);
  });
});

describe("the base the viewer shows", () => {
  const two = basesOf(input({}), FORMAT);
  const one = basesOf(input({ snapshot: { mainDiffStatus: null, mainDiffResult: null } }), FORMAT);

  test.each<[string, Bases, BaseId | null, BaseId]>([
    ["no choice opens on the initial one", two, null, "main"],
    ["a choice among two is kept", two, "build", "build"],
    ["a choice the shot does not offer falls back to the initial one", one, "main", "build"],
  ])("%s", (_, bases, chosen, shown) => {
    expect(chosenBase(bases, chosen).id).toBe(shown);
  });
});
