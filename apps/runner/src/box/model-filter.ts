import type { IncomingHttpHeaders } from 'node:http';
import { JsonNumber, type JsonValue } from './strict-json.ts';

/**
 * runner-bare-bin (B1, B4, B6, S9, S10): what the runner's model proxy lets a box send to Anthropic. A command in the box can
 * read the box's stand-in key and call the route itself, so the route must not carry anything the box may not do: no MCP
 * server, no web fetch, no code execution, no files, no agents, no web search where the session has none.
 *
 * Everything is an allowlist; anything not listed is refused (never stripped: that would silently change the meaning). The one
 * exception is a beta name that is not listed: it is removed, because removing a beta can only switch a feature off.
 *
 * B6: every list below is a literal constant, changed only by a reviewed diff. Nothing at run time adds to it (no config key, no
 * env value, no capture). `NEVER` is checked before the lists, so a never value is refused even if a future diff lists it.
 */

export type ServerTools = 'none' | 'web_search';

// ------------------------------------------------------------------------------------------------ the never-list

/** Server-side tools, execution, storage or agents: refused whatever a list says. Names from the Claude Code 2.1.332 binary. */
export const NEVER = {
  keys: ['mcp_servers', 'container'] as readonly string[],
  sources: ['url', 'file'] as readonly string[],
  blockType: (t: string): boolean =>
    t.startsWith('mcp_') ||
    t === 'container_upload' ||
    (t.endsWith('_tool_result') && t !== 'web_search_tool_result'),
  toolType: (t: string): boolean =>
    /^(web_fetch_|code_execution_|bash_|text_editor_|computer_|memory_|tool_search_)/.test(t) ||
    t === 'mcp_toolset',
  beta: /mcp|web-fetch|code-execution|files-api|skills|computer-use|container|managed-agents|agent-memory|environments|ccr-|advisor-tool|tool-search|advanced-tool-use|dangerous-tool-use/,
} as const;

// ------------------------------------------------------------------------------------------------ the fixed lists

export interface FilterLists {
  topKeys: readonly string[];
  /** `messages[].role`; a `system` message holds a string or text blocks only. */
  roles: readonly string[];
  /** Block type -> its permitted fields (besides `type` and `cache_control`). */
  blocks: Readonly<Record<string, readonly string[]>>;
  /** Block types only a session with web search may send. */
  webSearchBlocks: readonly string[];
  sourceTypes: readonly string[];
  /** `context_management.edits[]`: edit type -> its permitted fields (besides `type`). */
  contextEdits: Readonly<Record<string, readonly string[]>>;
  thinkingTypes: readonly string[];
  betas: readonly string[];
  webSearchBetas: readonly string[];
  /** Client headers forwarded upstream (exact names); `x-stainless-*` is matched by prefix. */
  headers: readonly string[];
  headerPrefixes: readonly string[];
}

export const LISTS: FilterLists = {
  topKeys: [
    'model',
    'messages',
    'system',
    'max_tokens',
    'temperature',
    'top_p',
    'top_k',
    'stop_sequences',
    'stream',
    'metadata',
    'tools',
    'tool_choice',
    'thinking',
    'context_management',
    'output_config',
    'service_tier',
  ],
  // `system`: Claude Code 2.1.332 sends its environment note as a mid-conversation system message ([A11-L2])
  roles: ['user', 'assistant', 'system'],
  blocks: {
    text: ['text', 'citations'],
    image: ['source'],
    document: ['source', 'title', 'context'],
    tool_use: ['id', 'name', 'input'],
    tool_result: ['tool_use_id', 'content', 'is_error'],
    thinking: ['thinking', 'signature'],
    redacted_thinking: ['data'],
    server_tool_use: ['id', 'name', 'input'],
    web_search_tool_result: ['tool_use_id', 'content'],
  },
  webSearchBlocks: ['server_tool_use', 'web_search_tool_result'],
  sourceTypes: ['base64', 'text'],
  // S10: the context-management edits Claude Code 2.1.332 can send, with their fields
  contextEdits: {
    clear_thinking_20251015: ['keep'],
    clear_tool_uses_20250919: ['trigger', 'keep', 'clear_at_least', 'exclude_tools', 'clear_tool_inputs'],
  },
  thinkingTypes: ['enabled', 'disabled', 'adaptive'],
  betas: [
    // `oauth-2025-04-20` is not here: the route adds it (requiredHeaders) only where the auth mode needs it (review S1)
    'claude-code-20250219',
    'interleaved-thinking-2025-05-14',
    'fine-grained-tool-streaming-2025-05-14',
    'context-management-2025-06-27',
    'prompt-caching-scope-2026-01-05',
    'extended-cache-ttl-2025-04-11',
    'effort-2025-11-24',
    'context-1m-2025-08-07',
    'redact-thinking-2026-02-12',
  ],
  webSearchBetas: ['web-search-2025-03-05'],
  headers: ['accept', 'anthropic-version', 'anthropic-beta', 'user-agent', 'x-app'],
  headerPrefixes: ['x-stainless-'],
};

// ------------------------------------------------------------------------------------------------ the capture (test hook)

/** What one request used, and why it was refused or what was stripped. Reported only through a constructor test hook. */
export interface ModelCaptureEvent {
  path: string;
  keys: string[];
  blockTypes: string[];
  fields: string[];
  toolTypes: string[];
  betas: { confirmed: string[]; stripped: string[] };
  headers: { forwarded: string[]; dropped: string[] };
  refused?: string;
}

export type ModelCapture = (e: ModelCaptureEvent) => void;

// ------------------------------------------------------------------------------------------------ the filter

export type FilterResult = { body: JsonValue; headers: Record<string, string> } | { refuse: string };

class Refuse extends Error {}

type Obj = { [k: string]: JsonValue };

const isObj = (v: JsonValue | undefined): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof JsonNumber);
const isNum = (v: JsonValue | undefined): v is JsonNumber => v instanceof JsonNumber;
const isStr = (v: JsonValue | undefined): v is string => typeof v === 'string';

const refuse = (why: string): never => {
  throw new Refuse(why);
};

const PRINTABLE = /^[\x20-\x7e]{0,256}$/;
const VERSION = /^\d{4}-\d{2}-\d{2}$/;

const headerValues = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/**
 * The request filter of the Anthropic model route: `(value, headers) => {body, headers} | {refuse}`. `body` is the checked
 * value itself (forwarded as `strictStringify(body)`); `headers` is the upstream header set built from scratch (S9), before the
 * route's own, dynamic and required headers, which the proxy adds last.
 */
export function anthropicRequestFilter(o: {
  serverTools: ServerTools;
  capture?: ModelCapture;
  /** Test only: a different list, still checked against `NEVER` first. */
  testLists?: FilterLists;
}): (value: JsonValue, headers: IncomingHttpHeaders, path?: string) => FilterResult {
  const L = o.testLists ?? LISTS;
  const web = o.serverTools === 'web_search';
  return (value, headers, path = '') => {
    const ev: ModelCaptureEvent = {
      path,
      keys: [],
      blockTypes: [],
      fields: [],
      toolTypes: [],
      betas: { confirmed: [], stripped: [] },
      headers: { forwarded: [], dropped: [] },
    };
    const note = (list: string[], v: string): void => {
      if (!list.includes(v) && list.length < 500) list.push(v);
    };
    try {
      const out = filterHeaders(headers, L, web, ev, note);
      checkBody(value, L, web, ev, note);
      o.capture?.(ev);
      return { body: value, headers: out };
    } catch (err) {
      const why = err instanceof Refuse ? err.message : 'the request could not be checked';
      ev.refused = why;
      try {
        o.capture?.(ev);
      } catch {
        // a test hook never breaks the route
      }
      return { refuse: why };
    }
  };
}

function filterHeaders(
  h: IncomingHttpHeaders,
  L: FilterLists,
  web: boolean,
  ev: ModelCaptureEvent,
  note: (l: string[], v: string) => void,
): Record<string, string> {
  const out: Record<string, string> = { 'content-type': 'application/json' };
  const allowedBetas = new Set([...L.betas, ...(web ? L.webSearchBetas : [])]);
  for (const [name, raw] of Object.entries(h)) {
    const k = name.toLowerCase();
    if (k === 'content-type' || k === 'content-length' || k === 'host' || k === 'accept-encoding') continue;
    if (k === 'anthropic-beta') {
      const kept: string[] = [];
      for (const part of headerValues(raw).flatMap((v) => v.split(','))) {
        const b = part.trim();
        if (!b) continue;
        if (NEVER.beta.test(b)) refuse(`beta "${b.slice(0, 60)}" is never allowed from a box`);
        if (allowedBetas.has(b)) {
          if (!kept.includes(b)) kept.push(b);
          note(ev.betas.confirmed, b);
        } else note(ev.betas.stripped, b.slice(0, 80));
      }
      if (kept.length) out['anthropic-beta'] = kept.join(',');
      note(ev.headers.forwarded, k);
      continue;
    }
    const listed = L.headers.includes(k) || L.headerPrefixes.some((p) => k.startsWith(p));
    const vals = headerValues(raw);
    if (!listed || vals.length !== 1) {
      note(ev.headers.dropped, k.slice(0, 60));
      continue;
    }
    const v = vals[0] as string;
    if (!PRINTABLE.test(v) || (k === 'anthropic-version' && !VERSION.test(v))) {
      note(ev.headers.dropped, k);
      continue;
    }
    out[k] = v;
    note(ev.headers.forwarded, k);
  }
  return out;
}

function checkBody(
  v: JsonValue,
  L: FilterLists,
  web: boolean,
  ev: ModelCaptureEvent,
  note: (l: string[], v: string) => void,
): void {
  if (!isObj(v)) refuse('the request body is not an object');
  const body = v as Obj;
  const keys = Object.keys(body);
  // NEVER first
  for (const k of keys) if (NEVER.keys.includes(k)) refuse(`"${k}" is never allowed from a box`);
  for (const k of keys) {
    if (!L.topKeys.includes(k)) refuse(`unknown request key "${k.slice(0, 60)}"`);
    note(ev.keys, k);
  }
  const blockCtx = { L, web, ev, note };
  for (const k of keys) {
    const x = body[k];
    switch (k) {
      case 'model':
      case 'service_tier':
        if (!isStr(x)) refuse(`"${k}" must be a string`);
        break;
      case 'max_tokens':
      case 'temperature':
      case 'top_p':
      case 'top_k':
        if (!isNum(x)) refuse(`"${k}" must be a number`);
        break;
      case 'stream':
        if (typeof x !== 'boolean') refuse('"stream" must be a boolean');
        break;
      case 'stop_sequences':
        if (!Array.isArray(x) || !x.every(isStr)) refuse('"stop_sequences" must be strings');
        break;
      case 'metadata':
        exact(x, 'metadata', [], ['user_id']);
        if ((x as Obj).user_id !== undefined && !isStr((x as Obj).user_id)) refuse('metadata.user_id');
        break;
      case 'tool_choice': {
        exact(x, 'tool_choice', ['type'], ['name', 'disable_parallel_tool_use']);
        const t = (x as Obj).type;
        if (!isStr(t) || !['auto', 'any', 'tool', 'none'].includes(t)) refuse('tool_choice.type');
        break;
      }
      case 'thinking': {
        exact(x, 'thinking', ['type'], ['budget_tokens']);
        const t = (x as Obj).type;
        if (!isStr(t) || !L.thinkingTypes.includes(t)) refuse('thinking.type');
        if ((x as Obj).budget_tokens !== undefined && !isNum((x as Obj).budget_tokens))
          refuse('thinking.budget_tokens');
        break;
      }
      case 'output_config': {
        exact(x, 'output_config', [], ['effort']);
        if ((x as Obj).effort !== undefined && !isStr((x as Obj).effort)) refuse('output_config.effort');
        break;
      }
      case 'context_management': {
        exact(x, 'context_management', [], ['edits']);
        const edits = (x as Obj).edits;
        if (edits === undefined) break;
        if (!Array.isArray(edits)) refuse('context_management.edits');
        for (const e of edits as JsonValue[]) {
          if (!isObj(e) || !isStr(e.type)) refuse('context_management edit');
          const t = (e as Obj).type as string;
          const fields = L.contextEdits[t];
          if (!fields) refuse(`unknown context_management edit "${t.slice(0, 60)}"`);
          for (const f of Object.keys(e as Obj))
            if (f !== 'type' && !(fields as readonly string[]).includes(f))
              refuse(`unknown field "${f.slice(0, 40)}" in context_management edit ${t}`);
          note(ev.fields, `context_management.${t}`);
        }
        break;
      }
      case 'system':
        if (isStr(x)) break;
        if (!Array.isArray(x)) refuse('"system" must be a string or text blocks');
        for (const b of x as JsonValue[]) {
          if (!isObj(b) || b.type !== 'text') refuse('"system" holds only text blocks');
          checkBlock(b, blockCtx);
        }
        break;
      case 'messages':
        if (!Array.isArray(x)) refuse('"messages" must be an array');
        for (const m of x as JsonValue[]) {
          exact(m, 'message', ['role', 'content'], []);
          const mm = m as Obj;
          if (!isStr(mm.role) || !L.roles.includes(mm.role)) refuse('message.role');
          note(ev.fields, `message.role.${mm.role as string}`);
          if (isStr(mm.content)) continue;
          if (!Array.isArray(mm.content)) refuse('message.content');
          for (const b of mm.content as JsonValue[]) {
            if (mm.role === 'system' && !(isObj(b) && b.type === 'text'))
              refuse('a system message holds only text blocks');
            checkBlock(b, blockCtx);
          }
        }
        break;
      case 'tools':
        if (!Array.isArray(x)) refuse('"tools" must be an array');
        for (const t of x as JsonValue[]) checkTool(t, blockCtx);
        break;
    }
  }
}

function exact(x: JsonValue | undefined, what: string, required: string[], optional: string[]): void {
  if (!isObj(x)) refuse(`"${what}" must be an object`);
  const o = x as Obj;
  for (const r of required) if (o[r] === undefined) refuse(`${what}.${r} is missing`);
  for (const k of Object.keys(o))
    if (!required.includes(k) && !optional.includes(k))
      refuse(`unknown field "${k.slice(0, 40)}" in ${what}`);
}

interface Ctx {
  L: FilterLists;
  web: boolean;
  ev: ModelCaptureEvent;
  note: (l: string[], v: string) => void;
}

function checkCacheControl(c: JsonValue | undefined): void {
  if (c === undefined) return;
  exact(c, 'cache_control', ['type'], ['ttl']);
  const o = c as Obj;
  if (o.type !== 'ephemeral') refuse('cache_control.type');
  if (o.ttl !== undefined && !isStr(o.ttl)) refuse('cache_control.ttl');
}

function checkSource(s: JsonValue | undefined, L: FilterLists): void {
  if (!isObj(s) || !isStr(s.type)) refuse('a block source must be an object with a type');
  const t = (s as Obj).type as string;
  if (NEVER.sources.includes(t)) refuse(`source "${t}" is never allowed from a box`);
  if (!L.sourceTypes.includes(t)) refuse(`unknown source type "${t.slice(0, 40)}"`);
  exact(s, `source ${t}`, ['type', 'media_type', 'data'], []);
  if (!isStr((s as Obj).media_type) || !isStr((s as Obj).data))
    refuse('source media_type and data are strings');
}

function checkBlock(b: JsonValue, c: Ctx, inToolResult = false): void {
  if (!isObj(b) || !isStr(b.type)) refuse('a content block must be an object with a type');
  const t = (b as Obj).type as string;
  if (NEVER.blockType(t)) refuse(`block "${t.slice(0, 60)}" is never allowed from a box`);
  const fields = c.L.blocks[t];
  if (!fields) refuse(`unknown block type "${t.slice(0, 60)}"`);
  if (c.L.webSearchBlocks.includes(t) && !c.web)
    refuse(`block "${t}" needs web search, which this session has not`);
  if (inToolResult && t !== 'text' && t !== 'image')
    refuse(`a tool_result holds only text and image, not "${t}"`);
  c.note(c.ev.blockTypes, t);
  const o = b as Obj;
  for (const k of Object.keys(o)) {
    if (k === 'type') continue;
    if (k === 'cache_control') {
      checkCacheControl(o.cache_control);
      c.note(c.ev.fields, `${t}.cache_control`);
      continue;
    }
    if (!(fields as readonly string[]).includes(k))
      refuse(`unknown field "${k.slice(0, 40)}" in a ${t} block`);
    c.note(c.ev.fields, `${t}.${k}`);
  }
  switch (t) {
    case 'text':
      if (!isStr(o.text)) refuse('text.text');
      if (o.citations !== undefined) {
        if (!c.web) refuse('citations need web search, which this session has not');
        if (!Array.isArray(o.citations) || !o.citations.every(isObj)) refuse('text.citations');
      }
      break;
    case 'image':
      checkSource(o.source, c.L);
      break;
    case 'document':
      checkSource(o.source, c.L);
      if (o.title !== undefined && !isStr(o.title)) refuse('document.title');
      if (o.context !== undefined && !isStr(o.context)) refuse('document.context');
      break;
    case 'tool_use':
      if (!isStr(o.id) || !isStr(o.name) || !isObj(o.input))
        refuse('tool_use needs id, name and an input object');
      break;
    case 'server_tool_use':
      if (!isStr(o.id) || o.name !== 'web_search' || !isObj(o.input))
        refuse('server_tool_use is web_search only');
      break;
    case 'tool_result':
      if (!isStr(o.tool_use_id)) refuse('tool_result.tool_use_id');
      if (o.is_error !== undefined && typeof o.is_error !== 'boolean') refuse('tool_result.is_error');
      if (o.content !== undefined && !isStr(o.content)) {
        if (!Array.isArray(o.content)) refuse('tool_result.content');
        for (const x of o.content as JsonValue[]) checkBlock(x, c, true);
      }
      break;
    case 'web_search_tool_result':
      if (!isStr(o.tool_use_id)) refuse('web_search_tool_result.tool_use_id');
      break;
    case 'thinking':
      if (!isStr(o.thinking) || !isStr(o.signature)) refuse('thinking needs thinking and signature');
      break;
    case 'redacted_thinking':
      if (!isStr(o.data)) refuse('redacted_thinking.data');
      break;
  }
}

/** Every `$ref` in a schema points inside it (`#...`): never a URL a validator could fetch. Iterative. */
function checkRefs(schema: JsonValue): void {
  const stack: JsonValue[] = [schema];
  while (stack.length) {
    const v = stack.pop() as JsonValue;
    if (Array.isArray(v)) stack.push(...v);
    else if (isObj(v))
      for (const [k, x] of Object.entries(v)) {
        if (k === '$ref' && !(isStr(x) && x.startsWith('#')))
          refuse('a schema $ref must point inside the schema');
        stack.push(x);
      }
  }
}

function checkTool(t: JsonValue, c: Ctx): void {
  if (!isObj(t)) refuse('a tool must be an object');
  const o = t as Obj;
  const type = o.type;
  if (type !== undefined && !isStr(type)) refuse('tool.type');
  if (isStr(type) && NEVER.toolType(type))
    refuse(`tool type "${type.slice(0, 60)}" is never allowed from a box`);
  if (type === undefined || type === 'custom') {
    exact(o, 'tool', ['name', 'input_schema'], ['description', 'type', 'cache_control']);
    if (!isStr(o.name)) refuse('tool.name');
    if (o.description !== undefined && !isStr(o.description)) refuse('tool.description');
    if (!isObj(o.input_schema)) refuse('tool.input_schema');
    checkRefs(o.input_schema as JsonValue);
    checkCacheControl(o.cache_control);
    c.note(c.ev.toolTypes, 'custom');
    return;
  }
  if (/^web_search_\d{8}$/.test(type as string)) {
    if (!c.web) refuse('web search is not allowed in this session');
    exact(
      o,
      'web_search tool',
      ['type', 'name'],
      ['max_uses', 'allowed_domains', 'blocked_domains', 'user_location', 'cache_control'],
    );
    if (o.name !== 'web_search') refuse('the web search tool is named web_search');
    checkCacheControl(o.cache_control);
    c.note(c.ev.toolTypes, type as string);
    return;
  }
  refuse(`unknown tool type "${String(type).slice(0, 60)}"`);
}

/** B6 test: every allowlist entry that the never-list matches (must be empty). */
export function listsAgainstNever(L: FilterLists = LISTS): string[] {
  const hits: string[] = [];
  for (const k of L.topKeys) if (NEVER.keys.includes(k)) hits.push(`key ${k}`);
  for (const b of [...Object.keys(L.blocks), ...L.webSearchBlocks])
    if (NEVER.blockType(b)) hits.push(`block ${b}`);
  for (const s of L.sourceTypes) if (NEVER.sources.includes(s)) hits.push(`source ${s}`);
  for (const b of [...L.betas, ...L.webSearchBetas]) if (NEVER.beta.test(b)) hits.push(`beta ${b}`);
  for (const e of Object.keys(L.contextEdits)) if (NEVER.beta.test(e)) hits.push(`edit ${e}`);
  return hits;
}
