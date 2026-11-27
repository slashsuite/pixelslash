import { describe, expect, test } from "vitest";
import { NO_SCORE, physicalSize, scaleText, similarityText } from "./parity-view";

/** The parity view's words and sizes, as the API and the screen both say them. */

describe("a shot's physical size", () => {
  test.each<
    [
      string,
      { width: number; height: number } | null,
      number | null,
      ReturnType<typeof physicalSize>,
    ]
  >([
    [
      "a web shot at no recorded scale is its pixels",
      { width: 160, height: 120 },
      null,
      { width: 160, height: 120 },
    ],
    [
      "a 3x native shot is a third of its pixels",
      { width: 480, height: 360 },
      3,
      { width: 160, height: 120 },
    ],
    [
      "a size that does not divide evenly is kept to two places",
      { width: 1000, height: 100 },
      2.625,
      { width: 380.95, height: 38.1 },
    ],
    ["a shot with no size has none", null, 3, null],
  ])("%s", (_, size, scale, physical) => {
    expect(physicalSize(size, scale)).toEqual(physical);
  });
});

describe("the scale in words", () => {
  test.each<[number | null, string]>([
    [3, "3x"],
    [2.625, "2.625x"],
    [null, "1x (not recorded)"],
  ])("%s reads %s", (scale, text) => {
    expect(scaleText(scale)).toBe(text);
  });
});

describe("the similarity hint", () => {
  test.each<[number | null, string]>([
    [0.93, "similarity 0.93, a hint: fonts render differently by design"],
    [0.5, "similarity 0.50, a hint: fonts render differently by design"],
    [0, "similarity 0.00, a hint: fonts render differently by design"],
    [null, NO_SCORE],
  ])("a score of %s reads as %s", (score, text) => {
    expect(similarityText(score)).toBe(text);
  });
});
