import { describe, expect, it } from "vitest";
import { foldQuiet } from "./build-folds";

const build = (id: string, branch = "main", toReview = 0, status = "passed") => ({
  id,
  branch,
  status,
  counts: { toReview },
});

const shape = (items: ReturnType<typeof foldQuiet>) =>
  items.map((item) =>
    item.kind === "build" ? item.build.id : `fold(${item.builds.map((b) => b.id).join(",")})`,
  );

describe("foldQuiet", () => {
  it("keeps the newest of a run of auto-accepted main builds and folds the rest", () => {
    const items = foldQuiet([build("m3"), build("m2"), build("m1")], "main");
    expect(shape(items)).toEqual(["m3", "fold(m2,m1)"]);
  });

  it("never folds a lone main build, a branch build or one with work to review", () => {
    const items = foldQuiet(
      [build("f1", "feat"), build("m4"), build("f0", "feat"), build("m3", "main", 2), build("m2")],
      "main",
    );
    expect(shape(items)).toEqual(["f1", "m4", "f0", "m3", "m2"]);
  });

  it("folds each run on its own, split by the builds between them", () => {
    const items = foldQuiet(
      [build("m5"), build("m4"), build("f1", "feat"), build("m3"), build("m2"), build("m1")],
      "main",
    );
    expect(shape(items)).toEqual(["m5", "fold(m4)", "f1", "m3", "fold(m2,m1)"]);
  });

  it("does not fold a main build that failed or is still processing", () => {
    const items = foldQuiet(
      [build("m2", "main", 0, "failed"), build("m1", "main", 0, "processing")],
      "main",
    );
    expect(shape(items)).toEqual(["m2", "m1"]);
  });
});
