import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALIAS_BLOCK_END,
  ALIAS_BLOCK_START,
  ensureClaudeAccount,
  OWNER_MARKER,
  type ProvisionDeps,
} from '../src/adapters/claude-account-provision.ts';
import { ClaudeAccountRegistry } from '../src/adapters/claude-accounts.ts';
import { loadConfig, saveConfig } from '../src/config.ts';
import { cleanupTmp, makeConfig, tmp } from './helpers.ts';

cleanupTmp();

// The owner's real, interactive account: provisioning must never adopt or touch it.
const OWNER_BASHRC = [
  '# my shell',
  "alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'",
  "alias claude-personal='CLAUDE_CONFIG_DIR=~/.claude claude'",
  '',
].join('\n');

function env(over: Partial<ProvisionDeps> = {}, bashrc: string | null = OWNER_BASHRC) {
  const home = tmp('aom-prov-home-'); // a temp HOME: the real one is never read
  const root = tmp('aom-prov-root-');
  const configPath = join(root, 'config.json');
  saveConfig(configPath, makeConfig('http://localhost:1'));
  if (bashrc !== null) writeFileSync(join(home, '.bashrc'), bashrc);
  mkdirSync(join(home, '.claude-work'));
  writeFileSync(join(home, '.claude-work', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"OWNER"}}');
  const registry = new ClaudeAccountRegistry({
    home,
    root,
    accounts: () => loadConfig(configPath).runtimes['claude-code'].accounts,
    mainCredential: () => ({ authMode: 'default' }),
  });
  const probes: string[] = [];
  const deps: ProvisionDeps = {
    home,
    root,
    configPath,
    machineScopeAllowed: true,
    registry,
    probeLogin: async (k) => {
      probes.push(k);
      return 'ok';
    },
    platform: 'linux',
    shell: '/bin/bash',
    ...over,
  };
  return { home, root, configPath, deps, probes, bashrc: () => readFileSync(join(home, '.bashrc'), 'utf8') };
}

describe('claude.account.ensure: runner-owned folders only', () => {
  it("never adopts the owner's ~/.claude-work or claude-work alias: it makes ~/.claude-gw-work and claude-gw-work", async () => {
    const e = env();
    const ownerCreds = readFileSync(join(e.home, '.claude-work', '.credentials.json'), 'utf8');
    const r = await ensureClaudeAccount({ key: 'work' }, e.deps);
    expect(r).toMatchObject({
      key: 'work',
      state: 'awaiting_login',
      configDir: '~/.claude-gw-work',
      aliasAdded: true,
    });
    expect(r.aliasExisting).toBeUndefined();
    expect(existsSync(join(e.home, '.claude-gw-work', OWNER_MARKER))).toBe(true);
    expect(statSync(join(e.home, '.claude-gw-work')).mode & 0o777).toBe(0o700);
    // the owner's account is untouched, and the alias block adds only our own line
    expect(readFileSync(join(e.home, '.claude-work', '.credentials.json'), 'utf8')).toBe(ownerCreds);
    expect(existsSync(join(e.home, '.claude-work', OWNER_MARKER))).toBe(false);
    expect(e.bashrc().startsWith(OWNER_BASHRC)).toBe(true);
    expect(e.bashrc()).toContain(
      `${ALIAS_BLOCK_START}\nalias claude-gw-work='CLAUDE_CONFIG_DIR=~/.claude-gw-work claude'\n${ALIAS_BLOCK_END}`,
    );
    expect(loadConfig(e.configPath).runtimes['claude-code'].accounts).toEqual([
      { key: 'work', configDir: '~/.claude-gw-work', source: 'config_dir' },
    ]);
    // the account exists and is unusable until the login is done
    expect(e.deps.registry.get('work')?.info()).toMatchObject({
      login: 'none',
      configDir: '~/.claude-gw-work',
    });
    expect(e.deps.registry.get('work')?.usable).toBe(false);
  });

  it('a second ensure is a no-op (file bytes identical, block once)', async () => {
    const e = env();
    await ensureClaudeAccount({ key: 'work' }, e.deps);
    const after = e.bashrc();
    const cfg = readFileSync(e.configPath, 'utf8');
    const r2 = await ensureClaudeAccount({ key: 'work' }, e.deps);
    expect(r2).toMatchObject({ state: 'awaiting_login', aliasAdded: false });
    expect(e.bashrc()).toBe(after);
    expect(readFileSync(e.configPath, 'utf8')).toBe(cfg);
    expect(e.bashrc().split(ALIAS_BLOCK_START)).toHaveLength(2);
  });

  it('a second key goes inside the same block, sorted; lines outside are never edited', async () => {
    const e = env();
    await ensureClaudeAccount({ key: 'zeta' }, e.deps);
    await ensureClaudeAccount({ key: 'alpha' }, e.deps);
    const text = e.bashrc();
    expect(text.split(ALIAS_BLOCK_START)).toHaveLength(2);
    const block = text.slice(text.indexOf(ALIAS_BLOCK_START), text.indexOf(ALIAS_BLOCK_END));
    expect(block.indexOf('claude-gw-alpha')).toBeGreaterThan(0);
    expect(block.indexOf('claude-gw-alpha')).toBeLessThan(block.indexOf('claude-gw-zeta'));
    expect(text.startsWith(OWNER_BASHRC)).toBe(true);
  });

  it('creates ~/.bashrc when missing, and uses ~/.zshrc for zsh', async () => {
    const e = env({ shell: '/usr/bin/zsh' }, null);
    await ensureClaudeAccount({ key: 'work' }, e.deps);
    expect(existsSync(join(e.home, '.bashrc'))).toBe(false);
    expect(readFileSync(join(e.home, '.zshrc'), 'utf8')).toContain('claude-gw-work');
  });

  it('a default folder that exists WITHOUT the marker is not touched or adopted: failed, with a clear detail', async () => {
    const e = env();
    mkdirSync(join(e.home, '.claude-gw-work'));
    writeFileSync(join(e.home, '.claude-gw-work', 'theirs.txt'), 'x');
    const before = e.bashrc();
    const r = await ensureClaudeAccount({ key: 'work' }, e.deps);
    expect(r.state).toBe('failed');
    expect(r.detail).toMatch(/already exists and was not created by Guildwise/);
    expect(existsSync(join(e.home, '.claude-gw-work', OWNER_MARKER))).toBe(false);
    expect(e.bashrc()).toBe(before);
    expect(loadConfig(e.configPath).runtimes['claude-code'].accounts).toEqual([]);
  });

  it('a folder the runner created earlier (marker) is recognised and reused', async () => {
    const e = env();
    mkdirSync(join(e.home, '.claude-gw-work'));
    writeFileSync(join(e.home, '.claude-gw-work', OWNER_MARKER), 'mine');
    const r = await ensureClaudeAccount({ key: 'work' }, e.deps);
    expect(r.state).toBe('awaiting_login');
    expect(r.configDir).toBe('~/.claude-gw-work');
  });

  it('a folder explicitly configured in config.json is honoured (the owner chose it)', async () => {
    const e = env();
    const cfg = loadConfig(e.configPath);
    const cc = cfg.runtimes['claude-code'];
    saveConfig(e.configPath, {
      ...cfg,
      runtimes: {
        ...cfg.runtimes,
        'claude-code': {
          ...cc,
          accounts: [{ key: 'work', configDir: '~/.claude-work', source: 'config_dir' }],
        },
      },
    });
    const r = await ensureClaudeAccount({ key: 'work' }, e.deps);
    expect(r).toMatchObject({ state: 'ready', configDir: '~/.claude-work' });
    expect(e.probes).toEqual(['work']);
    expect(existsSync(join(e.home, '.claude-work', OWNER_MARKER))).toBe(false);
  });

  it('an existing login in a runner-owned folder gives ready (and awaiting_login when the probe says expired)', async () => {
    const e = env();
    mkdirSync(join(e.home, '.claude-gw-work'));
    writeFileSync(join(e.home, '.claude-gw-work', OWNER_MARKER), 'mine');
    writeFileSync(
      join(e.home, '.claude-gw-work', '.credentials.json'),
      '{"claudeAiOauth":{"accessToken":"a"}}',
    );
    expect((await ensureClaudeAccount({ key: 'work' }, e.deps)).state).toBe('ready');
    const e2 = env({ probeLogin: async () => 'expired' });
    mkdirSync(join(e2.home, '.claude-gw-work'));
    writeFileSync(join(e2.home, '.claude-gw-work', OWNER_MARKER), 'mine');
    writeFileSync(
      join(e2.home, '.claude-gw-work', '.credentials.json'),
      '{"claudeAiOauth":{"accessToken":"a"}}',
    );
    expect((await ensureClaudeAccount({ key: 'work' }, e2.deps)).state).toBe('awaiting_login');
  });

  it('an alias of our name outside the block is a conflict and is left alone', async () => {
    const e = env({}, `${OWNER_BASHRC}alias claude-gw-work='something else'\n`);
    const before = e.bashrc();
    const r = await ensureClaudeAccount({ key: 'work' }, e.deps);
    expect(r.aliasConflict).toBe(true);
    expect(r.aliasAdded).toBe(false);
    expect(e.bashrc()).toBe(before);
    expect(existsSync(join(e.home, '.claude-gw-work'))).toBe(true);
  });

  it('refuses folders in the runner data dir, in ~/.claude, or outside the home', async () => {
    const e = env();
    for (const dir of [join(e.root, 'x'), '~/.claude', '~/.claude/sub', '/etc/claude-x', '~']) {
      const r = await ensureClaudeAccount({ key: 'work', configDir: dir }, e.deps);
      expect(r.state, dir).toBe('failed');
      expect(r.detail, dir).toMatch(/refused/);
    }
    expect(existsSync(join(e.root, 'x'))).toBe(false);
    expect(loadConfig(e.configPath).runtimes['claude-code'].accounts).toEqual([]);
  });

  it('a non-primary pairing answers needs_owner with the exact commands and writes nothing', async () => {
    const e = env({ machineScopeAllowed: false });
    const before = e.bashrc();
    const r = await ensureClaudeAccount({ key: 'work' }, e.deps);
    expect(r.state).toBe('needs_owner');
    expect(r.detail).toContain('aom-runner accounts add work');
    expect(r.detail).toContain('aom-runner accounts login work');
    expect(existsSync(join(e.home, '.claude-gw-work'))).toBe(false);
    expect(e.bashrc()).toBe(before);
    expect(loadConfig(e.configPath).runtimes['claude-code'].accounts).toEqual([]);
  });

  it('on Windows no alias is written', async () => {
    const e = env({ platform: 'win32' });
    const before = e.bashrc();
    const r = await ensureClaudeAccount({ key: 'work' }, e.deps);
    expect(r.aliasAdded).toBe(false);
    expect(e.bashrc()).toBe(before);
  });
});
