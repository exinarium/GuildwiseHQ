/**
 * A deliberately small TOML reader for the few safe fields we take from a pack's `customize.toml`: tables (`[a.b]`,
 * `[[a.b]]`), strings (basic, literal, multi-line), booleans, numbers and arrays of those (also spread over lines).
 * Anything it does not understand (inline tables, dates) is skipped, never executed or interpolated. Pure.
 */
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

/** Longest line (and longest table header) read; a longer one is skipped so no regex ever runs on hostile-length input. */
const MAX_LINE = 4096;
/** Deepest table path and array nesting read. */
const MAX_DEPTH = 8;
/** Keys that would reach `Object.prototype` through a table path or key. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const newTable = (): TomlTable => Object.create(null) as TomlTable;

function unescapeBasic(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_m, c: string) => {
    if (c.length > 1) {
      const cp = Number.parseInt(c.slice(1), 16);
      // a surrogate or a value past U+10FFFF is not a character: keep the replacement character instead of throwing
      return cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(cp);
    }
    return { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' }[c] ?? c;
  });
}

/** Parses one scalar or array starting at `src[i]`; returns the value and the index after it, or undefined when unsupported. */
function parseValue(src: string, i: number, depth = 0): { v: TomlValue; end: number } | undefined {
  const ch = src[i];
  if (src.startsWith('"""', i)) {
    const end = src.indexOf('"""', i + 3);
    if (end < 0) return undefined;
    return { v: unescapeBasic(src.slice(i + 3, end).replace(/^\n/, '')), end: end + 3 };
  }
  if (src.startsWith("'''", i)) {
    const end = src.indexOf("'''", i + 3);
    if (end < 0) return undefined;
    return { v: src.slice(i + 3, end).replace(/^\n/, ''), end: end + 3 };
  }
  if (ch === '"') {
    let j = i + 1;
    while (j < src.length && src[j] !== '"' && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
    if (src[j] !== '"') return undefined;
    return { v: unescapeBasic(src.slice(i + 1, j)), end: j + 1 };
  }
  if (ch === "'") {
    const end = src.indexOf("'", i + 1);
    if (end < 0 || src.slice(i + 1, end).includes('\n')) return undefined;
    return { v: src.slice(i + 1, end), end: end + 1 };
  }
  if (ch === '[') {
    if (depth >= MAX_DEPTH) return undefined;
    const out: TomlValue[] = [];
    let j = i + 1;
    for (;;) {
      while (j < src.length && /[\s,]/.test(src[j] as string)) j++;
      if (src[j] === '#') {
        while (j < src.length && src[j] !== '\n') j++;
        continue;
      }
      if (src[j] === ']') return { v: out, end: j + 1 };
      const item = parseValue(src, j, depth + 1);
      if (!item) return undefined;
      out.push(item.v);
      j = item.end;
    }
  }
  const m = /^(true|false|[+-]?\d+(?:\.\d+)?)(?=[\s,\]#]|$)/.exec(src.slice(i, i + 40));
  if (!m) return undefined;
  const t = m[1] as string;
  return { v: t === 'true' ? true : t === 'false' ? false : Number(t), end: i + t.length };
}

/** Splits a table header's inner text on dots, honouring quotes. Linear. Returns undefined for anything malformed. */
function splitPath(inner: string): string[] | undefined {
  const parts: string[] = [];
  let cur = '';
  let quote = '';
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '.') {
      parts.push(cur.trim());
      cur = '';
    } else if (/[A-Za-z0-9_\- ]/.test(ch)) cur += ch;
    else return undefined;
  }
  if (quote) return undefined;
  parts.push(cur.trim());
  if (parts.length > MAX_DEPTH || parts.some((p) => !p || FORBIDDEN_KEYS.has(p))) return undefined;
  return parts;
}

/** Reads `[a.b]` / `[[a.b]]` (optionally followed by a comment) with a linear scan; undefined when the line is not a header. */
function parseHeader(line: string): { path: string[]; array: boolean } | undefined {
  if (line[0] !== '[') return undefined;
  const array = line[1] === '[';
  const open = array ? 2 : 1;
  const close = line.indexOf(']', open);
  if (close < 0) return undefined;
  let end = close + 1;
  if (array) {
    if (line[end] !== ']') return undefined;
    end++;
  }
  const rest = line.slice(end).trim();
  if (rest && !rest.startsWith('#')) return undefined;
  const path = splitPath(line.slice(open, close));
  return path ? { path, array } : undefined;
}

export function parseTomlLite(src: string): TomlTable {
  const root: TomlTable = newTable();
  let cur: TomlTable = root;
  const text = src.replace(/\r\n/g, '\n');
  let i = 0;
  const descend = (path: string[], array: boolean): TomlTable => {
    let t = root;
    path.forEach((p, idx) => {
      const last = idx === path.length - 1;
      let next: TomlValue | undefined = Object.hasOwn(t, p) ? t[p] : undefined;
      if (last && array) {
        if (!Array.isArray(next)) next = t[p] = [];
        const row: TomlTable = newTable();
        (next as TomlValue[]).push(row);
        t = row;
        return;
      }
      if (Array.isArray(next)) next = next[next.length - 1];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) next = t[p] = newTable();
      t = next as TomlTable;
    });
    return t;
  };
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl < 0 ? text.length : nl;
    const rawLine = text.slice(i, lineEnd);
    const line = rawLine.length > MAX_LINE ? '' : rawLine.trim();
    if (!line || line.startsWith('#')) {
      i = lineEnd + 1;
      continue;
    }
    if (line.startsWith('[')) {
      const hdr = parseHeader(line);
      // a malformed or forbidden header: its keys must not land in the previous table
      cur = hdr ? descend(hdr.path, hdr.array) : newTable();
      i = lineEnd + 1;
      continue;
    }
    const kv = /^([A-Za-z0-9_\-"']{1,200})[ \t]*=[ \t]*/.exec(rawLine);
    if (!kv) {
      i = lineEnd + 1;
      continue;
    }
    const key = (kv[1] as string).replace(/^["']|["']$/g, '');
    const start = i + kv[0].length;
    const r = FORBIDDEN_KEYS.has(key) ? undefined : parseValue(text, start);
    if (r) {
      cur[key] = r.v;
      const e = text.indexOf('\n', r.end);
      i = e < 0 ? text.length : e + 1;
    } else i = lineEnd + 1; // an inline table or another form we do not read
  }
  return root;
}

export const tomlString = (v: TomlValue | undefined): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
export const tomlStrings = (v: TomlValue | undefined): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
export const tomlTable = (v: TomlValue | undefined): TomlTable | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
