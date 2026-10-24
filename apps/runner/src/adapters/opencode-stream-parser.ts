import type { Usage } from '@aom/shared';
import { redactSecrets } from '../secrets/redact.ts';
import type { RuntimeEvent } from './types.ts';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The JSON events of `opencode run --format json` (opencode 1.19.4, checked against the real binary on 2026-10-24 with a fake
 * OpenAI-compatible API). One object per line: `step_start`, `text {part.text}`, `reasoning`, `tool_use {part.tool, part.callID,
 * part.state {status, input, output, error, metadata}}` (a tool call arrives once, finished), `step_finish {part.tokens {input,
 * output, reasoning, cache {read, write}}, part.reason}` (one per model call; `input` excludes the cached part), and `error
 * {error {name, data {message, statusCode}}}`. Every event carries `sessionID`.
 */

/** The key is wrong or revoked. */
export function isOpencodeAuthFailureText(text: string): boolean {
  return /\b401\b|\b403\b|unauthori[sz]ed|invalid[_ ]api[_ ]key|incorrect api key|api key not valid|authentication[_ ](?:error|failed)|permission_denied|no api key|missing (?:api key|authentication)/i.test(
    text,
  );
}

/** A spent quota or billing limit (not a momentary rate limit): the provider will refuse until it resets. */
export function opencodeUsageLimit(
  text: string,
  now: Date = new Date(),
): { until: Date; parsed: boolean } | undefined {
  if (
    !/insufficient[_ ]quota|exceeded your current quota|billing|credit balance is too low|resource[_ ]exhausted/i.test(
      text,
    )
  )
    return undefined;
  return { until: new Date(now.getTime() + 60 * 60_000), parsed: false };
}

/** What the agent ran, for the activity strip. Secrets are redacted and the text cut at 200 characters. */
function summarize(tool: string, input: unknown): { name: string; summary: string } {
  const p = isObj(input) ? input : {};
  const cut = (s: string): string => redactSecrets(s).slice(0, 200);
  switch (tool) {
    case 'bash':
      return { name: 'Bash', summary: cut(str(p.command)) };
    case 'edit':
    case 'write':
    case 'patch':
    case 'multiedit':
      return { name: 'Edit', summary: cut(str(p.filePath) || str(p.file_path)) };
    case 'read':
      return { name: 'Read', summary: cut(str(p.filePath) || str(p.file_path)) };
    case 'glob':
    case 'list':
      return { name: 'Glob', summary: cut(str(p.pattern) || str(p.path)) };
    case 'grep':
      return { name: 'Grep', summary: cut(str(p.pattern)) };
    case 'webfetch':
      return { name: 'WebFetch', summary: cut(str(p.url)) };
    case 'websearch':
    case 'codesearch':
      return { name: 'WebSearch', summary: cut(str(p.query)) };
    default:
      return { name: tool, summary: '' };
  }
}

export class OpencodeStreamParser {
  sessionId: string | undefined;
  private total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  private lastCall = 0;
  private lastMessage: string | undefined;
  private failure: string | undefined;
  private authFailed = false;
  private limitText: string | undefined;
  private readonly model: string | undefined;
  private readonly chat: boolean;
  private readonly key: { source: 'org' | 'workstation'; provider: string } | undefined;

  /**
   * `chat`: a reply also arrives as `textstart` + `delta` (opencode gives each text part whole). `key`: the stored key that paid
   * (absent: the model needs none, a local endpoint).
   */
  constructor(
    opts: { model?: string; chat?: boolean; key?: { source: 'org' | 'workstation'; provider: string } } = {},
  ) {
    this.model = opts.model;
    this.chat = opts.chat === true;
    this.key = opts.key;
  }

  get authFailure(): boolean {
    return this.authFailed;
  }

  get usageLimitText(): string | undefined {
    return this.limitText;
  }

  get resultError(): string | undefined {
    return this.failure;
  }

  /** Tokens so far; the model is `opencode:<provider>/<model>` so the cost tables read the provider's price list. */
  usage(): Usage {
    return {
      ...this.total,
      ...(this.model ? { model: `opencode:${this.model}` } : {}),
      ...(this.key ? { keySource: this.key.source, keyProvider: this.key.provider } : {}),
    };
  }

  contextTokens(): number {
    return this.lastCall;
  }

  private fail(message: string): void {
    const text = redactSecrets(message).slice(0, 500);
    this.failure = this.failure ? `${this.failure}; ${text}` : text;
    if (isOpencodeAuthFailureText(message)) this.authFailed = true;
    if (opencodeUsageLimit(message)) this.limitText = message;
  }

  parseLine(line: string): RuntimeEvent[] {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return [];
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return [];
    }
    if (!isObj(msg)) return [];
    const out: RuntimeEvent[] = [];
    const sid = str(msg.sessionID);
    if (sid && sid !== this.sessionId) {
      this.sessionId = sid;
      out.push({ kind: 'session', runtimeSessionId: sid });
    }
    const part = isObj(msg.part) ? msg.part : {};
    switch (msg.type) {
      case 'text': {
        const text = str(part.text).trim();
        if (!text) break;
        this.lastMessage = text;
        if (this.chat) out.push({ kind: 'textstart' }, { kind: 'delta', text });
        out.push({ kind: 'progress', text });
        break;
      }
      case 'reasoning':
        out.push({ kind: 'thinking' });
        break;
      case 'tool_use': {
        const tool = str(part.tool);
        const state = isObj(part.state) ? part.state : {};
        const id = str(part.callID) || str(part.id);
        const s = summarize(tool, state.input);
        out.push({ kind: 'tool', name: s.name, summary: s.summary, ...(id ? { id } : {}) });
        if (!id) break;
        const status = str(state.status);
        const error = str(state.error);
        const isError =
          status === 'error' || (isObj(state.metadata) && num(state.metadata.exit) !== 0 && tool === 'bash');
        out.push({
          kind: 'toolresult',
          id,
          bytes: Buffer.byteLength(str(state.output) || error),
          ...(isError ? { isError: true } : {}),
          // a call a permission rule refused: an error that is a refusal
          ...(status === 'error' && /specified a rule which prevents|permission|denied/i.test(error)
            ? { refused: true }
            : {}),
        });
        break;
      }
      case 'step_finish': {
        const t = isObj(part.tokens) ? part.tokens : {};
        const cache = isObj(t.cache) ? t.cache : {};
        this.total.inputTokens += num(t.input);
        // reasoning tokens are billed as output
        this.total.outputTokens += num(t.output) + num(t.reasoning);
        this.total.cacheReadTokens += num(cache.read);
        this.total.cacheWriteTokens += num(cache.write);
        this.lastCall = num(t.input) + num(cache.read) + num(cache.write);
        out.push({ kind: 'usage', usage: this.usage() });
        if (str(part.reason) === 'stop' && this.lastMessage)
          out.push({ kind: 'final', text: this.lastMessage });
        break;
      }
      case 'error': {
        const e = isObj(msg.error) ? msg.error : {};
        const data = isObj(e.data) ? e.data : {};
        const status = num(data.statusCode);
        const text = [str(data.message) || str(e.name) || 'the run failed', status ? `(HTTP ${status})` : '']
          .filter(Boolean)
          .join(' ');
        this.fail(text);
        break;
      }
    }
    return out;
  }
}
