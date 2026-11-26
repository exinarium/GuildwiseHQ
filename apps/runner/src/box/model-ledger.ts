import type { IncomingHttpHeaders } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import type { DevopsAuditEntry, Usage } from '@aom/shared';
import { redactCommand } from '../devops/guard.ts';
import type { RouteObserver } from '../sandbox/egress-proxy.ts';
import { JsonNumber, type JsonValue } from './strict-json.ts';

/**
 * runner-bare-bin (B2, S6, S7): what the runner believes about a boxed session comes from its model proxy, outside the box,
 * never from what the box prints (a command in the box can write to Claude Code's stdout, kill a hook or forge a line).
 *
 * - **Usage:** summed from Anthropic's own `message_start` / `message_delta` usage (SSE) or a JSON body's `usage`. It also
 *   counts a box command's own direct calls through the route.
 * - **Login and limits:** from the upstream HTTP status only: 401 is an auth failure, 429 a usage limit whose reset comes from
 *   the `retry-after` or `anthropic-ratelimit-*-reset` response headers (default 5 minutes). No body text is ever read for them.
 * - **Audit:** each Bash `tool_use` in an upstream response is recorded at once (`proxy:requested <id>`); a later request that
 *   carries a `tool_result` for that id adds `proxy:result-seen <id>`, which is the box's own claim and labelled so.
 *
 * Complete, not exact: no box action removes or edits an entry, but a box process can add one with a model call of its own.
 * One entry per Bash tool call (a script's inner commands are not listed). Every parse error is swallowed by the proxy.
 */

const TOOL_INPUT_CAP = 1024 * 1024;
const EVENT_CAP = 8 * 1024 * 1024;
const DEFAULT_LIMIT_MS = 5 * 60_000;

export interface LedgerOptions {
  /** Called with each new audit entry (DevOps shifts); absent: no audit (the CEO turn). */
  audit?: (entries: DevopsAuditEntry[]) => void;
  sessionRef?: string;
  shiftKind?: 'devops' | 'release_prep';
  now?: () => Date;
}

interface MsgUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};

/** The reset time of a 429 from the response headers only (the box cannot set them). */
export function limitResetOf(h: IncomingHttpHeaders, now: Date): { until: Date; parsed: boolean } {
  const ra = h['retry-after'];
  const r = Array.isArray(ra) ? ra[0] : ra;
  if (r) {
    if (/^\d+$/.test(r.trim()))
      return { until: new Date(now.getTime() + Number(r.trim()) * 1000), parsed: true };
    const d = Date.parse(r);
    if (Number.isFinite(d)) return { until: new Date(d), parsed: true };
  }
  let latest: number | undefined;
  for (const [k, v] of Object.entries(h)) {
    if (!/^anthropic-ratelimit-.*-reset$/.test(k)) continue;
    const t = Date.parse(String(Array.isArray(v) ? v[0] : v));
    if (Number.isFinite(t) && t > now.getTime() && (latest === undefined || t > latest)) latest = t;
  }
  if (latest !== undefined) return { until: new Date(latest), parsed: true };
  return { until: new Date(now.getTime() + DEFAULT_LIMIT_MS), parsed: false };
}

export class ModelLedger {
  private readonly messages = new Map<string, MsgUsage & { model?: string }>();
  private anon = 0;
  private lastModel: string | undefined;
  private authFailedFlag = false;
  private limit: { until: Date; parsed: boolean } | undefined;
  private readonly requested = new Set<string>();
  private readonly seen = new Set<string>();
  /** Every entry recorded so far (tests, diagnostics). */
  readonly entries: DevopsAuditEntry[] = [];

  constructor(private readonly o: LedgerOptions = {}) {}

  get authFailed(): boolean {
    return this.authFailedFlag;
  }

  usageLimit(): { until: Date; parsed: boolean } | undefined {
    return this.limit;
  }

  usage(): Usage {
    const u: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let oneH = 0;
    for (const m of this.messages.values()) {
      u.inputTokens += m.input;
      u.outputTokens += m.output;
      u.cacheReadTokens += m.cacheRead;
      u.cacheWriteTokens += m.cacheWrite;
      oneH += m.cacheWrite1h;
    }
    if (oneH) u.cacheWrite1hTokens = oneH;
    if (this.lastModel) u.model = this.lastModel;
    return u;
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  private record(rule: string, command: string): void {
    if (!this.o.audit) return;
    const e: DevopsAuditEntry = {
      at: this.now().toISOString(),
      sessionRef: (this.o.sessionRef ?? '').slice(0, 100),
      kind: 'shift',
      ...(this.o.shiftKind ? { shiftKind: this.o.shiftKind } : {}),
      decision: 'allowed',
      rule: rule.slice(0, 80),
      command: redactCommand(command).slice(0, 2000),
    };
    this.entries.push(e);
    try {
      this.o.audit([e]);
    } catch {
      // the sink's own failure never breaks the session
    }
  }

  private bash(id: string, input: string | Record<string, unknown> | undefined, tooLong: boolean): void {
    if (!id || this.requested.has(id)) return;
    this.requested.add(id);
    let command = '';
    if (tooLong) command = '[too long]';
    else if (typeof input === 'string') {
      try {
        const j = JSON.parse(input || '{}') as { command?: unknown };
        command = typeof j.command === 'string' ? j.command : '';
      } catch {
        command = '[unreadable input]';
      }
    } else if (input && typeof input.command === 'string') command = input.command;
    this.record(`proxy:requested ${id}`, command || '[no command]');
  }

  private setUsage(key: string, usage: unknown, model?: string): void {
    if (!usage || typeof usage !== 'object') return;
    const u = usage as Record<string, unknown>;
    const prev = this.messages.get(key) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
    };
    const cc = (u.cache_creation ?? {}) as Record<string, unknown>;
    const next = {
      ...prev,
      ...('input_tokens' in u ? { input: num(u.input_tokens) } : {}),
      ...('output_tokens' in u ? { output: num(u.output_tokens) } : {}),
      ...('cache_read_input_tokens' in u ? { cacheRead: num(u.cache_read_input_tokens) } : {}),
      ...('cache_creation_input_tokens' in u ? { cacheWrite: num(u.cache_creation_input_tokens) } : {}),
      ...('ephemeral_1h_input_tokens' in cc ? { cacheWrite1h: num(cc.ephemeral_1h_input_tokens) } : {}),
      ...(model ? { model } : {}),
    };
    this.messages.set(key, next);
    if (model) this.lastModel = model;
  }

  /** The request side: a `tool_result` for a recorded Bash call is the box's claim that it ran. */
  private onRequest(body: JsonValue): void {
    if (!body || typeof body !== 'object' || Array.isArray(body) || body instanceof JsonNumber) return;
    const msgs = (body as Record<string, JsonValue>).messages;
    if (!Array.isArray(msgs)) return;
    for (const m of msgs) {
      if (!m || typeof m !== 'object' || Array.isArray(m) || m instanceof JsonNumber) continue;
      const content = (m as Record<string, JsonValue>).content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!b || typeof b !== 'object' || Array.isArray(b) || b instanceof JsonNumber) continue;
        const bb = b as Record<string, JsonValue>;
        if (bb.type !== 'tool_result' || typeof bb.tool_use_id !== 'string') continue;
        const id = bb.tool_use_id;
        if (this.requested.has(id) && !this.seen.has(id)) {
          this.seen.add(id);
          this.record(`proxy:result-seen ${id}`, '');
        }
      }
    }
  }

  /** A JSON (non-streaming) response body. */
  private onJsonBody(text: string): void {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (j.type !== 'message') return;
    const key = typeof j.id === 'string' ? j.id : `anon-${++this.anon}`;
    this.setUsage(key, j.usage, typeof j.model === 'string' ? j.model : undefined);
    if (Array.isArray(j.content))
      for (const b of j.content as Array<Record<string, unknown>>)
        if (b?.type === 'tool_use' && b.name === 'Bash' && typeof b.id === 'string')
          this.bash(b.id, b.input as Record<string, unknown>, false);
  }

  /** The proxy's observer for this session's model route. */
  observer(): RouteObserver {
    return {
      request: (body) => this.onRequest(body),
      response: (status, headers) => {
        if (status === 401) this.authFailedFlag = true;
        if (status === 429) this.limit = limitResetOf(headers, this.now());
        if (status !== 200) return undefined;
        const ct = String(headers['content-type'] ?? '');
        const enc = String(headers['content-encoding'] ?? '').toLowerCase();
        if (enc && enc !== 'identity') return undefined;
        if (ct.includes('text/event-stream')) return this.sseSink();
        if (ct.includes('application/json')) {
          const chunks: Buffer[] = [];
          let size = 0;
          return {
            write: (c) => {
              size += c.length;
              if (size <= EVENT_CAP) chunks.push(c);
            },
            end: () => {
              if (size <= EVENT_CAP) this.onJsonBody(Buffer.concat(chunks).toString('utf8'));
            },
          };
        }
        return undefined;
      },
    };
  }

  private sseSink(): { write(chunk: Buffer): void; end(): void } {
    let buf = '';
    const dec = new StringDecoder('utf8');
    let key = `anon-${++this.anon}`;
    let model: string | undefined;
    const blocks = new Map<
      number,
      { id: string; input: string; preset?: Record<string, unknown>; big: boolean }
    >();
    const onEvent = (data: string): void => {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (e.type) {
        case 'message_start': {
          const m = (e.message ?? {}) as Record<string, unknown>;
          if (typeof m.id === 'string') key = m.id;
          if (typeof m.model === 'string') model = m.model;
          this.setUsage(key, m.usage, model);
          break;
        }
        case 'message_delta':
          this.setUsage(key, e.usage, model);
          break;
        case 'content_block_start': {
          const b = (e.content_block ?? {}) as Record<string, unknown>;
          if (
            b.type === 'tool_use' &&
            b.name === 'Bash' &&
            typeof b.id === 'string' &&
            typeof e.index === 'number'
          ) {
            const preset =
              b.input && typeof b.input === 'object' && Object.keys(b.input).length
                ? (b.input as Record<string, unknown>)
                : undefined;
            blocks.set(e.index, { id: b.id, input: '', ...(preset ? { preset } : {}), big: false });
          }
          break;
        }
        case 'content_block_delta': {
          const d = (e.delta ?? {}) as Record<string, unknown>;
          const b = typeof e.index === 'number' ? blocks.get(e.index) : undefined;
          if (b && d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            if (b.input.length + d.partial_json.length > TOOL_INPUT_CAP) b.big = true;
            else b.input += d.partial_json;
          }
          break;
        }
        case 'content_block_stop': {
          const b = typeof e.index === 'number' ? blocks.get(e.index) : undefined;
          if (b) {
            blocks.delete(e.index as number);
            this.bash(b.id, b.input ? b.input : b.preset, b.big);
          }
          break;
        }
      }
    };
    const drain = (): void => {
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf);
        if (!m) break;
        const raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) onEvent(data);
      }
      // a single event bigger than the cap is dropped (its tool input is capped anyway)
      if (buf.length > EVENT_CAP) buf = '';
    };
    return {
      write: (c) => {
        buf += dec.write(c);
        drain();
      },
      end: () => {
        buf += `${dec.end()}\n\n`;
        drain();
      },
    };
  }
}
