import { screen } from "@testing-library/react";

/**
 * Each label of the key-value lists on screen against its value (a `<dt>` and the `<dd>` after it),
 * as a reader pairs them. A label that is not on screen is not a key, so `not.toHaveProperty` proves
 * a row absent. Lists inside a closed disclosure are hidden, so open it first.
 */
export function keyValues(): Record<string, string> {
  return Object.fromEntries(
    screen.queryAllByRole("term").map((dt) => {
      const dd = dt.nextElementSibling;
      return [dt.textContent, dd?.tagName === "DD" ? (dd.textContent ?? "") : ""];
    }),
  );
}
