import type { Usage } from '@aom/shared';
import { isAuthFailureText } from './claude-auth.ts';
import { isUsageLimitText } from './claude-usage-limit.ts';
import type { RuntimeEvent } from './types.ts';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;

export function summarizeToolInput(name: string, input: unknown): string {
  let s: string;
  if (isObj(input) && name === 'Bash' && typeof input.command === 'string') s = input.command;
  else if (isObj(input) && name === 'WebFetch' && typeof input.url === 'string') s = input.url;
  else if (isObj(input) && typeof input.file_path === 'string') s = input.file_path;
  else {
    try {
      s = JSON.stringify(input) ?? '';
    } catch {
      s = String(input);
    }
  }
  return s.slice(0, 200);
}

/** The model with the most output tokens in a result's `modelUsage` map (`{ <model>: { outputTokens, ... } }`). */
function dominantModel(modelUsage: unknown): string | undefined {
  if (!isObj(modelUsage)) return undefined;
  let best: [string, number] | undefined;
  for (const [model, u] of Object.entries(modelUsage)) {
    const n = isObj(u) ? num(u.outputTokens) + num(u.inputTokens) : 0;
    if (!best || n > best[1]) best = [model, n];
  }
  return best?.[0];
}

export function usageFromClaude(u: unknown): Usage {
  const o = isObj(u) ? u : {};
  return {
    inputTokens: num(o.input_tokens),
    outputTokens: num(o.output_tokens),
    cacheReadTokens: num(o.cache_read_input_tokens),
    cacheWriteTokens: num(o.cache_creation_input_tokens),
  };
}

/** The text blocks of an assistant message, joined. */
function assistantText(message: Record<string, unknown>): string {
  const c = message.content;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n');
}

/**
 * Parses `claude -p --output-format stream-json --verbose` lines (docs/ARCHITECTURE.md section 12.2):
 * `system/init` -> session; assistant text -> progress; tool_use -> tool; `result` -> usage + final.
 * Unknown or malformed lines are ignored. The `result` usage is the session total.
 */
export class ClaudeStreamParser {
  /** The session total from the `result` line (authoritative once it arrives). */
  private total: Usage | undefined;
  /** What each assistant message reported, by message id: the running total of a session that never reaches `result`. */
  private readonly perMessage = new Map<string, Usage>();
  private lastModel: string | undefined;
  private errorSubtype: string | undefined;
  sessionId: string | undefined;
  private authFailed = false;
  private limitText: string | undefined;

  /**
   * The session failed because the subscription's usage limit was hit ("You've hit your session limit · resets 6pm"):
   * the message text, seen on an error result or on an assistant message flagged as an API error. Ordinary text that
   * talks about limits is not enough. The reset time is read from it by `detectUsageLimit`.
   */
  get usageLimitText(): string | undefined {
    return this.limitText;
  }

  /**
   * The session failed because the Claude login does not work ("OAuth session expired and could not be refreshed",
   * "Please run /login", an authentication_error): seen on an error result or on an assistant message flagged as an
   * authentication failure. Ordinary text about login is not enough.
   */
  get authFailure(): boolean {
    return this.authFailed;
  }

  /**
   * Token use of the session so far: the `result` line's total when the session finished, else the sum of the
   * assistant messages seen (a shift that was stopped, timed out or crashed still reports what it spent). `model` is
   * the model that did most of the work (`result.modelUsage`) or the last one seen; `costUsd` is what Claude Code
   * itself reported (`total_cost_usd`).
   */
  usage(): Usage {
    if (this.total) return { ...this.total };
    const sum: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const u of this.perMessage.values()) {
      sum.inputTokens += u.inputTokens;
      sum.outputTokens += u.outputTokens;
      sum.cacheReadTokens += u.cacheReadTokens;
      sum.cacheWriteTokens += u.cacheWriteTokens;
    }
    return this.lastModel ? { ...sum, model: this.lastModel } : sum;
  }

  /** Set when the `result` line reported an error (e.g. `error_max_turns`). */
  get resultError(): string | undefined {
    return this.errorSubtype;
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
    const events: RuntimeEvent[] = [];

    if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') {
      this.sessionId = msg.session_id;
      if (typeof msg.model === 'string' && msg.model) this.lastModel = msg.model;
      events.push({ kind: 'session', runtimeSessionId: msg.session_id });
    } else if (msg.type === 'stream_event' && isObj(msg.event)) {
      // `--include-partial-messages`: token deltas of the reply being written.
      const d =
        msg.event.type === 'content_block_delta' && isObj(msg.event.delta) ? msg.event.delta : undefined;
      if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text) {
        events.push({ kind: 'delta', text: d.text });
      }
    } else if (msg.type === 'assistant' && isObj(msg.message)) {
      if (msg.error === 'authentication_failed') this.authFailed = true;
      if (typeof msg.error === 'string' && msg.error) {
        const t = assistantText(msg.message);
        if (isUsageLimitText(t)) this.limitText = t;
      }
      if (typeof msg.message.model === 'string' && msg.message.model && !msg.message.model.startsWith('<'))
        this.lastModel = msg.message.model;
      if (isObj(msg.message.usage) && typeof msg.message.id === 'string')
        this.perMessage.set(msg.message.id, usageFromClaude(msg.message.usage));
    }
    if (msg.type === 'assistant' && isObj(msg.message) && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (!isObj(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          events.push({ kind: 'progress', text: block.text.trim() });
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          events.push({
            kind: 'tool',
            name: block.name,
            summary: summarizeToolInput(block.name, block.input),
          });
        }
      }
    } else if (msg.type === 'result') {
      const model = dominantModel(msg.modelUsage) ?? this.lastModel;
      this.total = {
        ...usageFromClaude(msg.usage),
        ...(model ? { model } : {}),
        ...(typeof msg.total_cost_usd === 'number' &&
        Number.isFinite(msg.total_cost_usd) &&
        msg.total_cost_usd >= 0
          ? { costUsd: msg.total_cost_usd }
          : {}),
      };
      events.push({ kind: 'usage', usage: this.usage() });
      const failed = msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype !== 'success');
      if (failed) this.errorSubtype = typeof msg.subtype === 'string' ? msg.subtype : 'error';
      if (failed && isAuthFailureText(`${typeof msg.result === 'string' ? msg.result : ''}`))
        this.authFailed = true;
      if (failed && typeof msg.result === 'string' && isUsageLimitText(msg.result))
        this.limitText = msg.result;
      if (typeof msg.result === 'string' && msg.result.trim()) {
        events.push({ kind: 'final', text: msg.result });
      }
    }
    return events;
  }
}
