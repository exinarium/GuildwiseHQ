import type { Usage } from '@aom/shared';
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

export function usageFromClaude(u: unknown): Usage {
  const o = isObj(u) ? u : {};
  return {
    inputTokens: num(o.input_tokens),
    outputTokens: num(o.output_tokens),
    cacheReadTokens: num(o.cache_read_input_tokens),
    cacheWriteTokens: num(o.cache_creation_input_tokens),
  };
}

/**
 * Parses `claude -p --output-format stream-json --verbose` lines (docs/ARCHITECTURE.md section 12.2):
 * `system/init` -> session; assistant text -> progress; tool_use -> tool; `result` -> usage + final.
 * Unknown or malformed lines are ignored. The `result` usage is the session total.
 */
export class ClaudeStreamParser {
  private total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  private errorSubtype: string | undefined;
  sessionId: string | undefined;

  usage(): Usage {
    return { ...this.total };
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
      events.push({ kind: 'session', runtimeSessionId: msg.session_id });
    } else if (msg.type === 'stream_event' && isObj(msg.event)) {
      // `--include-partial-messages`: token deltas of the reply being written.
      const d =
        msg.event.type === 'content_block_delta' && isObj(msg.event.delta) ? msg.event.delta : undefined;
      if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text) {
        events.push({ kind: 'delta', text: d.text });
      }
    } else if (msg.type === 'assistant' && isObj(msg.message) && Array.isArray(msg.message.content)) {
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
      this.total = usageFromClaude(msg.usage);
      events.push({ kind: 'usage', usage: this.usage() });
      const failed = msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype !== 'success');
      if (failed) this.errorSubtype = typeof msg.subtype === 'string' ? msg.subtype : 'error';
      if (typeof msg.result === 'string' && msg.result.trim()) {
        events.push({ kind: 'final', text: msg.result });
      }
    }
    return events;
  }
}
