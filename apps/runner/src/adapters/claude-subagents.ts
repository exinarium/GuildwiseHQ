import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { Usage } from '@aom/shared';
import { summarizeReply } from '@aom/shared';
import { usageFromClaude } from './claude-stream-parser.ts';
import type { NativeSubagent, NativeSubagentUsage } from './types.ts';

/**
 * Claude Code's native subagents (the `Agent` tool), for the granted delegation targets only (docs/ARCHITECTURE.md section 38.9).
 * Verified with claude 2.1.309: the tool is named `Agent` (the older name `Task` is denied too), a PreToolUse hook sees
 * `tool_input.subagent_type` and refuses with exit 2 or a deny decision; `--agents <file>` defines the types; a subagent runs
 * in the foreground (the parent waits for it) when `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`; the stream's `result.usage` is the
 * parent's own tokens while `modelUsage` and `total_cost_usd` include the subagents, and each subagent keeps a transcript with
 * per-message usage under `<config dir>/projects/<cwd>/<session id>/subagents/agent-<id>.jsonl` (+ `.meta.json` with the type
 * and the parent's tool call id).
 */

/** The `--agents` document: the type name to its definition. */
export function agentsDocument(subagents: readonly NativeSubagent[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of subagents)
    out[s.name] = {
      description: s.description.slice(0, 500),
      prompt: s.prompt,
      tools: s.tools,
      model: s.model,
    };
  return out;
}

/** The environment that keeps a subagent in the foreground, so the parent waits for it and the write order is plain. */
export const NATIVE_SUBAGENT_ENV = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** `<config dir>/projects/*\/<session id>/subagents`, wherever Claude Code put the project folder. */
function subagentDirs(configDir: string, sessionId: string): string[] {
  const projects = join(configDir, 'projects');
  if (!existsSync(projects)) return [];
  const out: string[] = [];
  try {
    for (const p of readdirSync(projects)) {
      const d = join(projects, p, sessionId, 'subagents');
      if (existsSync(d)) out.push(d);
    }
  } catch {
    // no projects folder to read
  }
  return out;
}

/**
 * One subagent transcript, read incrementally: the file is read from where the last read stopped, so polling a long transcript
 * every few seconds (the live usage of a running subagent, for the organization key's cap) costs only the new lines. A call is
 * written once per content block, so calls are counted by message id.
 */
class TranscriptReader {
  private offset = 0;
  private tail = '';
  readonly calls = new Map<string, { model?: string; usage: Usage }>();
  first: number | undefined;
  last: number | undefined;
  reply = '';

  constructor(readonly path: string) {}

  read(): void {
    let fd: number | undefined;
    try {
      fd = openSync(this.path, 'r');
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        // the file was replaced by a shorter one: start over
        this.offset = 0;
        this.tail = '';
        this.calls.clear();
        this.first = this.last = undefined;
        this.reply = '';
      }
      let pos = this.offset;
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(1 << 20, size - pos));
        const n = readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        pos += n;
        this.take(buf.subarray(0, n).toString('utf8'));
      }
      this.offset = pos;
      // a final line without its newline yet: used if it is complete (counting it again when its newline arrives changes nothing)
      if (this.tail) this.line(this.tail);
    } catch {
      // not readable now: what was read stays
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private take(chunk: string): void {
    const lines = (this.tail + chunk).split('\n');
    // the last piece may be half a line (a multi-byte character cut between reads is rare and costs one line)
    this.tail = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  private line(line: string): void {
    if (!line.startsWith('{')) return;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObj(e)) return;
    const t = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : Number.NaN;
    if (Number.isFinite(t)) {
      this.first = this.first === undefined ? t : Math.min(this.first, t);
      this.last = this.last === undefined ? t : Math.max(this.last, t);
    }
    const m = e.message;
    if (e.type !== 'assistant' || !isObj(m)) return;
    if (isObj(m.usage) && typeof m.id === 'string')
      this.calls.set(m.id, {
        ...(typeof m.model === 'string' && !m.model.startsWith('<') ? { model: m.model } : {}),
        usage: usageFromClaude(m.usage),
      });
    if (Array.isArray(m.content))
      for (const b of m.content)
        if (isObj(b) && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) this.reply = b.text;
  }
}

/** Readers by transcript path, so a poll continues where the last one stopped. Bounded: the oldest are forgotten. */
const readers = new Map<string, TranscriptReader>();
const MAX_READERS = 300;

function readerFor(path: string): TranscriptReader {
  let r = readers.get(path);
  if (!r) {
    r = new TranscriptReader(path);
    readers.set(path, r);
    if (readers.size > MAX_READERS) readers.delete(readers.keys().next().value as string);
  }
  return r;
}

/** Forgets what was read of a session's transcripts (the session is over and booked). */
export function forgetNativeTranscripts(configDir: string, sessionId: string | undefined): void {
  if (!sessionId) return;
  for (const dir of subagentDirs(configDir, sessionId))
    for (const k of [...readers.keys()]) if (k.startsWith(`${dir}/`)) readers.delete(k);
}

/**
 * What each native subagent of a session used, from its transcript: the tokens of every distinct model call (a call is written
 * once per content block, so calls are counted by message id), the model, the time between its first and last entry and the
 * first lines of its last reply. A transcript that cannot be read is skipped (its tokens were spent: the stream's own total
 * for the parent is unaffected, the sub-step is simply missing). Incremental: it can be called while the session runs.
 */
export function readNativeSubagentUsage(
  configDir: string,
  sessionId: string | undefined,
): NativeSubagentUsage[] {
  if (!sessionId) return [];
  const out: NativeSubagentUsage[] = [];
  for (const dir of subagentDirs(configDir, sessionId)) {
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
    } catch {
      continue;
    }
    for (const metaFile of files) {
      try {
        const meta = JSON.parse(readFileSync(join(dir, metaFile), 'utf8')) as Record<string, unknown>;
        const toolUseId = typeof meta.toolUseId === 'string' ? meta.toolUseId : undefined;
        if (!toolUseId) continue;
        const name = typeof meta.agentType === 'string' ? meta.agentType : 'subagent';
        const transcript = join(dir, metaFile.replace(/\.meta\.json$/, '.jsonl'));
        if (!existsSync(transcript)) continue;
        const rd = readerFor(transcript);
        rd.read();
        const sum: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        let model: string | undefined;
        for (const c of rd.calls.values()) {
          sum.inputTokens += c.usage.inputTokens;
          sum.outputTokens += c.usage.outputTokens;
          sum.cacheReadTokens += c.usage.cacheReadTokens;
          sum.cacheWriteTokens += c.usage.cacheWriteTokens;
          model ??= c.model;
        }
        out.push({
          toolUseId,
          name,
          usage: { ...sum, ...(model ? { model } : {}) },
          ...(rd.first !== undefined && rd.last !== undefined
            ? { durationMs: Math.max(0, rd.last - rd.first) }
            : {}),
          ...(rd.reply ? { summary: summarizeReply(rd.reply) } : {}),
        });
      } catch {
        // an unreadable subagent folder is skipped
      }
    }
  }
  return out;
}
