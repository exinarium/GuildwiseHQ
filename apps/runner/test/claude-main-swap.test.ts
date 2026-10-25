import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeAccountRegistry } from '../src/adapters/claude-accounts.ts';
import { recoverClaudeMainSwap, swapClaudeMain } from '../src/adapters/claude-main-swap.ts';
import type { ClaudeAccountConfig } from '../src/config.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const put = (file: string, doc: unknown) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(doc));
};

function rig(
  over: {
    authMode?: 'default' | 'oauth';
    busy?: boolean;
    scope?: boolean;
    accounts?: ClaudeAccountConfig[];
  } = {},
) {
  const home = tmp('aom-swap-home-');
  const root = tmp('aom-swap-root-');
  const acctDir = join(home, '.claude-gw-work');
  const accounts = over.accounts ?? [{ key: 'work', source: 'config_dir' as const }];
  const registry = new ClaudeAccountRegistry({
    home,
    root,
    secretsDir: join(root, 'secrets'),
    accounts: () => accounts,
    mainCredential: () => ({ authMode: over.authMode ?? 'default' }),
  });
  put(join(home, '.claude', '.credentials.json'), {
    claudeAiOauth: { accessToken: 'MAIN', refreshToken: 'rm', expiresAt: 1 },
    mcpOAuth: { 'plugin:x': { expiresAt: 5 } },
  });
  put(join(home, '.claude.json'), { oauthAccount: { emailAddress: 'main@x.test' }, projects: { a: 1 } });
  put(join(acctDir, '.credentials.json'), {
    claudeAiOauth: { accessToken: 'WORK', refreshToken: 'rw', expiresAt: 2 },
  });
  put(join(acctDir, '.claude.json'), { oauthAccount: { emailAddress: 'work@x.test' } });
  const deps = {
    home,
    root,
    registry,
    machineScopeAllowed: over.scope ?? true,
    busy: () => over.busy ?? false,
    mainAuthMode: () => over.authMode ?? 'default',
  };
  return { home, root, acctDir, registry, deps };
}

describe('Make main for Claude Code', () => {
  it('swaps the model login and the shown account, keeps plugin sign-ins and the rest, and swapping again undoes it', async () => {
    const r = rig();
    expect(await swapClaudeMain('work', r.deps)).toEqual({ ok: true });
    const mainCreds = json(join(r.home, '.claude', '.credentials.json'));
    expect(mainCreds.claudeAiOauth.accessToken).toBe('WORK');
    expect(mainCreds.mcpOAuth).toEqual({ 'plugin:x': { expiresAt: 5 } }); // plugin sign-ins stay with the machine
    expect(json(join(r.acctDir, '.credentials.json')).claudeAiOauth.accessToken).toBe('MAIN');
    expect(json(join(r.home, '.claude.json'))).toEqual({
      oauthAccount: { emailAddress: 'work@x.test' },
      projects: { a: 1 },
    });
    expect(json(join(r.acctDir, '.claude.json')).oauthAccount.emailAddress).toBe('main@x.test');
    expect(existsSync(join(r.root, 'claude-main-swap.json'))).toBe(false);
    // undo
    expect(await swapClaudeMain('work', r.deps)).toEqual({ ok: true });
    expect(json(join(r.home, '.claude', '.credentials.json')).claudeAiOauth.accessToken).toBe('MAIN');
    expect(json(join(r.acctDir, '.claude.json')).oauthAccount.emailAddress).toBe('work@x.test');
  });

  it('the login state and the usage limit follow the login', async () => {
    const r = rig();
    r.registry.main.usage.markLimited(new Date(Date.now() + 3600_000));
    expect(await swapClaudeMain('work', r.deps)).toEqual({ ok: true });
    expect(r.registry.main.usage.state).toBe('ok');
    expect(r.registry.get('work')?.usage.state).toBe('limited');
  });

  it.each([
    ['the owner did not allow web changes to the machine login', { scope: false }, 'primary pairing'],
    ['agents are working', { busy: true }, 'wait until they are done'],
    ['the main account is a token', { authMode: 'oauth' as const }, 'token or API key'],
  ])('refuses when %s, and changes nothing', async (_n, over, text) => {
    const r = rig(over);
    const res = await swapClaudeMain('work', r.deps);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain(text);
    expect(json(join(r.home, '.claude', '.credentials.json')).claudeAiOauth.accessToken).toBe('MAIN');
  });

  it('refuses an unknown account, main itself and a token account', async () => {
    const r = rig({
      accounts: [
        { key: 'work', source: 'config_dir' },
        { key: 'tok', source: 'token' },
      ],
    });
    expect((await swapClaudeMain('nope', r.deps)).ok).toBe(false);
    expect((await swapClaudeMain('main', r.deps)).ok).toBe(false);
    const t = await swapClaudeMain('tok', r.deps);
    expect(!t.ok && t.error).toContain('token or key');
  });

  it('needs both accounts signed in', async () => {
    const r = rig();
    put(join(r.acctDir, '.credentials.json'), {});
    const res = await swapClaudeMain('work', r.deps);
    expect(!res.ok && res.error).toContain('both accounts must be signed in');
    expect(json(join(r.home, '.claude', '.credentials.json')).claudeAiOauth.accessToken).toBe('MAIN');
  });

  it('finishes a swap that stopped after the journal was written', async () => {
    const r = rig();
    const main = join(r.home, '.claude', '.credentials.json');
    const tmpFile = `${main}.aom-swap.tmp`;
    put(tmpFile, { claudeAiOauth: { accessToken: 'WORK' } });
    writeFileSync(
      join(r.root, 'claude-main-swap.json'),
      JSON.stringify({ pairs: [{ tmp: tmpFile, final: main }] }),
    );
    expect(recoverClaudeMainSwap(r.root)).toBe(1);
    expect(json(main).claudeAiOauth.accessToken).toBe('WORK');
    expect(existsSync(tmpFile)).toBe(false);
    expect(recoverClaudeMainSwap(r.root)).toBe(0);
  });
});
