import { join } from "node:path";
import { expect, test } from "vitest";
import type { OrphanPlan } from "../src/db/orphans";
import type { RetentionPlan } from "../src/db/retention";
import { listing, parseArgs } from "./retention";

const parse = (argv: string[], env: Record<string, string> = {}) => parseArgs(argv, env);

test("with no days both windows stay off: only the orphaned images are listed", () => {
  expect(parse([])).toMatchObject({ days: undefined, mainDays: undefined, apply: false });
  expect(parse([], { PIXELSLASH_RETENTION_DAYS: "soon" }).days).toBeUndefined();
});

test("the main window comes from its flag, then the environment", () => {
  expect(parse([], { PIXELSLASH_RETENTION_MAIN_DAYS: "365" }).mainDays).toBe(365);
  expect(parse(["--main-days", "90"], { PIXELSLASH_RETENTION_MAIN_DAYS: "365" }).mainDays).toBe(90);
  expect(parse(["--days", "30"]).mainDays).toBeUndefined();
  expect(() => parse(["--main-days", "0"])).toThrow(/whole number/);
});

test("it is a dry run unless --apply is passed", () => {
  expect(parse(["--days", "30"]).apply).toBe(false);
  expect(parse(["--days", "30", "--dry-run"]).apply).toBe(false);
  expect(parse(["--days", "30", "--apply"]).apply).toBe(true);
  expect(() => parse(["--days", "30", "--apply", "--dry-run"])).toThrow(/contradict/);
});

test("the days come from the flag, then the environment", () => {
  expect(parse([], { PIXELSLASH_RETENTION_DAYS: "14" }).days).toBe(14);
  expect(parse(["--days", "7"], { PIXELSLASH_RETENTION_DAYS: "14" }).days).toBe(7);
  expect(() => parse(["--days", "0"])).toThrow(/whole number/);
  expect(() => parse(["--days"])).toThrow(/needs a value/);
});

test("the limit and the state directory", () => {
  const args = parse(["--days", "30", "--limit", "5"], { PIXELSLASH_DATA_DIR: "/data" });
  expect(args.limit).toBe(5);
  expect(args.persistTo).toBe(join("/data", "state/v3"));
  expect(parse(["--days", "30", "--persist-to", "/x/y"]).persistTo).toBe("/x/y");
  expect(() => parse(["--days", "30", "--limit", "many"])).toThrow(/whole number/);
  expect(() => parse(["--days", "30", "--delete"])).toThrow(/unknown argument/);
});

const build = (id: string, window: "main" | "branch", branch: string, day: string) => ({
  id,
  window,
  projectId: "p",
  orgId: "o",
  branch,
  createdAt: new Date(`${day}T10:00:00Z`),
  blobs: [
    { key: `builds/${id}/a.png`, size: 2048 },
    { key: `builds/${id}/b.png`, size: 1024 },
  ],
});

const orphans: OrphanPlan = { orphans: [{ orgId: "o", key: "images/ab.png", size: 4096 }] };

test("the listing has main builds, branch builds and orphaned images, each on its own", () => {
  const plan: RetentionPlan = {
    branch: { days: 30, cutoff: new Date("2026-09-28T00:00:00Z") },
    main: { days: 365, cutoff: new Date("2025-10-28T00:00:00Z") },
    expired: [
      build("m1", "main", "main", "2025-01-02"),
      build("b1", "branch", "feature", "2026-09-01"),
    ],
    keptReferenced: ["b0"],
    keptCurrent: ["m0", "m2"],
  };
  expect(listing(plan, orphans)).toEqual([
    "main builds: 1 past 2025-10-28T00:00:00.000Z (365 days)",
    "  m1  2025-01-02  main  2 blobs  3.0 KiB",
    "  2 kept: the newest, or holding a current baseline",
    "branch builds: 1 past 2026-09-28T00:00:00.000Z (30 days)",
    "  b1  2026-09-01  feature  2 blobs  3.0 KiB",
    "1 past a window kept: a build that stays points at them",
    "orphaned images: 1, 4.0 KiB",
    "  o  images/ab.png  4.0 KiB",
  ]);
});

test("a window that is off says so, and no plan lists only the orphans", () => {
  expect(listing(null, { orphans: [] })).toEqual([
    "main builds: window off",
    "branch builds: window off",
    "orphaned images: 0, 0 B",
  ]);
});
