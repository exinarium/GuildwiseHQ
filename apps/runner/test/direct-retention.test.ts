import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withPromptCaching } from '../src/direct/cache.ts';
import { ChatHistory } from '../src/direct/history.ts';
import { tmp } from './helpers.ts';

const id = (n: number) => `direct-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DAY = 86_400_000;

describe('direct chat retention', () => {
  it('prunes chats older than the retention period and keeps recent and foreign files', () => {
    const dir = join(tmp('aom-hist-'), 'direct-chats');
    mkdirSync(dir, { recursive: true });
    const h = new ChatHistory(dir);
    const now = Date.now();
    const put = (name: string, ageDays: number) => {
      const f = join(dir, name);
      writeFileSync(f, '[]');
      const t = new Date(now - ageDays * DAY);
      utimesSync(f, t, t);
    };
    put(`${id(1)}.json`, 120);
    put(`${id(2)}.json`, 89);
    put(`${id(3)}.json`, 91);
    put('notes.json', 400); // not a chat: untouched
    expect(h.prune(90 * DAY, now)).toBe(2);
    expect(existsSync(join(dir, `${id(1)}.json`))).toBe(false);
    expect(existsSync(join(dir, `${id(2)}.json`))).toBe(true);
    expect(existsSync(join(dir, `${id(3)}.json`))).toBe(false);
    expect(existsSync(join(dir, 'notes.json'))).toBe(true);
  });
  it('a chat that is still written to stays, and a missing folder is fine', () => {
    const dir = join(tmp('aom-hist-'), 'direct-chats');
    const h = new ChatHistory(dir);
    expect(h.prune(DAY)).toBe(0);
    const cid = h.newId();
    h.save(cid, [{ role: 'user', content: 'hi' }]);
    expect(h.prune(DAY)).toBe(0);
    expect(h.load(cid)).toHaveLength(1);
  });
});

describe('prompt caching of earlier chat messages', () => {
  it('marks the last earlier message for Anthropic, nothing for other providers', () => {
    const msgs = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ] as never[];
    const a = withPromptCaching('anthropic', 'You are X', msgs, 2);
    expect((a.messages[1] as { providerOptions?: unknown }).providerOptions).toBeTruthy();
    expect((a.messages[2] as { providerOptions?: unknown }).providerOptions).toBeUndefined();
    const g = withPromptCaching('google', 'You are X', msgs, 2);
    expect(g.system).toBe('You are X');
    expect(g.providerOptions).toEqual({});
    expect(withPromptCaching('openai-compatible', '', msgs, 0).providerOptions).toEqual({});
  });
});
