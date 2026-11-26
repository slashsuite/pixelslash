/**
 * The bundle archive's format (a static Storybook build sent to the server to render): a gzipped
 * ustar tar of regular files, `index.json` first. Nothing here needs Bun, so the review app (a
 * Worker) reads the same format it is sent: it checks a bundle from its first entry alone, without
 * unpacking the rest.
 */

/** The entry every bundle starts with: Storybook's story index. */
export const INDEX_ENTRY = "index.json";
/** The most files a bundle may hold. A Storybook build of thousands of stories has a few hundred. */
export const MAX_ENTRIES = 20_000;
/** The most bytes a bundle may unpack to, all files together. */
export const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
/** The most bytes a render plan may be as JSON: a config is a few KB. The server holds it to this too. */
export const MAX_PLAN_BYTES = 64 * 1024;
/** The most bytes the index may be: a 2400-story index is about 1 MB. */
export const MAX_INDEX_BYTES = 32 * 1024 * 1024;
/** The longest path ustar holds (a 155-byte prefix, `/`, a 100-byte name). */
const MAX_PATH = 255;
const BLOCK = 512;

/** Why a bundle was refused, in words the CLI and the API both print as they are. */
export class BundleError extends Error {
  override name = "BundleError";
}

/**
 * A path inside the bundle, refused unless it is plainly relative: no absolute path, no `..`, no
 * empty or `.` segment, no backslash or control character. It is what keeps an unpack inside its
 * directory, whoever wrote the archive.
 */
export function checkEntryPath(path: string): string {
  const bad = (why: string) => new BundleError(`bundle: entry "${path}" ${why}`);
  if (path === "" || path.startsWith("/")) throw bad("is not a relative path");
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c === 0x5c || c < 0x20) throw bad("holds a backslash or a control character");
  }
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".."))
    throw bad("has an empty, . or .. segment");
  if (new TextEncoder().encode(path).length > MAX_PATH)
    throw bad(`is longer than ${MAX_PATH} bytes`);
  return path;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/** Split a path into ustar's prefix and name at a `/`, the name at most 100 bytes. */
function splitPath(path: string): { prefix: string; name: string } {
  const enc = new TextEncoder();
  if (enc.encode(path).length <= 100) return { prefix: "", name: path };
  for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (enc.encode(prefix).length <= 155 && enc.encode(name).length <= 100) return { prefix, name };
  }
  throw new BundleError(`bundle: entry "${path}" cannot be split into a ustar prefix and name`);
}

function put(block: Uint8Array, text: string, at: number, width: number): void {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > width) throw new BundleError(`bundle: "${text}" does not fit its field`);
  block.set(bytes, at);
}

/** One regular file's 512-byte ustar header. The mode is 0644 and the time 0, so the archive is the same each run. */
export function tarHeader(path: string, size: number): Uint8Array<ArrayBuffer> {
  const { prefix, name } = splitPath(checkEntryPath(path));
  const block = new Uint8Array(BLOCK);
  put(block, name, 0, 100);
  put(block, octal(0o644, 8), 100, 8);
  put(block, octal(0, 8), 108, 8);
  put(block, octal(0, 8), 116, 8);
  put(block, octal(size, 12), 124, 12);
  put(block, octal(0, 12), 136, 12);
  put(block, "        ", 148, 8);
  put(block, "0", 156, 1);
  put(block, "ustar\0", 257, 6);
  put(block, "00", 263, 2);
  put(block, prefix, 345, 155);
  const sum = block.reduce((n, b) => n + b, 0);
  put(block, `${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

/** The padding after `size` bytes of data, up to the next block. */
export const tarPadding = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK;

/** The two zero blocks that end a tar. */
export const TAR_END = new Uint8Array(BLOCK * 2);

function field(block: Uint8Array, at: number, width: number): string {
  const end = block.subarray(at, at + width).indexOf(0);
  return new TextDecoder().decode(block.subarray(at, end === -1 ? at + width : at + end));
}

function octalField(block: Uint8Array, at: number, width: number, what: string): number {
  const text = field(block, at, width).trim();
  if (!/^[0-7]+$/.test(text)) throw new BundleError(`bundle: a header's ${what} is not octal`);
  return Number.parseInt(text, 8);
}

/** What a header says: a file (with its size) or a directory, by path. */
export type TarEntry = { path: string; kind: "file" | "dir"; size: number };

/**
 * Read one header block; `undefined` for a zero block (the end). Only a regular file or a directory
 * is accepted: a link, a device or anything else is refused by path, since an unpack must never
 * write outside its directory or follow a link out of it.
 */
export function readHeader(block: Uint8Array): TarEntry | undefined {
  if (block.every((b) => b === 0)) return undefined;
  if (field(block, 257, 5) !== "ustar") throw new BundleError("bundle: not a ustar archive");
  const stored = octalField(block, 148, 8, "checksum");
  const copy = block.slice();
  copy.fill(0x20, 148, 156);
  if (copy.reduce((n, b) => n + b, 0) !== stored)
    throw new BundleError("bundle: a header's checksum is wrong");
  const prefix = field(block, 345, 155);
  const name = field(block, 0, 100);
  const raw = prefix ? `${prefix}/${name}` : name;
  const type = String.fromCharCode(block[156] ?? 0);
  if (type === "5") return { path: checkEntryPath(raw.replace(/\/+$/, "")), kind: "dir", size: 0 };
  if (type !== "0" && type !== "\0")
    throw new BundleError(`bundle: entry "${raw}" is not a regular file or a directory`);
  return { path: checkEntryPath(raw), kind: "file", size: octalField(block, 124, 12, "size") };
}

/** Every entry of an unpacked tar, with its bytes, refused past the entry and size caps. */
export function* tarEntries(tar: Uint8Array): Generator<TarEntry & { data: Uint8Array }> {
  let at = 0;
  let count = 0;
  let total = 0;
  while (at + BLOCK <= tar.length) {
    const entry = readHeader(tar.subarray(at, at + BLOCK));
    if (!entry) return;
    at += BLOCK;
    if (++count > MAX_ENTRIES) throw new BundleError(`bundle: more than ${MAX_ENTRIES} entries`);
    total += entry.size;
    if (total > MAX_UNPACKED_BYTES)
      throw new BundleError(`bundle: unpacks to more than ${MAX_UNPACKED_BYTES} bytes`);
    if (at + entry.size > tar.length)
      throw new BundleError(`bundle: entry "${entry.path}" is cut short`);
    yield { ...entry, data: tar.subarray(at, at + entry.size) };
    at += entry.size + tarPadding(entry.size);
  }
  throw new BundleError("bundle: the archive has no end blocks");
}

/** The stories in a Storybook 7+ index (`entries` of type `story`); docs pages are not counted. */
export function storyCount(index: unknown): number {
  if (typeof index !== "object" || index === null || !("entries" in index))
    throw new BundleError(`bundle: ${INDEX_ENTRY} has no "entries": needs Storybook 7 or later`);
  const { entries } = index;
  if (typeof entries !== "object" || entries === null)
    throw new BundleError(`bundle: ${INDEX_ENTRY} has no "entries": needs Storybook 7 or later`);
  return Object.values(entries).filter(
    (e: unknown) => typeof e === "object" && e !== null && "type" in e && e.type === "story",
  ).length;
}

/** An index's story count, refused with a named reason when it is not JSON or lists no story. */
export function indexStories(bytes: Uint8Array): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BundleError(`bundle: ${INDEX_ENTRY} is not JSON`);
  }
  const stories = storyCount(parsed);
  if (stories === 0) throw new BundleError(`bundle: ${INDEX_ENTRY} lists no stories`);
  return stories;
}

/** Read from `reader` until `buf` holds `want` bytes, or the stream ends. */
type Reader = { read(): Promise<{ done: boolean; value?: Uint8Array | undefined }> };

async function fill(reader: Reader, buf: { bytes: Uint8Array }, want: number): Promise<boolean> {
  while (buf.bytes.length < want) {
    const { done, value } = await reader.read();
    if (done || !value) return false;
    const next = new Uint8Array(buf.bytes.length + value.length);
    next.set(buf.bytes);
    next.set(value, buf.bytes.length);
    buf.bytes = next;
  }
  return true;
}

/** The first entry's bytes, read from the decompressed stream; it must be `index.json`. */
async function firstEntry(reader: Reader): Promise<Uint8Array> {
  const buf = { bytes: new Uint8Array(0) };
  if (!(await fill(reader, buf, BLOCK))) throw new BundleError("bundle: the archive is empty");
  const first = readHeader(buf.bytes.subarray(0, BLOCK));
  if (!first || first.kind !== "file" || first.path !== INDEX_ENTRY)
    throw new BundleError(`bundle: the first entry must be ${INDEX_ENTRY}`);
  if (first.size > MAX_INDEX_BYTES)
    throw new BundleError(`bundle: ${INDEX_ENTRY} is larger than ${MAX_INDEX_BYTES} bytes`);
  if (!(await fill(reader, buf, BLOCK + first.size)))
    throw new BundleError(`bundle: ${INDEX_ENTRY} is cut short`);
  return buf.bytes.subarray(BLOCK, BLOCK + first.size);
}

/**
 * Check a bundle from its start: gzip, a ustar tar, and `index.json` first, holding at least one
 * story. Only the first entry is decompressed, so a server checks a large bundle without unpacking
 * it. Returns the story count; anything else is a `BundleError` naming what is wrong.
 */
export async function checkBundleStart(gz: Uint8Array<ArrayBuffer>): Promise<{ stories: number }> {
  if (gz[0] !== 0x1f || gz[1] !== 0x8b) throw new BundleError("bundle: not a gzip archive");
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  try {
    return { stories: indexStories(await firstEntry(reader)) };
  } catch (e) {
    if (e instanceof BundleError) throw e;
    throw new BundleError(
      `bundle: cannot be read: ${e instanceof Error ? e.message : String(e)}`.trim(),
    );
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
