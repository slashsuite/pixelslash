import { join } from "node:path";
import { expect, test } from "vitest";
import { parseArgs } from "./recompute-verdicts";

test("it is a dry run unless --apply is passed", () => {
  expect(parseArgs([], {}).apply).toBe(false);
  expect(parseArgs(["--dry-run"], {}).apply).toBe(false);
  expect(parseArgs(["--apply"], {}).apply).toBe(true);
  expect(() => parseArgs(["--apply", "--dry-run"], {})).toThrow(/contradict/);
  expect(() => parseArgs(["--write"], {})).toThrow(/unknown argument/);
});

test("the state directory comes from the flag, then the data dir", () => {
  expect(parseArgs([], { PIXELSLASH_DATA_DIR: "/data" }).persistTo).toBe(join("/data", "state/v3"));
  expect(parseArgs(["--persist-to", "/x/y"], {}).persistTo).toBe("/x/y");
  expect(() => parseArgs(["--persist-to"], {})).toThrow(/needs a value/);
});
