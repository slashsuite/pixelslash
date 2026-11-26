/**
 * The render job's token (`docs/storybook-bundle-render.md`, section 4): `psr_<buildId>.<sig>`,
 * minted when a bundle build is finalised and handed to the renderer with the job. It names one
 * build and is signed with a key derived from the image signing secret, so no row stores it and
 * no other secret is needed. What it may reach is decided in `render.ts`, never here.
 */

const PREFIX = "psr_";
/** What the image secret is stretched with, so the render key signs nothing an image URL can. */
const KEY_LABEL = "pixelslash render token key";
const encoder = new TextEncoder();

async function hmac(
  key: Uint8Array<ArrayBuffer>,
  message: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(message)));
}

function base64url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function signature(secret: string, buildId: string): Promise<string> {
  const key = await hmac(encoder.encode(secret), KEY_LABEL);
  return base64url(await hmac(key, buildId));
}

export const isRenderToken = (token: string): boolean => token.startsWith(PREFIX);

export async function renderToken(secret: string, buildId: string): Promise<string> {
  return `${PREFIX}${buildId}.${await signature(secret, buildId)}`;
}

/** The build a render token names when its signature holds, else null. */
export async function renderTokenBuild(secret: string, token: string): Promise<string | null> {
  if (!isRenderToken(token)) return null;
  const body = token.slice(PREFIX.length);
  const dot = body.lastIndexOf(".");
  if (dot <= 0) return null;
  const buildId = body.slice(0, dot);
  const sig = body.slice(dot + 1);
  const expected = await signature(secret, buildId);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? buildId : null;
}
