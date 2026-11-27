// How a `wrangler d1 export` dump is read and rewritten for a restore (scripts/restore-test.ts):
// its row counts, and the order and statement sizes D1 will import. Pure string work, no I/O.

/** D1 refuses a statement over 100 KB (SQLITE_TOOBIG); a split row's statements stay under this. */
export const MAX_STATEMENT = 90_000;
const CHUNK = 45_000;

const IDENT = String.raw`("(?:[^"]|"")+"|\`[^\`]+\`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)`;
const CREATE = new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?${IDENT}`, "i");
const INSERT = new RegExp(`^INSERT INTO ${IDENT}`, "i");
const REFERENCES = new RegExp(`REFERENCES ${IDENT}`, "gi");
const ROW = new RegExp(`^INSERT INTO ${IDENT} \\(([^)]*)\\) VALUES\\((.*)\\);$`, "is");

function unquote(id: string): string {
  if (id.startsWith('"')) return id.slice(1, -1).replaceAll('""', '"');
  if (id.startsWith("`") || id.startsWith("[")) return id.slice(1, -1);
  return id;
}

/** The table a CREATE TABLE or INSERT line names, unquoted, or "" when the line is not one. */
function tableOf(re: RegExp, line: string): string {
  const id = re.exec(line)?.[1];
  return id === undefined ? "" : unquote(id);
}

const bytes = (s: string): number => Buffer.byteLength(s);
const ends = (line: string): boolean => line.trimEnd().endsWith(";");

/** Each table the dump creates, with the number of rows it inserts into it (one INSERT a row). */
export function dumpCounts(sql: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of sql.split("\n")) {
    const created = tableOf(CREATE, line);
    if (created) {
      if (!counts.has(created)) counts.set(created, 0);
      continue;
    }
    const inserted = tableOf(INSERT, line);
    if (inserted) counts.set(inserted, (counts.get(inserted) ?? 0) + 1);
  }
  return counts;
}

/** Where the string literal opening at `i` ends (one past its closing quote; `''` is a quote in it). */
function stringEnd(list: string, i: number): number {
  let j = i + 1;
  while (j < list.length) {
    if (list[j] !== "'") j++;
    else if (list[j + 1] === "'") j += 2;
    else return j + 1;
  }
  return j;
}

/** Where a value that is not a string ends: the next top-level comma. */
function plainEnd(list: string, i: number): number {
  let depth = 0;
  let j = i;
  for (; j < list.length; j++) {
    const c = list[j];
    if (c === "," && depth === 0) break;
    if (c === "(") depth++;
    if (c === ")") depth--;
  }
  return j;
}

/** The top-level values of an INSERT's `VALUES(...)`, each as written (a string keeps its quotes). */
function values(list: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < list.length) {
    if (list[i] === " " || list[i] === ",") {
      i++;
      continue;
    }
    const end = list[i] === "'" ? stringEnd(list, i) : plainEnd(list, i);
    out.push(list.slice(i, end));
    i = end;
  }
  return out;
}

/** A string literal's body cut into pieces of at most CHUNK UTF-8 bytes, never inside a `''`. */
function chunks(body: string): string[] {
  const out: string[] = [];
  let piece = "";
  let size = 0;
  for (const ch of body.replaceAll("''", "'")) {
    const esc = ch === "'" ? "''" : ch;
    const n = bytes(esc);
    if (size + n > CHUNK) {
      out.push(piece);
      piece = "";
      size = 0;
    }
    piece += esc;
    size += n;
  }
  if (piece) out.push(piece);
  return out;
}

interface Row {
  table: string;
  fields: { col: string; val: string }[];
}

function parseRow(line: string): Row {
  const [, table, cols, vals] = ROW.exec(line) ?? [];
  // The size only: a row's text is production data and stays out of the message.
  const what = `a ${bytes(line)}-byte row`;
  if (table === undefined || cols === undefined || vals === undefined)
    throw new Error(`cannot parse ${what}`);
  const names = cols.split(",");
  const list = values(vals);
  if (names.length !== list.length || !names.length) {
    throw new Error(`cannot split ${what}: ${names.length} columns, ${list.length} values`);
  }
  return { table, fields: names.map((col, i) => ({ col, val: list[i] ?? "" })) };
}

const insertOf = (row: Row): string =>
  `INSERT INTO ${row.table} (${row.fields.map((f) => f.col).join(",")}) VALUES(${row.fields.map((f) => f.val).join(",")});`;

/** Writes the row's longest strings as `''` until its INSERT fits; returns what it took out. */
function shorten(row: Row): { col: string; body: string }[] {
  const longest = row.fields
    .filter((f) => f.val.startsWith("'"))
    .toSorted((a, b) => b.val.length - a.val.length);
  const moved: { col: string; body: string }[] = [];
  for (const field of longest) {
    if (bytes(insertOf(row)) <= MAX_STATEMENT) break;
    moved.push({ col: field.col, body: field.val.slice(1, -1) });
    field.val = "''";
  }
  if (bytes(insertOf(row)) > MAX_STATEMENT) {
    throw new Error(`cannot split a row of ${row.table}: still too long`);
  }
  return moved;
}

/**
 * An INSERT over MAX_STATEMENT as several statements D1 takes: the row with its longest strings
 * written as `''`, then one UPDATE per piece that appends it back to the row just inserted
 * (`rowid = last_insert_rowid()`, which an UPDATE leaves alone). A row that is short enough is
 * returned as it is.
 */
export function splitRow(line: string): string[] {
  if (bytes(line) <= MAX_STATEMENT) return [line];
  const row = parseRow(line);
  const moved = shorten(row);
  const appends = moved.flatMap(({ col, body }) =>
    chunks(body).map(
      (piece) =>
        `UPDATE ${row.table} SET ${col} = ${col} || '${piece}' WHERE rowid = last_insert_rowid();`,
    ),
  );
  return [insertOf(row), ...appends];
}

/**
 * SQLite's `length()` of a value as the dump writes it: characters of a string, bytes of a blob, 0
 * for NULL, and the digits of a number.
 */
function lengthOf(val: string): number {
  if (val.toUpperCase() === "NULL") return 0;
  if (/^X'/i.test(val)) return (val.length - 3) / 2;
  if (!val.startsWith("'")) return val.length;
  // Code points, as SQLite counts them (a surrogate pair is one).
  return val.slice(1, -1).replaceAll("''", "'").match(/./gsu)?.length ?? 0;
}

/**
 * Every column a split row was taken apart in (splitRow), with the total length of that column
 * over all of its table's rows in the dump, so a restore can check the pieces went back together.
 */
export function splitColumns(sql: string): { table: string; col: string; length: number }[] {
  const lines = sql.split("\n").filter((line) => tableOf(INSERT, line));
  const split = new Map<string, Set<string>>();
  for (const line of lines.filter((l) => bytes(l) > MAX_STATEMENT)) {
    const row = parseRow(line);
    const cols = split.get(row.table) ?? new Set();
    for (const { col } of shorten(row)) cols.add(col);
    split.set(row.table, cols);
  }
  return [...split].flatMap(([table, cols]) => {
    const rows = lines.filter((l) => tableOf(INSERT, l) === unquote(table)).map(parseRow);
    return [...cols].map((col) => ({
      table: unquote(table),
      col: unquote(col),
      length: rows.reduce(
        (n, r) => n + lengthOf(r.fields.find((f) => f.col === col)?.val ?? "NULL"),
        0,
      ),
    }));
  });
}

interface Table {
  create: string[];
  refs: Set<string>;
  rows: string[];
}

interface Dump {
  head: string[];
  tables: Map<string, Table>;
  rest: string[];
}

function parseDump(sql: string): Dump {
  const dump: Dump = { head: [], tables: new Map(), rest: [] };
  let open: string[] | undefined;
  for (const line of sql.split("\n")) {
    if (open) {
      open.push(line);
      open = ends(line) ? undefined : open;
      continue;
    }
    const created = tableOf(CREATE, line);
    if (created) {
      const table: Table = { create: [line], refs: new Set(), rows: [] };
      dump.tables.set(created, table);
      open = ends(line) ? undefined : table.create;
      continue;
    }
    const owner = dump.tables.get(tableOf(INSERT, line));
    if (owner) owner.rows.push(...splitRow(line));
    else (dump.tables.size === 0 && line.startsWith("PRAGMA") ? dump.head : dump.rest).push(line);
  }
  return dump;
}

/** The tables in the order their rows can go in: parents first, otherwise the export's order. */
function parentsFirst(tables: Map<string, Table>): string[] {
  for (const [name, table] of tables) {
    for (const m of table.create.join("\n").matchAll(REFERENCES)) {
      const ref = unquote(m[1] ?? "");
      if (ref !== name && tables.has(ref)) table.refs.add(ref);
    }
  }
  const order: string[] = [];
  const left = [...tables.keys()];
  while (left.length) {
    const ready = left.findIndex((n) =>
      [...(tables.get(n)?.refs ?? [])].every((r) => order.includes(r)),
    );
    // What is left in a cycle keeps the export's order.
    order.push(...left.splice(Math.max(ready, 0), 1));
  }
  return order;
}

/**
 * The dump reordered so D1 can import it. `wrangler d1 export` writes each table's schema and rows
 * together, in creation order, so a table rebuilt by a migration (`projects`) comes after a table that
 * references it (`builds`). D1 enforces foreign keys and checks them part way through an import, so
 * the export as written fails ("no such table: main.projects", then "FOREIGN KEY constraint failed").
 * This puts every CREATE TABLE first, then each table's rows with a table's parents ahead of it (a
 * cycle keeps the export's order), then everything else (indexes, triggers, sqlite_sequence) in its
 * original order, so a trigger never fires on a restored row. A row over D1's statement limit is split
 * (splitRow). A CREATE TABLE runs to the line that ends with `;`; an INSERT is one line.
 */
export function importable(sql: string): string {
  const { head, tables, rest } = parseDump(sql);
  return [
    ...head,
    ...[...tables.values()].flatMap((t) => t.create),
    ...parentsFirst(tables).flatMap((n) => tables.get(n)?.rows ?? []),
    ...rest,
  ].join("\n");
}
