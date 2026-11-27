import { notFound } from "@tanstack/react-router";
import { ForbiddenError, NotFoundError } from "#/db/db";

/**
 * A repository NotFoundError (missing, or another org's) becomes the router's 404. A refusal the
 * viewer should read (not an owner, the last owner) keeps its message on the way to the client.
 */
export async function or404<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof NotFoundError) throw notFound();
    if (error instanceof ForbiddenError) throw new Error(error.message, { cause: error });
    throw error;
  }
}

/** A trimmed, non-empty string of at most 100 chars from a server-fn payload. */
export function field(input: unknown, key: string): string {
  const value = typeof input === "object" && input !== null ? Reflect.get(input, key) : null;
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length === 0 || text.length > 100) throw new Error(`${key} is required (1-100 chars)`);
  return text;
}

const MAX_NOTE = 200;

/** An optional one-line note from a server-fn payload: whitespace collapsed, empty is none. */
export function noteInput(d: unknown): string | null {
  const raw = typeof d === "object" && d !== null ? Reflect.get(d, "note") : null;
  const note = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (note.length > MAX_NOTE) throw new Error(`note is at most ${MAX_NOTE} chars`);
  return note || null;
}
