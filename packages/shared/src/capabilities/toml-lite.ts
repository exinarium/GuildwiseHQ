/**
 * A deliberately small TOML reader for the few safe fields we take from a pack's `customize.toml`: tables (`[a.b]`,
 * `[[a.b]]`), strings (basic, literal, multi-line), booleans, numbers and arrays of those (also spread over lines).
 * Anything it does not understand (inline tables, dates) is skipped, never executed or interpolated. Pure.
 */
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

function unescapeBasic(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_m, c: string) => {
    if (c.length > 1) return String.fromCodePoint(Number.parseInt(c.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' }[c] ?? c;
  });
}

/** Parses one scalar or array starting at `src[i]`; returns the value and the index after it, or undefined when unsupported. */
function parseValue(src: string, i: number): { v: TomlValue; end: number } | undefined {
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
    const out: TomlValue[] = [];
    let j = i + 1;
    for (;;) {
      while (j < src.length && /[\s,]/.test(src[j] as string)) j++;
      if (src[j] === '#') {
        while (j < src.length && src[j] !== '\n') j++;
        continue;
      }
      if (src[j] === ']') return { v: out, end: j + 1 };
      const item = parseValue(src, j);
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

export function parseTomlLite(src: string): TomlTable {
  const root: TomlTable = {};
  let cur: TomlTable = root;
  const text = src.replace(/\r\n/g, '\n');
  let i = 0;
  const descend = (path: string[], array: boolean): TomlTable => {
    let t = root;
    path.forEach((p, idx) => {
      const last = idx === path.length - 1;
      let next = t[p];
      if (last && array) {
        if (!Array.isArray(next)) next = t[p] = [];
        const row: TomlTable = {};
        (next as TomlValue[]).push(row);
        t = row;
        return;
      }
      if (Array.isArray(next)) next = next[next.length - 1];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) next = t[p] = {};
      t = next as TomlTable;
    });
    return t;
  };
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl < 0 ? text.length : nl;
    const line = text.slice(i, lineEnd).trim();
    if (!line || line.startsWith('#')) {
      i = lineEnd + 1;
      continue;
    }
    const tbl = /^(\[\[?)\s*([A-Za-z0-9_.\-"' ]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (tbl) {
      const path = (tbl[2] as string).split('.').map((p) => p.trim().replace(/^["']|["']$/g, ''));
      cur = descend(path, tbl[1] === '[[');
      i = lineEnd + 1;
      continue;
    }
    const kv = /^([A-Za-z0-9_\-"']+)\s*=\s*/.exec(text.slice(i, lineEnd + 1));
    if (!kv) {
      i = lineEnd + 1;
      continue;
    }
    const key = (kv[1] as string).replace(/^["']|["']$/g, '');
    const start = i + kv[0].length;
    const r = parseValue(text, start);
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
