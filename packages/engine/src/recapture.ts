import { nameShot } from "./capture-into.ts";
import type { CaptureSession, Shoot, SnapshotEntry } from "./snapshot.ts";

/**
 * The shot a manifest entry names, again; `undefined` when the config has no such route or variant.
 * A capture error names the shot, as one in `captureInto` does.
 */
export function recapture(
  session: CaptureSession,
  entry: Pick<SnapshotEntry, "name" | "variant">,
): Promise<Shoot | undefined> {
  const route = session.routes.find((r) => r.name === entry.name);
  // A baseline is only ever matched in its own browser: the same name in another is another shot.
  const variant = session.config.variants.find(
    (v) => v.name === entry.variant.name && v.browser === entry.variant.browser,
  );
  if (!route || !variant) return Promise.resolve(undefined);
  return session.shoot(route, variant).catch((e: unknown) => {
    throw nameShot(e, route, variant);
  });
}
