/**
 * runner-bare-bin (B4): the JSON parser of the model route. The route never forwards the bytes the box sent: it parses them
 * here, checks the value (model-filter.ts) and forwards `strictStringify(checked)`. So the parser must agree with itself only,
 * and refuses everything another parser could read differently:
 * - a duplicate key (in any object), a byte-order mark, invalid UTF-8, a lone surrogate (raw or `\u` escaped);
 * - a non-finite number (`1e400`), anything after the value;
 * - more than `maxDepth` nested containers, or more than `maxNodes` values.
 *
 * Iterative (no recursion, so a 100k-deep array is a refusal, not a stack overflow). Numbers become `JsonNumber`, which keeps
 * the grammar-checked literal: an integer above 2^53 is written back exactly as it came.
 */

export class JsonNumber {
  constructor(
    readonly literal: string,
    readonly value: number,
  ) {}
}

export type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | { [k: string]: JsonValue };

export class StrictJsonError extends Error {}

export interface StrictParseOptions {
  maxDepth: number;
  maxNodes: number;
}

const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** A string with an unpaired surrogate code unit. */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isHigh(c)) {
      if (i + 1 < s.length && isLow(s.charCodeAt(i + 1))) {
        i++;
        continue;
      }
      return true;
    }
    if (isLow(c)) return true;
  }
  return false;
}

type Frame =
  | { kind: 'array'; value: JsonValue[] }
  | { kind: 'object'; value: { [k: string]: JsonValue }; key: string | null; keys: Set<string> };

/** Parses `buf` (UTF-8) or throws `StrictJsonError`. */
export function strictParse(buf: Buffer | string, o: StrictParseOptions): JsonValue {
  let text: string;
  if (typeof buf === 'string') text = buf;
  else {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
      throw new StrictJsonError('byte-order mark');
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    } catch {
      throw new StrictJsonError('invalid UTF-8');
    }
  }
  if (text.charCodeAt(0) === 0xfeff) throw new StrictJsonError('byte-order mark');
  let i = 0;
  let nodes = 0;
  const stack: Frame[] = [];
  const n = text.length;
  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else break;
    }
  };
  const fail = (why: string): never => {
    throw new StrictJsonError(`${why} at ${i}`);
  };
  const readString = (): string => {
    // at the opening quote
    i++;
    let out = '';
    let start = i;
    for (;;) {
      if (i >= n) fail('unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(start, i);
        i++;
        break;
      }
      if (c < 0x20) fail('control character in a string');
      if (c === 0x5c) {
        out += text.slice(start, i);
        const e = text[i + 1];
        i += 2;
        switch (e) {
          case '"':
            out += '"';
            break;
          case '\\':
            out += '\\';
            break;
          case '/':
            out += '/';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const h = text.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('bad \\u escape');
            out += String.fromCharCode(Number.parseInt(h, 16));
            i += 4;
            break;
          }
          default:
            fail('bad escape');
        }
        start = i;
        continue;
      }
      i++;
    }
    if (hasLoneSurrogate(out)) fail('lone surrogate');
    return out;
  };
  const count = (): void => {
    nodes++;
    if (nodes > o.maxNodes) fail('too many values');
  };
  /** Attaches a finished value to the open container; returns true when it was the top-level value. */
  const attach = (v: JsonValue): boolean => {
    const top = stack[stack.length - 1];
    if (!top) return true;
    if (top.kind === 'array') top.value.push(v);
    else {
      const k = top.key as string;
      top.value[k] = v;
      top.key = null;
    }
    return false;
  };
  let result: JsonValue | undefined;
  let done = false;
  ws();
  // expect a value
  outer: for (;;) {
    ws();
    if (i >= n) fail('unexpected end');
    const c = text[i];
    let value: JsonValue | undefined;
    if (c === '{' || c === '[') {
      count();
      if (stack.length >= o.maxDepth) fail('too deep');
      i++;
      if (c === '[') {
        const arr: JsonValue[] = [];
        stack.push({ kind: 'array', value: arr });
        ws();
        if (text[i] === ']') {
          i++;
          stack.pop();
          value = arr;
        } else continue;
      } else {
        const obj = Object.create(null) as { [k: string]: JsonValue };
        const frame: Frame = { kind: 'object', value: obj, key: null, keys: new Set() };
        stack.push(frame);
        ws();
        if (text[i] === '}') {
          i++;
          stack.pop();
          value = obj;
        } else {
          if (text[i] !== '"') fail('expected a key');
          const k = readString();
          if (frame.keys.has(k)) fail(`duplicate key "${k.slice(0, 40)}"`);
          frame.keys.add(k);
          frame.key = k;
          ws();
          if (text[i] !== ':') fail('expected :');
          i++;
          continue;
        }
      }
    } else if (c === '"') {
      count();
      value = readString();
    } else if (c === 't' && text.startsWith('true', i)) {
      count();
      i += 4;
      value = true;
    } else if (c === 'f' && text.startsWith('false', i)) {
      count();
      i += 5;
      value = false;
    } else if (c === 'n' && text.startsWith('null', i)) {
      count();
      i += 4;
      value = null;
    } else {
      NUM.lastIndex = i;
      const m = NUM.exec(text);
      if (!m) fail('unexpected character');
      const lit = (m as RegExpExecArray)[0];
      const num = Number(lit);
      if (!Number.isFinite(num)) fail('non-finite number');
      count();
      i += lit.length;
      value = new JsonNumber(lit, num);
    }
    // a value is complete: attach it and close every container that ends here
    let v: JsonValue = value as JsonValue;
    for (;;) {
      if (attach(v)) {
        result = v;
        done = true;
        break outer;
      }
      ws();
      const top = stack[stack.length - 1] as Frame;
      const d = text[i];
      if (d === ',') {
        i++;
        if (top.kind === 'object') {
          ws();
          if (text[i] !== '"') fail('expected a key');
          const k = readString();
          if (top.keys.has(k)) fail(`duplicate key "${k.slice(0, 40)}"`);
          top.keys.add(k);
          top.key = k;
          ws();
          if (text[i] !== ':') fail('expected :');
          i++;
        }
        continue outer;
      }
      if ((d === ']' && top.kind === 'array') || (d === '}' && top.kind === 'object')) {
        i++;
        stack.pop();
        v = top.value;
        continue;
      }
      fail('expected , or a closing bracket');
    }
  }
  if (!done) fail('unexpected end');
  ws();
  if (i !== n) fail('trailing data');
  return result as JsonValue;
}

/** Serialises a value from `strictParse` (or built from one): numbers as their checked literal, never re-rounded. */
export function strictStringify(v: JsonValue, depth = 0): string {
  if (depth > 256) throw new StrictJsonError('too deep');
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof JsonNumber) return v.literal;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new StrictJsonError('non-finite number');
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => strictStringify(x, depth + 1)).join(',')}]`;
  if (typeof v === 'object')
    return `{${Object.keys(v)
      .map(
        (k) =>
          `${JSON.stringify(k)}:${strictStringify((v as Record<string, JsonValue>)[k] as JsonValue, depth + 1)}`,
      )
      .join(',')}}`;
  throw new StrictJsonError('not a JSON value');
}
