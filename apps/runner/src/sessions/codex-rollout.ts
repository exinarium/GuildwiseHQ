import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Codex's own transcript of a thread (codex-cli 0.164): `$CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<thread id>.jsonl`,
 * one JSON record per line. The first is `session_meta {id, cwd, timestamp}`; `event_msg` records of type `token_count` carry
 * `info.last_token_usage` (the size of the last call's input, which is what the next message resumes on top of). The supervisor
 * reads it to decide whether a shift may continue a Codex thread, as it reads Claude Code's transcripts for Claude sessions.
 */

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dirsOf = (p: string): string[] => {
  try {
    return readdirSync(p)
      .filter((n) => /^\d+$/.test(n))
      .sort()
      .reverse();
  } catch {
    return [];
  }
};

/** The rollout file of a thread in a Codex home, or undefined (newest day folders are looked at first). */
export function codexRolloutFile(codexHome: string, threadId: string): string | undefined {
  if (!THREAD_ID.test(threadId)) return undefined;
  const root = join(codexHome, 'sessions');
  for (const y of dirsOf(root))
    for (const m of dirsOf(join(root, y)))
      for (const d of dirsOf(join(root, y, m))) {
        const dir = join(root, y, m, d);
        try {
          const hit = readdirSync(dir).find(
            (n) => n.startsWith('rollout-') && n.endsWith(`-${threadId}.jsonl`),
          );
          if (hit) return join(dir, hit);
        } catch {
          // a folder that vanished
        }
      }
  return undefined;
}

export interface CodexRolloutInfo {
  id: string;
  cwd: string;
  /** Input tokens of the last model call (0: none yet). */
  contextTokens: number;
  /** Model calls so far. */
  calls: number;
}

const HEAD_BYTES = 64 * 1024;

/** Reads the thread's id and cwd from the first record and its context size from the last `token_count`. Undefined: unreadable. */
export function readCodexRollout(file: string): CodexRolloutInfo | undefined {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return undefined;
    const fd = openSync(file, 'r');
    let head = '';
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      head = buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0)).toString('utf8');
    } finally {
      closeSync(fd);
    }
    const first = JSON.parse(head.split('\n', 1)[0] ?? '') as {
      type?: string;
      payload?: Record<string, unknown>;
    };
    if (first.type !== 'session_meta' || typeof first.payload?.id !== 'string') return undefined;
    let contextTokens = 0;
    let calls = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"token_count"')) continue;
      try {
        const rec = JSON.parse(line) as {
          type?: string;
          payload?: { type?: string; info?: { last_token_usage?: { input_tokens?: number } } | null };
        };
        const n = rec.payload?.info?.last_token_usage?.input_tokens;
        if (rec.type === 'event_msg' && rec.payload?.type === 'token_count' && typeof n === 'number') {
          contextTokens = n;
          calls++;
        }
      } catch {
        // a partly written last line
      }
    }
    return {
      id: first.payload.id,
      cwd: typeof first.payload.cwd === 'string' ? first.payload.cwd : '',
      contextTokens,
      calls,
    };
  } catch {
    return undefined;
  }
}
