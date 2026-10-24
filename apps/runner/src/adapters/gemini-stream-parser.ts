import type { Usage } from '@aom/shared';
import { redactSecrets } from '../secrets/redact.ts';
import type { RuntimeEvent } from './types.ts';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The JSONL events of `gemini -p ... --output-format stream-json` (gemini-cli 0.65.0, checked against the real binary on
 * 2026-10-24 with a fake Gemini API): `init {session_id, model}`, `message {role, content, delta?}`, `tool_use {tool_name,
 * tool_id, parameters}`, `tool_result {tool_id, status, output?, error?}`, `error {severity, message}` and a final
 * `result {status, stats, error?}`. `stats` carries `input` (the non-cached prompt tokens), `cached`, `output_tokens` and
 * `models: {<model>: {...}}`. The CLI also prints human text lines around them (startup notes, colours): only lines that are
 * JSON objects are read.
 */

/** The login or key does not work. */
export function isGeminiAuthFailureText(text: string): boolean {
  return /\b401\b|\b403\b.*(?:permission|credential)|unauthenticated|api key not valid|invalid api key|api_key_invalid|invalid[_ ]grant|token has been (?:expired|revoked)|re-?authenticate|please (?:set|select) an auth|invalid auth method|could not load the default credentials|failed to (?:login|authenticate)|login required|not logged in|refresh token/i.test(
    text,
  );
}

/** "Your quota will reset after 3h5m20s", "exhausted your capacity", RESOURCE_EXHAUSTED: the plan's limit, not a crash. */
export function geminiUsageLimit(
  text: string,
  now: Date = new Date(),
): { until: Date; parsed: boolean } | undefined {
  if (
    !/exhausted your capacity|quota will reset|exceeded your current quota|resource[_ ]exhausted|usage limit/i.test(
      text,
    )
  )
    return undefined;
  const m = /reset after\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i.exec(text);
  if (m && (m[1] || m[2] || m[3])) {
    const ms = ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
    if (ms > 0) return { until: new Date(now.getTime() + ms), parsed: true };
  }
  return { until: new Date(now.getTime() + 60 * 60_000), parsed: false };
}

/** What the agent ran, for the activity strip. Secrets are redacted and the text cut at 200 characters. */
function summarize(tool: string, params: unknown): { name: string; summary: string } {
  const p = isObj(params) ? params : {};
  const cut = (s: string): string => redactSecrets(s).slice(0, 200);
  switch (tool) {
    case 'run_shell_command':
      return { name: 'Bash', summary: cut(str(p.command)) };
    case 'write_file':
    case 'replace':
      return { name: 'Edit', summary: cut(str(p.file_path)) };
    case 'read_file':
    case 'read_many_files':
      return { name: 'Read', summary: cut(str(p.file_path) || str(p.include)) };
    case 'list_directory':
    case 'glob':
      return { name: 'Glob', summary: cut(str(p.pattern) || str(p.dir_path)) };
    case 'grep_search':
    case 'search_file_content':
      return { name: 'Grep', summary: cut(str(p.pattern)) };
    case 'web_fetch':
      return { name: 'WebFetch', summary: cut(str(p.prompt) || str(p.url)) };
    case 'google_web_search':
      return { name: 'WebSearch', summary: cut(str(p.query)) };
    default:
      return { name: tool, summary: '' };
  }
}

export class GeminiStreamParser {
  sessionId: string | undefined;
  private total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  private lastCall = 0;
  /** The assistant text since the last tool call or the end: a progress line, and the final reply. */
  private pending = '';
  private lastMessage: string | undefined;
  private failure: string | undefined;
  private authFailed = false;
  private limitText: string | undefined;
  private textOpen = false;
  private readonly model: string | undefined;
  private readonly chat: boolean;
  private readonly key: { source: 'org' | 'workstation'; provider: string } | undefined;

  /**
   * `chat`: the reply streams as `textstart` + `delta`s, as the chat stream expects. `key`: the stored key that paid (absent: the
   * owner's Google login, which is not billed per token).
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

  /** Tokens so far; the model is `gemini:<model>` so the cost tables never reach a Claude price. */
  usage(): Usage {
    return {
      ...this.total,
      ...(this.model ? { model: `gemini:${this.model}` } : {}),
      ...(this.key ? { keySource: this.key.source, keyProvider: this.key.provider } : {}),
    };
  }

  contextTokens(): number {
    return this.lastCall;
  }

  private fail(message: string): void {
    const text = redactSecrets(message).slice(0, 500);
    this.failure = this.failure ? `${this.failure}; ${text}` : text;
    if (isGeminiAuthFailureText(message)) this.authFailed = true;
    if (geminiUsageLimit(message)) this.limitText = message;
  }

  private flush(out: RuntimeEvent[]): void {
    const text = this.pending.trim();
    this.pending = '';
    this.textOpen = false;
    if (!text) return;
    this.lastMessage = text;
    out.push({ kind: 'progress', text });
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
    switch (msg.type) {
      case 'init': {
        const id = str(msg.session_id);
        if (id) {
          this.sessionId = id;
          out.push({ kind: 'session', runtimeSessionId: id });
        }
        break;
      }
      case 'message': {
        if (msg.role !== 'assistant') break;
        const text = str(msg.content);
        if (!text) break;
        if (this.chat) {
          if (!this.textOpen) out.push({ kind: 'textstart' });
          this.textOpen = true;
          out.push({ kind: 'delta', text });
        }
        this.pending += text;
        break;
      }
      case 'tool_use': {
        this.flush(out);
        const s = summarize(str(msg.tool_name), msg.parameters);
        const id = str(msg.tool_id);
        out.push({ kind: 'tool', name: s.name, summary: s.summary, ...(id ? { id } : {}) });
        break;
      }
      case 'tool_result': {
        const id = str(msg.tool_id);
        if (!id) break;
        const status = str(msg.status);
        const error = isObj(msg.error) ? str(msg.error.message) : '';
        const isError = status !== 'success' && status !== '';
        out.push({
          kind: 'toolresult',
          id,
          bytes: Buffer.byteLength(str(msg.output)),
          ...(isError ? { isError: true } : {}),
          // a call the policy refused ("denied by policy"): an error that is a refusal
          ...(isError && /policy|denied|not allowed|not permitted/i.test(error) ? { refused: true } : {}),
        });
        break;
      }
      case 'error': {
        // a warning or system error: the run's end says whether it failed
        if (msg.severity === 'error' && str(msg.message)) this.fail(str(msg.message));
        break;
      }
      case 'result': {
        this.flush(out);
        const stats = isObj(msg.stats) ? msg.stats : {};
        // `input` is the non-cached part of the prompt, `cached` the cached part, `input_tokens` the sum
        const cached = num(stats.cached);
        const input =
          isObj(stats) && stats.input !== undefined
            ? num(stats.input)
            : Math.max(0, num(stats.input_tokens) - cached);
        this.total.inputTokens += input;
        this.total.cacheReadTokens += cached;
        this.total.outputTokens += num(stats.output_tokens);
        this.lastCall = num(stats.input_tokens);
        if (msg.status === 'error') {
          const e = isObj(msg.error) ? str(msg.error.message) : '';
          this.fail(e || 'the run failed');
        }
        out.push({ kind: 'usage', usage: this.usage() });
        if (this.lastMessage && msg.status !== 'error') out.push({ kind: 'final', text: this.lastMessage });
        break;
      }
    }
    return out;
  }
}
