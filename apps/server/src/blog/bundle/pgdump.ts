import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

/**
 * Reads the data of a few tables out of a plain-format `pg_dump` file (optionally gzipped) WITHOUT running it: the file is
 * treated as untrusted text. Only the lines inside an allow-listed `COPY public.<table> (<columns>) FROM stdin;` block are
 * decoded; every other line (SQL, `\!` shell lines, functions, other tables' data) is skipped unparsed. Columns are taken
 * by their header name and only the asked-for ones are kept.
 */

export type DumpRow = Record<string, string | null>;

export interface DumpRead {
  tables: Record<string, DumpRow[]>;
  /** `-- Dumped from database version ...` (a comment line; informational). */
  pgVersion: string | null;
}

const COPY_RE = /^COPY public\.([a-z_][a-z0-9_]*) \(([^)]*)\) FROM stdin;$/;

/** Decodes one field of COPY text format (`\N` is NULL; backslash escapes per the PostgreSQL docs, octal and hex are bytes). */
export function decodeCopyField(raw: string): string | null {
  if (raw === '\\N') return null;
  if (!raw.includes('\\')) return raw;
  const parts: Buffer[] = [];
  let plain = '';
  const flush = () => {
    if (plain) parts.push(Buffer.from(plain, 'utf8'));
    plain = '';
  };
  const ESC: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string;
    if (c !== '\\') {
      plain += c;
      continue;
    }
    const n = raw[i + 1];
    if (n === undefined) throw new Error('COPY field ends in a lone backslash');
    i++;
    const esc = ESC[n];
    if (esc !== undefined) {
      plain += esc;
      continue;
    }
    const hex = n === 'x' ? /^[0-9a-fA-F]{1,2}/.exec(raw.slice(i + 1)) : null;
    const oct = /^[0-7]{1,3}/.exec(raw.slice(i));
    if (hex) {
      flush();
      parts.push(Buffer.from([Number.parseInt(hex[0], 16)]));
      i += hex[0].length;
    } else if (oct) {
      flush();
      parts.push(Buffer.from([Number.parseInt(oct[0], 8) & 0xff]));
      i += oct[0].length - 1;
    } else plain += n;
  }
  flush();
  return Buffer.concat(parts).toString('utf8');
}

/** Splits one COPY data line into fields (a tab separates fields; an escaped tab is `\t` and never a raw tab). */
export function splitCopyLine(line: string): Array<string | null> {
  return line.split('\t').map(decodeCopyField);
}

async function* lines(file: string): AsyncGenerator<string> {
  const raw = createReadStream(file);
  const head = await new Promise<Buffer>((resolve, reject) => {
    const s = createReadStream(file, { start: 0, end: 1 });
    const parts: Buffer[] = [];
    s.on('data', (d) => parts.push(d as Buffer));
    s.on('end', () => resolve(Buffer.concat(parts)));
    s.on('error', reject);
  });
  const gz = head[0] === 0x1f && head[1] === 0x8b;
  const input = gz ? raw.pipe(createGunzip()) : raw;
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const l of rl) yield l;
}

/**
 * Reads `want` (table -> the columns to keep) from the dump. A table that is asked for but absent comes back empty; an
 * asked-for column missing from its COPY header is an error (the dump is not the expected schema).
 */
export async function readDumpTables(
  file: string,
  want: Record<string, readonly string[]>,
): Promise<DumpRead> {
  const tables: Record<string, DumpRow[]> = Object.fromEntries(Object.keys(want).map((t) => [t, []]));
  let pgVersion: string | null = null;
  let current: { table: string; idx: Array<[string, number]>; width: number } | null = null;
  // inside the COPY block of a table that was not asked for: its rows are skipped without being decoded
  let skipping = false;
  for await (const line of lines(file)) {
    if (skipping) {
      if (line === '\\.') skipping = false;
      continue;
    }
    if (current) {
      if (line === '\\.') {
        current = null;
        continue;
      }
      const fields = splitCopyLine(line);
      if (fields.length !== current.width)
        throw new Error(`${current.table}: a row has ${fields.length} fields, the header ${current.width}`);
      const row: DumpRow = {};
      for (const [name, i] of current.idx) row[name] = fields[i] ?? null;
      (tables[current.table] as DumpRow[]).push(row);
      continue;
    }
    if (pgVersion === null) {
      const v = /^-- Dumped from database version (.{1,150})$/.exec(line);
      if (v) pgVersion = (v[1] as string).trim();
    }
    const m = COPY_RE.exec(line);
    if (!m) continue;
    const table = m[1] as string;
    const cols = want[table];
    if (!cols) {
      skipping = true;
      continue;
    }
    const header = (m[2] as string).split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const idx: Array<[string, number]> = cols.map((c) => {
      const i = header.indexOf(c);
      if (i < 0) throw new Error(`${table}: the dump has no column ${c}`);
      return [c, i];
    });
    current = { table, idx, width: header.length };
  }
  if (current || skipping) throw new Error('a COPY block never ends (truncated dump?)');
  return { tables, pgVersion };
}
