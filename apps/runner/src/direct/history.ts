import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_MESSAGES = 40;
const MAX_CHARS = 60_000;
const ID = /^direct-[0-9a-f-]{36}$/;

/**
 * The memory of a plain chat on a direct model. Claude Code keeps a conversation in its own session; a model API has none, so the
 * runner keeps the text of the earlier messages (user and assistant, no tool traffic) in `<data dir>/direct-chats/<id>.json` and
 * hands the id back as the runtime session id, which the server sends again with the next message. Session turns do not use it:
 * their history travels in the turn message.
 */
export class ChatHistory {
  constructor(private readonly dir: string) {}

  newId(): string {
    return `direct-${randomUUID()}`;
  }

  load(id: string | undefined): HistoryMessage[] {
    if (!id || !ID.test(id)) return [];
    const file = join(this.dir, `${id}.json`);
    if (!existsSync(file)) return [];
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      return Array.isArray(j)
        ? (j as HistoryMessage[]).filter(
            (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
          )
        : [];
    } catch {
      return [];
    }
  }

  save(id: string, messages: HistoryMessage[]): void {
    if (!ID.test(id)) return;
    let kept = messages.slice(-MAX_MESSAGES);
    let total = kept.reduce((n, m) => n + m.content.length, 0);
    while (kept.length > 2 && total > MAX_CHARS) {
      total -= kept[0]?.content.length ?? 0;
      kept = kept.slice(1);
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, `${id}.json`);
    writeFileSync(file, JSON.stringify(kept), { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows
    }
  }

  /**
   * Deletes the chats not written to for `maxAgeMs` (by file modification time: a chat that is still talked in is rewritten on
   * every message, so it stays). Only files named like a chat are touched. Returns how many were removed.
   */
  prune(maxAgeMs: number, now: number = Date.now()): number {
    if (!existsSync(this.dir)) return 0;
    let removed = 0;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
      const file = join(this.dir, name);
      try {
        if (now - statSync(file).mtimeMs > maxAgeMs) {
          rmSync(file, { force: true });
          removed++;
        }
      } catch {
        // gone already or unreadable: leave it
      }
    }
    return removed;
  }
}
