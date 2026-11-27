/**
 * The value a test read, or a throw naming what is missing. It narrows a row, a list's first item
 * or an optional field without an `if` or a `??` in the test's body: a missing value fails the
 * test with its name instead of letting a fallback pass for it.
 */
export function must<T>(value: T | null | undefined, what = "the value"): T {
  if (value === null || value === undefined) throw new Error(`missing: ${what}`);
  return value;
}
