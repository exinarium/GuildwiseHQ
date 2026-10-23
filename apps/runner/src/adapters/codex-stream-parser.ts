import { codexUsageModel, type Usage } from '@aom/shared';
import { redactSecrets } from '../redact.ts';
import type { RuntimeEvent } from './types.ts';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The JSONL events of `codex exec --json` (codex-cli 0.163.0; the schema is `codex-rs/exec/src/exec_events.rs`):
 * `thread.started {thread_id}`, `turn.started`, `turn.completed {usage}`, `turn.failed {error}`, `error {message}` and
 * `item.started|updated|completed {item}` where an item is `agent_message {text}`, `reasoning {text}`,
 * `command_execution {command, aggregated_output, exit_code, status}`, `file_change {changes[], status}`,
 * `mcp_tool_call {server, tool, ...}`, `web_search {query}`, `todo_list` or `error {message}`.
 * Codex does not stream tokens: a reply arrives whole in its `agent_message` item.
 */

/** The login does not work (expired ChatGPT sign-in, revoked or wrong API key, nobody signed in). */
export function isCodexAuthFailureText(text: string): boolean {
  return /\b401\b|unauthori[sz]ed|not (?:logged|signed) in|log ?in again|sign ?in again|please (?:run )?`?codex login|invalid api key|incorrect api key|invalid_api_key|refresh token (?:was |has |is )?(?:expired|revoked|already used|invalid)|token (?:is )?(?:expired|revoked)|authentication (?:failed|required)|missing (?:bearer|authentication)|no api key|OPENAI_API_KEY|CODEX_API_KEY/i.test(
    text,
  );
}

/** "You've hit your usage limit ... try again in 2 hours / at 3:05 PM": the plan's limit, not a crash. */
export function codexUsageLimit(
  text: string,
  now: Date = new Date(),
): { until: Date; parsed: boolean } | undefined {
  if (
    !/hit your usage limit|usage limit (?:has been )?reached|exceeded your (?:current )?quota|rate limit reached/i.test(
      text,
    )
  )
    return undefined;
  const rel =
    /\b(?:in|after)\s+(?:(\d+)\s*(?:days?|d)\b)?\s*(?:(\d+)\s*(?:hours?|hrs?|h)\b)?\s*(?:(\d+)\s*(?:minutes?|mins?|m)\b)?/i.exec(
      text,
    );
  if (rel && (rel[1] || rel[2] || rel[3])) {
    const ms = ((Number(rel[1] ?? 0) * 24 + Number(rel[2] ?? 0)) * 60 + Number(rel[3] ?? 0)) * 60_000;
    if (ms > 0) return { until: new Date(now.getTime() + ms), parsed: true };
  }
  return { until: new Date(now.getTime() + 60 * 60_000), parsed: false };
}

/** What the agent ran, for the activity strip: the command, the paths a patch touched, the query. Secrets redacted, cut at 200. */
function summarize(item: Json): { name: string; summary: string } | undefined {
  switch (item.type) {
    case 'command_execution':
      return { name: 'Bash', summary: redactSecrets(str(item.command)).slice(0, 200) };
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.map((c) => (isObj(c) ? str(c.path) : '')).filter(Boolean);
      return { name: 'Edit', summary: redactSecrets(paths.join(', ')).slice(0, 200) };
    }
    case 'mcp_tool_call':
      return { name: `mcp__${str(item.server)}__${str(item.tool)}`, summary: '' };
    case 'web_search':
      return { name: 'WebSearch', summary: redactSecrets(str(item.query)).slice(0, 200) };
    default:
      return undefined;
  }
}

export class CodexStreamParser {
  sessionId: string | undefined;
  private total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  private lastCall = 0;
  private lastMessage: string | undefined;
  private failure: string | undefined;
  private authFailed = false;
  private limitText: string | undefined;
  private readonly started = new Set<string>();
  private readonly model: string | undefined;
  private readonly chat: boolean;

  /** `chat`: a reply also arrives as `textstart` + `delta` (Codex gives it whole), as the chat stream expects. */
  constructor(opts: { model?: string; chat?: boolean } = {}) {
    this.model = opts.model;
    this.chat = opts.chat === true;
  }

  /** The run failed with a login problem (a `turn.failed` / `error` event, or the text of one). */
  get authFailure(): boolean {
    return this.authFailed;
  }

  get usageLimitText(): string | undefined {
    return this.limitText;
  }

  /** The text of the failure Codex reported (`turn.failed`, `error`), for the exit event. */
  get resultError(): string | undefined {
    return this.failure;
  }

  /** Tokens of every turn so far; `model` is `codex:<model>` so the cost lookup never reaches a Claude price. */
  usage(): Usage {
    return { ...this.total, ...(this.model ? { model: codexUsageModel(this.model) } : {}) };
  }

  /** The last call's input tokens: what the next message resumes on top of. */
  contextTokens(): number {
    return this.lastCall;
  }

  private fail(message: string): void {
    const text = redactSecrets(message).slice(0, 500);
    this.failure = this.failure ? `${this.failure}; ${text}` : text;
    if (isCodexAuthFailureText(message)) this.authFailed = true;
    if (codexUsageLimit(message)) this.limitText = message;
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
      case 'thread.started': {
        const id = str(msg.thread_id);
        if (id) {
          this.sessionId = id;
          out.push({ kind: 'session', runtimeSessionId: id });
        }
        break;
      }
      case 'turn.completed': {
        const u = isObj(msg.usage) ? msg.usage : {};
        // `input_tokens` counts the cached and cache-written part too (the OpenAI convention): the non-cached part is what is
        // priced at the input price, so each token is priced once. `reasoning_output_tokens` is part of `output_tokens`.
        const cached = num(u.cached_input_tokens);
        const written = num(u.cache_write_input_tokens);
        const input = num(u.input_tokens);
        this.total.inputTokens += Math.max(0, input - cached - written);
        this.total.cacheReadTokens += cached;
        this.total.cacheWriteTokens += written;
        this.total.outputTokens += num(u.output_tokens);
        this.lastCall = input;
        out.push({ kind: 'usage', usage: this.usage() });
        if (this.lastMessage) out.push({ kind: 'final', text: this.lastMessage });
        break;
      }
      case 'turn.failed': {
        const err = isObj(msg.error) ? str(msg.error.message) : '';
        this.fail(err || 'the turn failed');
        break;
      }
      case 'error': {
        const m = str(msg.message);
        // "Reconnecting... 2/5 (...)" is a retry in progress (codex 0.163), not a failure; the run's end says if it failed
        if (m && !/^Reconnecting\.\.\./i.test(m)) this.fail(m);
        break;
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        if (isObj(msg.item)) this.item(msg.type, msg.item, out);
        break;
      }
    }
    return out;
  }

  private item(kind: string, item: Json, out: RuntimeEvent[]): void {
    const id = str(item.id);
    switch (item.type) {
      case 'agent_message': {
        const text = str(item.text).trim();
        if (kind !== 'item.completed' || !text) return;
        this.lastMessage = text;
        if (this.chat) out.push({ kind: 'textstart' }, { kind: 'delta', text });
        out.push({ kind: 'progress', text });
        return;
      }
      case 'reasoning':
        if (kind === 'item.started' || (kind === 'item.completed' && !this.started.has(id))) {
          this.started.add(id);
          out.push({ kind: 'thinking' });
        }
        return;
      case 'error':
        // a non-fatal error surfaced as an item (e.g. "Falling back from WebSockets to HTTPS"): not the agent's words and not
        // a failure of the run; a fatal one arrives as a `turn.failed` / `error` event
        return;
      case 'command_execution':
      case 'file_change':
      case 'mcp_tool_call':
      case 'web_search': {
        const s = summarize(item);
        if (!s) return;
        if (!this.started.has(id)) {
          this.started.add(id);
          out.push({ kind: 'tool', name: s.name, summary: s.summary, ...(id ? { id } : {}) });
        }
        if (kind !== 'item.completed' || !id) return;
        const status = str(item.status);
        const exit = typeof item.exit_code === 'number' ? item.exit_code : 0;
        const declined = status === 'declined';
        const isError =
          declined ||
          status === 'failed' ||
          (item.type === 'command_execution' && exit !== 0) ||
          isObj(item.error);
        out.push({
          kind: 'toolresult',
          id,
          bytes: item.type === 'command_execution' ? Buffer.byteLength(str(item.aggregated_output)) : 0,
          ...(isError ? { isError: true } : {}),
          ...(declined ? { refused: true } : {}),
        });
        return;
      }
    }
  }
}
