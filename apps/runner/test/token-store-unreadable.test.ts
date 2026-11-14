import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTokenStore } from '../src/forge/index.ts';
import { unregisterSecret } from '../src/secrets/redact.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const key = () => Buffer.alloc(32, 9);
const TOKENS = ['made-up-token-one', 'made-up-token-two', 'made-up-token-new'];
afterEach(() => {
  for (const t of TOKENS) unregisterSecret(t);
});

const setup = () => {
  const dir = mkdtempSync(join(tmp(), 'tku-'));
  return { dir, file: join(dir, 'git-tokens.json') };
};
const sealedEnvelope = (): Record<string, unknown> => {
  const { file } = setup();
  new FileTokenStore(file, key).set({ provider: 'gitlab', host: 'gitlab.com', token: TOKENS[0] });
  return JSON.parse(readFileSync(file, 'utf8'));
};
const quarantined = (dir: string) => readdirSync(dir).filter((n) => n.includes('.unreadable-'));

const unreadableCases: Array<[string, () => unknown]> = [
  ['a wrong-type ct', () => ({ ...sealedEnvelope(), ct: 123 })],
  ['a changed alg', () => ({ ...sealedEnvelope(), alg: 'rot13' })],
  ['a missing tag', () => ({ ...sealedEnvelope(), tag: undefined })],
  ['a future version', () => ({ ...sealedEnvelope(), v: 2 })],
  ['only some envelope keys', () => ({ v: 1, ct: 'abc' })],
  ['an object with no token entries', () => ({ foo: 1, bar: { x: true } })],
];

describe('git-tokens.json that is not a readable token file is kept, not migrated to an empty map', () => {
  for (const [name, make] of unreadableCases) {
    it(`${name}: reported, bytes kept, no tokens, set() quarantines the original`, () => {
      const { dir, file } = setup();
      const bytes = JSON.stringify(make());
      writeFileSync(file, bytes);
      const s = new FileTokenStore(file, key);
      expect(s.problem()).toBeDefined();
      expect(s.problem()).not.toContain(TOKENS[0]);
      expect(s.get('gitlab', 'gitlab.com')).toBeUndefined();
      expect(s.list()).toEqual([]);
      expect(readFileSync(file, 'utf8')).toBe(bytes);
      expect(s.remove('gitlab', 'gitlab.com')).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe(bytes);

      s.set({ provider: 'gitlab', host: 'gitlab.com', token: TOKENS[2] });
      const kept = quarantined(dir);
      expect(kept).toHaveLength(1);
      expect(readFileSync(join(dir, kept[0]), 'utf8')).toBe(bytes);
      expect(s.problem()).toBeUndefined();
      expect(s.get('gitlab', 'gitlab.com')?.token).toBe(TOKENS[2]);
    });
  }
});

describe('files that still read', () => {
  it('a legacy plaintext file migrates; valid entries are kept, junk is dropped', () => {
    const { file } = setup();
    const entry = (token: string, host: string) => ({
      provider: 'gitlab',
      host,
      token,
      savedAt: '2026-01-01T00:00:00.000Z',
    });
    writeFileSync(
      file,
      JSON.stringify({
        'gitlab@a.example': entry(TOKENS[0], 'a.example'),
        'gitlab@b.example': entry(TOKENS[1], 'b.example'),
        junk: 5,
      }),
    );
    const s = new FileTokenStore(file, key);
    expect(s.problem()).toBeUndefined();
    expect(s.get('gitlab', 'a.example')?.token).toBe(TOKENS[0]);
    expect(s.get('gitlab', 'b.example')?.token).toBe(TOKENS[1]);
    expect(s.list()).toHaveLength(2);
    s.set({ provider: 'gitlab', host: 'c.example', token: TOKENS[2] });
    expect(readFileSync(file, 'utf8')).not.toContain(TOKENS[0]);
    expect(JSON.parse(readFileSync(file, 'utf8')).v).toBe(1);
    expect(s.list()).toHaveLength(3);
  });

  it('{} and a missing file are an empty store without a problem', () => {
    const { file } = setup();
    const s = new FileTokenStore(file, key);
    expect(s.problem()).toBeUndefined();
    expect(s.list()).toEqual([]);
    writeFileSync(file, '{}');
    expect(s.problem()).toBeUndefined();
    expect(s.list()).toEqual([]);
  });

  it('a sealed v1 file round-trips set, get, list and remove', () => {
    const { file } = setup();
    const s = new FileTokenStore(file, key);
    s.set({ provider: 'gitlab', host: 'gitlab.com', token: TOKENS[0] });
    s.set({ provider: 'bitbucket', host: 'bitbucket.org', token: TOKENS[1], user: 'me' });
    const again = new FileTokenStore(file, key);
    expect(again.problem()).toBeUndefined();
    expect(again.get('gitlab', 'gitlab.com')?.token).toBe(TOKENS[0]);
    expect(again.list()).toHaveLength(2);
    expect(again.remove('gitlab', 'gitlab.com')).toBe(true);
    expect(again.get('gitlab', 'gitlab.com')).toBeUndefined();
    expect(again.get('bitbucket', 'bitbucket.org')?.token).toBe(TOKENS[1]);
  });
});
