import { describe, expect, it } from 'vitest';
import { looksLikeSecret, savedWorkBranch } from '../src/hygiene/secrets.ts';

describe('looksLikeSecret', () => {
  it.each([
    '.env',
    '.env.local',
    'apps/web/.env.production',
    'certs/server.pem',
    'deploy.key',
    'id_rsa',
    'id_ed25519',
    'config/api-key.json',
    'credentials.json',
    'secrets.yaml',
    '.npmrc',
    'token.txt.bak',
  ])('flags %s', (f) => expect(looksLikeSecret(f)).toBe(true));

  it.each([
    'src/index.ts',
    'README.md',
    '.env.example',
    '.env.sample',
    'src/keyboard.ts',
    'docs/secrets.md',
    'src/auth/tokenizer.py',
    'package.json',
  ])('lets %s through', (f) => expect(looksLikeSecret(f)).toBe(false));
});

describe('savedWorkBranch', () => {
  it('names the branch after the day, with a suffix when asked', () => {
    const d = new Date('2026-10-10T12:00:00Z');
    expect(savedWorkBranch(d)).toBe('guildwise/saved-work/2026-10-10');
    expect(savedWorkBranch(d, '-2')).toBe('guildwise/saved-work/2026-10-10-2');
  });
});
