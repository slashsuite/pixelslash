import { sha256Hex } from "#/lib/crypto";

/** What names a shot within a build. */
export type StemKey = {
  buildId: string;
  name: string;
  platform: string;
  browser: string;
  viewport: string;
  theme: string;
};

/**
 * The blob prefix a shot owns: `builds/<buildId>/<identity>`, the identity being the first 32 hex
 * characters of the sha256 of its name and variant. Everything a shot writes of its own (CI masks,
 * metrics, flaky-shot captures, its diff overlay) sits beside this stem. Its PNG does not: an image is
 * stored once per org under its hash (`imageKeyOf`), and older shots' PNGs sit at `<stem>.png`.
 * The stem is the shot's own, so what it writes never lands on a key another build reads.
 */
export async function snapshotStem(key: StemKey): Promise<string> {
  const { name, platform, browser, viewport, theme } = key;
  const identity = await sha256Hex(JSON.stringify([name, platform, browser, viewport, theme]));
  return `builds/${key.buildId}/${identity.slice(0, 32)}`;
}
