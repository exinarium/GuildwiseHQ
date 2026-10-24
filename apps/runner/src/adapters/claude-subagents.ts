import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
 * What each native subagent of a session used, from its transcript: the tokens of every distinct model call (a call is written
 * once per content block, so calls are counted by message id), the model, the time between its first and last entry and the
 * first lines of its last reply. A transcript that cannot be read is skipped (its tokens were spent: the stream's own total
 * for the parent is unaffected, the sub-step is simply missing).
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
        const calls = new Map<string, { model?: string; usage: Usage }>();
        let first: number | undefined;
        let last: number | undefined;
        let reply = '';
        for (const line of readFileSync(transcript, 'utf8').split('\n')) {
          if (!line.startsWith('{')) continue;
          let e: unknown;
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          if (!isObj(e)) continue;
          const t = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : Number.NaN;
          if (Number.isFinite(t)) {
            first = first === undefined ? t : Math.min(first, t);
            last = last === undefined ? t : Math.max(last, t);
          }
          const m = e.message;
          if (e.type !== 'assistant' || !isObj(m)) continue;
          if (isObj(m.usage) && typeof m.id === 'string')
            calls.set(m.id, {
              ...(typeof m.model === 'string' && !m.model.startsWith('<') ? { model: m.model } : {}),
              usage: usageFromClaude(m.usage),
            });
          if (Array.isArray(m.content))
            for (const b of m.content)
              if (isObj(b) && b.type === 'text' && typeof b.text === 'string' && b.text.trim())
                reply = b.text;
        }
        const sum: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        let model: string | undefined;
        for (const c of calls.values()) {
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
          ...(first !== undefined && last !== undefined ? { durationMs: Math.max(0, last - first) } : {}),
          ...(reply ? { summary: summarizeReply(reply) } : {}),
        });
      } catch {
        // an unreadable subagent folder is skipped
      }
    }
  }
  return out;
}
