import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scriptedReply } from '../src/adapters/mock.ts';

const dir = mkdtempSync(join(tmpdir(), 'aom-replies-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, 'replies.json');
writeFileSync(
  file,
  JSON.stringify({
    'What is the status?': 'All green, said {name}.',
    '/^how (are|is) /i': 'Fine, thanks for asking: "{message}".',
    '*': ['Default one from {name}.', 'Default two from {name}.'],
  }),
);

describe('scripted mock replies (recording and simulated workstations)', () => {
  it('matches the exact message, then patterns, then the default', () => {
    expect(scriptedReply('  what is the STATUS? ', 'Ada', file)).toBe('All green, said Ada.');
    expect(scriptedReply('How are you', 'Ada', file)).toBe('Fine, thanks for asking: "How are you".');
    const d = scriptedReply('something else', 'Ada', file);
    expect(d).toMatch(/^Default (one|two) from Ada\.$/);
    // the same question always gets the same answer
    expect(scriptedReply('something else', 'Ada', file)).toBe(d);
  });

  it('does nothing without a file, with an unreadable one, or without a matching entry', () => {
    expect(scriptedReply('hi', 'Ada', undefined)).toBeNull();
    expect(scriptedReply('hi', 'Ada', join(dir, 'missing.json'))).toBeNull();
    const only = join(dir, 'only.json');
    writeFileSync(only, JSON.stringify({ hello: 'x' }));
    expect(scriptedReply('goodbye', 'Ada', only)).toBeNull();
  });
});
