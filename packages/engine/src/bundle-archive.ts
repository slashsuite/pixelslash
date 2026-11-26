import { lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  BundleError,
  INDEX_ENTRY,
  MAX_ENTRIES,
  MAX_UNPACKED_BYTES,
  TAR_END,
  checkEntryPath,
  indexStories,
  tarEntries,
  tarHeader,
  tarPadding,
} from "./bundle-tar.ts";

/** A packed bundle: the gzipped tar and what went into it. */
export type PackedBundle = {
  gz: Uint8Array<ArrayBuffer>;
  files: number;
  bytes: number;
  stories: number;
};

/** Every regular file under `dir`, as bundle paths, sorted; a link or anything else is refused by path. */
async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (at: string) => {
    for (const d of await readdir(at, { withFileTypes: true })) {
      const full = join(at, d.name);
      const path = relative(dir, full).split(sep).join("/");
      if (d.isDirectory()) await walk(full);
      else if (d.isFile()) found.push(checkEntryPath(path));
      else throw new BundleError(`bundle: ${path} is not a regular file (a link is not sent)`);
      if (found.length > MAX_ENTRIES)
        throw new BundleError(`bundle: ${dir} holds more than ${MAX_ENTRIES} files`);
    }
  };
  await walk(dir);
  return found.toSorted();
}

/**
 * The bundle's index, read before anything is packed, so a directory that is not a Storybook build
 * fails first and by name: no `index.json`, not JSON, or no story in it.
 */
export async function readBundleIndex(dir: string): Promise<{ stories: number }> {
  const file = Bun.file(join(dir, INDEX_ENTRY));
  if (!(await file.exists()))
    throw new BundleError(
      `bundle: ${join(dir, INDEX_ENTRY)} is missing: pass the directory build-storybook wrote`,
    );
  return { stories: indexStories(new Uint8Array(await file.arrayBuffer())) };
}

/**
 * Pack a static Storybook build into the bundle archive: a ustar tar of every regular file under
 * `dir`, `index.json` first, the rest sorted, gzipped. The same directory packs to the same bytes.
 */
export async function packBundle(dir: string): Promise<PackedBundle> {
  const { stories } = await readBundleIndex(dir);
  if (!(await lstat(dir)).isDirectory()) throw new BundleError(`bundle: ${dir} is not a directory`);
  const paths = await filesUnder(dir);
  const ordered = [INDEX_ENTRY, ...paths.filter((p) => p !== INDEX_ENTRY)];
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  for (const path of ordered) {
    const data = new Uint8Array(await Bun.file(join(dir, path)).arrayBuffer());
    bytes += data.length;
    if (bytes > MAX_UNPACKED_BYTES)
      throw new BundleError(`bundle: ${dir} holds more than ${MAX_UNPACKED_BYTES} bytes`);
    parts.push(tarHeader(path, data.length), data, new Uint8Array(tarPadding(data.length)));
  }
  parts.push(TAR_END);
  const tar = new Uint8Array(await new Blob(parts).arrayBuffer());
  return { gz: Bun.gzipSync(tar), files: ordered.length, bytes, stories };
}

/** The most a bundle's tar may inflate to: its file bytes plus a header and padding per entry. */
const MAX_TAR_BYTES = MAX_UNPACKED_BYTES + (MAX_ENTRIES + 1) * 1024;

/**
 * Inflate a gzipped bundle as a stream and stop at `MAX_TAR_BYTES`, so an archive of a few MB that
 * inflates to gigabytes is refused before it is held, not after.
 */
export async function inflateCapped(
  gz: Uint8Array<ArrayBuffer>,
  cap = MAX_TAR_BYTES,
): Promise<Uint8Array> {
  const reader = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      total += read.value.length;
      if (total > cap)
        throw new BundleError(`bundle: unpacks to more than ${MAX_UNPACKED_BYTES} bytes`);
      parts.push(read.value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    if (e instanceof BundleError) throw e;
    throw new BundleError("bundle: not a gzip archive");
  }
  const tar = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    tar.set(part, at);
    at += part.length;
  }
  return tar;
}

/**
 * Unpack a bundle archive into `dest`, which must be empty or not exist. Every path is checked
 * first (`checkEntryPath`), so nothing is written outside `dest`; a link or a device is refused.
 * Returns the story count of its index.
 */
export async function unpackBundle(
  gz: Uint8Array<ArrayBuffer>,
  dest: string,
): Promise<{ stories: number }> {
  const tar = await inflateCapped(gz);
  await mkdir(dest, { recursive: true });
  let stories: number | undefined;
  for (const entry of tarEntries(tar)) {
    if (stories === undefined) {
      if (entry.kind !== "file" || entry.path !== INDEX_ENTRY)
        throw new BundleError(`bundle: the first entry must be ${INDEX_ENTRY}`);
      stories = indexStories(entry.data);
    }
    const target = join(dest, ...entry.path.split("/"));
    if (entry.kind === "dir") await mkdir(target, { recursive: true });
    else {
      await mkdir(dirname(target), { recursive: true });
      await Bun.write(target, entry.data);
    }
  }
  if (stories === undefined) throw new BundleError("bundle: the archive is empty");
  return { stories };
}

/** What a value that looks like a credential is, by its shape. Only the kind is printed, never the value. */
const SECRET_SHAPES: [kind: string, pattern: RegExp][] = [
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["a Stripe secret key", /\b[sr]k_live_[A-Za-z0-9]{16,}\b/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["a PixelSlash token", /\bps(?:u|org)_[A-Za-z0-9_-]{20,}\b/],
];

/** The files a secret scan reads: text a build writes. Images and fonts are skipped. */
const TEXT_FILE = /\.(?:js|mjs|cjs|json|html|css|map|txt|svg)$/i;

/**
 * The bundle's files that hold something shaped like a credential, one line each naming the file
 * and the kind of value. A build step can bake an environment variable into a bundle; the bundle is
 * stored on the server, so the CLI says so and uploads anyway. It is a warning, never a refusal.
 */
export async function bundleSecrets(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const path of await filesUnder(dir)) {
    if (!TEXT_FILE.test(path)) continue;
    const text = await Bun.file(join(dir, path)).text();
    for (const [kind, pattern] of SECRET_SHAPES)
      if (pattern.test(text)) found.push(`${path} holds what looks like ${kind}`);
  }
  return found;
}
