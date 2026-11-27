/** A request the client got wrong: surfaces as a 400 with this message. */
export class BadRequest extends Error {}

/** Refuse the request: `<where> <what>` as a 400. */
export function bad(where: string, what: string): never {
  throw new BadRequest(`${where} ${what}`);
}

/**
 * The actor may reach the row but not do this to it (a CI token resolving a flaky shot, a member
 * who is not an owner): a 403. One class with the repository layer's, so its refusals map here too.
 */
export { ForbiddenError as Forbidden } from "#/db/db";

/** A request the server understood but will not take (a brief over its limit): a 422. */
export class Unprocessable extends Error {}
