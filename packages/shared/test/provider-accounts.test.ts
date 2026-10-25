import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_SCOPES,
  accountScopeOf,
  buildAiRuntimeTiles,
  CLAUDE_MAIN_SWAP_CAPABILITY,
  CommandPayloadSchemas,
  checkIntegrationRequest,
  choiceKeyUse,
  INTEGRATION_KINDS,
  integrationKind,
  isKeyScope,
  isLoginScope,
  isReservedAccountName,
  keyAccountSource,
  keyAccountUsable,
  ORG_ACCOUNT,
  PROVIDER_ACCOUNTS_CAPABILITY,
  ProjectDtoSchema,
  ProviderAccountKeySchema,
  RunnerCommandNameSchema,
  RuntimeInfoSchema,
  resolveScopeAccount,
  validIntegrationInstance,
} from '../src/index.ts';

const now = new Date('2026-01-01T12:00:00Z');
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const reportWith = (keys: Array<Record<string, unknown>>) => [{ id: 'direct-model', keys }] as never;

describe('which account scope a shift spends', () => {
  it.each([
    ['claude-code', 'sonnet', 'claude-code'],
    ['claude-code', 'bedrock:eu.anthropic.claude-sonnet', 'bedrock'],
    ['claude-code', 'vertex:claude-sonnet-4', 'vertex'],
    ['claude-code', 'gateway:gemini/gemini-2.5-pro', 'gateway'],
    ['codex', 'gpt-6-sol', 'codex'],
    ['gemini', 'gemini-2.5-pro', 'gemini'],
    ['opencode', 'openai/gpt-5', 'openai'],
    ['opencode', 'anthropic/claude-sonnet', 'anthropic'],
    ['opencode', 'google/gemini-2.5-pro', 'google'],
    ['opencode', 'ollama/llama', null],
    ['mock', 'x', null],
  ])('%s %s -> %s', (runtime, model, scope) => {
    expect(accountScopeOf(runtime, model)).toBe(scope);
  });

  it('the Gemini CLI is a key scope only when the workstation runs it on the key', () => {
    expect(accountScopeOf('gemini', 'gemini-2.5-pro', 'login')).toBe('gemini');
    expect(accountScopeOf('gemini', 'gemini-2.5-pro', 'key')).toBe('google');
  });

  it('three login scopes and seven key scopes; Claude Code stays a login scope', () => {
    expect(ACCOUNT_SCOPES.filter((s) => s.kind === 'login').map((s) => s.id)).toEqual([
      'claude-code',
      'codex',
      'gemini',
    ]);
    expect(ACCOUNT_SCOPES.filter((s) => s.kind === 'key')).toHaveLength(7);
    expect(isLoginScope('codex')).toBe(true);
    expect(isKeyScope('codex')).toBe(false);
    expect(isKeyScope('bedrock')).toBe(true);
  });

  it('account names: not main, not org', () => {
    for (const ok of ['work', 'a', 'my-team-2'])
      expect(ProviderAccountKeySchema.safeParse(ok).success).toBe(true);
    for (const bad of ['main', 'org', 'Work', '1x', '', 'a'.repeat(33), 'a_b'])
      expect(ProviderAccountKeySchema.safeParse(bad).success).toBe(false);
  });
});

describe('key accounts on a workstation', () => {
  const keys = reportWith([
    { provider: 'openai', source: 'workstation', orgKey: true, orgIds: [ORG], accounts: ['work'] },
    { provider: 'anthropic', source: 'org', orgKey: true, orgIds: [ORG] },
    { provider: 'google', source: 'workstation', main: false, accounts: ['work', 'alt'] },
  ]);

  it('main: the workstation’s own key, or the organization’s of this organization; a named account only by name; `org` only with the organization’s key', () => {
    expect(keyAccountUsable(keys, 'openai', 'main', ORG)).toBe(true);
    expect(keyAccountUsable(keys, 'openai', 'work', ORG)).toBe(true);
    expect(keyAccountUsable(keys, 'openai', 'ghost', ORG)).toBe(false);
    expect(keyAccountUsable(keys, 'openai', ORG_ACCOUNT, ORG)).toBe(true);
    expect(keyAccountUsable(keys, 'openai', ORG_ACCOUNT, OTHER)).toBe(false);
    expect(keyAccountUsable(keys, 'openai', ORG_ACCOUNT, undefined)).toBe(false);
    // an organization key in effect is only this organization's
    expect(keyAccountUsable(keys, 'anthropic', 'main', ORG)).toBe(true);
    expect(keyAccountUsable(keys, 'anthropic', 'main', OTHER)).toBe(false);
    expect(keyAccountUsable(keys, 'anthropic', 'work', ORG)).toBe(false);
    // only named accounts here: there is no main key
    expect(keyAccountUsable(keys, 'google', 'main', ORG)).toBe(false);
    expect(keyAccountUsable(keys, 'google', 'alt', ORG)).toBe(true);
    // nothing stored for the provider
    expect(keyAccountUsable(keys, 'bedrock', 'main', ORG)).toBe(false);
  });

  it('an older runner reports no key facts: main is trusted as it always was, named accounts do not exist', () => {
    for (const reports of [undefined, [], [{ id: 'direct-model' }]] as never[]) {
      expect(keyAccountUsable(reports, 'openai', 'main', ORG)).toBe(true);
      expect(keyAccountUsable(reports, 'openai', 'work', ORG)).toBe(false);
    }
  });

  it('says which key a run spends (the cap counts only the organization’s)', () => {
    expect(keyAccountSource(keys, 'openai', 'main')).toBe('workstation');
    expect(keyAccountSource(keys, 'openai', 'work')).toBe('workstation');
    expect(keyAccountSource(keys, 'openai', ORG_ACCOUNT)).toBe('org');
    expect(keyAccountSource(keys, 'anthropic', 'main')).toBe('org');
    expect(keyAccountSource(keys, 'google', 'main')).toBeNull();
    expect(keyAccountSource(keys, 'openai', 'ghost')).toBeNull();
  });

  it('a workstation with only named accounts has no key for a run on main (no cap, no key use)', () => {
    expect(choiceKeyUse(keys, { runtime: 'opencode', model: 'google/gemini-2.5-pro' }, ORG)).toBeNull();
    expect(choiceKeyUse(keys, { runtime: 'opencode', model: 'anthropic/claude-sonnet' }, ORG)).toEqual({
      provider: 'anthropic',
      source: 'org',
    });
  });
});

describe('the account a shift runs on (key scopes)', () => {
  const keys = reportWith([
    { provider: 'openai', source: 'workstation', orgKey: true, orgIds: [ORG], accounts: ['work'] },
  ]);
  const pick = (setting: Parameters<typeof resolveScopeAccount>[1], ws = { reports: keys }) =>
    resolveScopeAccount('openai', setting, ws, ORG, now);

  it('no setting: main', () => expect(pick(null)).toEqual({ key: 'main', viaFallback: false }));
  it('the project’s named account', () =>
    expect(pick({ accountKey: 'work', fallbackToMain: false })).toEqual({ key: 'work', viaFallback: false }));
  it('the organization’s key as an account', () =>
    expect(pick({ accountKey: 'org', fallbackToMain: false })).toEqual({ key: 'org', viaFallback: false }));
  it('a missing account pauses, or falls back to main when the project allows', () => {
    expect(pick({ accountKey: 'ghost', fallbackToMain: false })).toBeNull();
    expect(pick({ accountKey: 'ghost', fallbackToMain: true })).toEqual({ key: 'main', viaFallback: true });
  });
  it('main missing and no account: pauses', () => {
    const none = reportWith([{ provider: 'anthropic', source: 'workstation' }]);
    expect(pick(null, { reports: none })).toBeNull();
  });
  it('login scopes read the runtime’s accounts, as Claude’s do', () => {
    const login = {
      available: true,
      accounts: [
        { key: 'main', main: true, source: 'config_dir', login: 'ok', usage: 'ok' },
        { key: 'work', main: false, source: 'config_dir', login: 'expired', usage: 'ok' },
      ],
    } as never;
    expect(
      resolveScopeAccount('codex', { accountKey: 'work', fallbackToMain: true }, { login }, ORG, now),
    ).toEqual({ key: 'main', viaFallback: true });
    expect(
      resolveScopeAccount('codex', { accountKey: 'work', fallbackToMain: false }, { login }, ORG, now),
    ).toBeNull();
  });
});

describe('the tiles of Integrations > AI runtime', () => {
  const info = (key: string, login: 'ok' | 'expired' | 'none', extra: object = {}) => ({
    key,
    main: key === 'main',
    source: 'config_dir' as const,
    login,
    usage: 'ok' as const,
    ...extra,
  });
  const runtimes = [
    {
      id: 'claude-code',
      version: '2.1.0',
      available: true,
      accounts: [info('main', 'ok', { email: 'me@x.test' })],
    },
    {
      id: 'codex',
      version: '0.163.0',
      available: true,
      accounts: [info('main', 'ok'), info('work', 'none')],
    },
    {
      id: 'direct-model',
      version: '1',
      available: true,
      keys: [
        { provider: 'openai', source: 'workstation', orgKey: true, orgIds: [ORG], accounts: ['work'] },
        { provider: 'anthropic', source: 'org', orgKey: true, orgIds: [ORG] },
      ],
    },
  ] as never;
  const caps = ['claude-accounts:1', PROVIDER_ACCOUNTS_CAPABILITY];

  it('offers Make main for a Claude folder account only on a runner that can swap, never for a token account', () => {
    const rts = [
      {
        id: 'claude-code',
        available: true,
        accounts: [info('main', 'ok'), info('work', 'ok'), info('tok', 'ok', { source: 'token' as const })],
      },
    ] as never;
    const claude = (capabilities: string[]) =>
      buildAiRuntimeTiles({ runtimes: rts, capabilities })
        .find((t) => t.id === 'claude-code')
        ?.accounts.map((a) => [a.key, a.canPromote]);
    expect(claude(caps)).toEqual([
      ['main', false],
      ['work', false],
      ['tok', false],
    ]);
    expect(claude([...caps, CLAUDE_MAIN_SWAP_CAPABILITY])).toEqual([
      ['main', false],
      ['work', true],
      ['tok', false],
    ]);
  });

  it('lists the login runtimes, opencode, and the providers, each with its accounts and status', () => {
    const tiles = buildAiRuntimeTiles({ runtimes, capabilities: caps });
    expect(tiles.map((t) => t.id)).toEqual([
      'claude-code',
      'codex',
      'gemini',
      'opencode',
      'anthropic',
      'openai',
      'google',
      'openai-compatible',
      'bedrock',
      'vertex',
      'gateway',
    ]);
    const codex = tiles.find((t) => t.id === 'codex');
    expect(codex).toMatchObject({
      installed: true,
      version: '0.163.0',
      runnerTooOld: false,
      integrationKind: 'codex',
    });
    expect(codex?.accounts.map((a) => [a.key, a.state, a.canPromote])).toEqual([
      ['main', 'ok', false],
      ['work', 'none', true],
    ]);
    const claude = tiles.find((t) => t.id === 'claude-code');
    expect(claude?.accounts[0]).toMatchObject({ email: 'me@x.test' });
    expect(claude?.accounts.every((a) => !a.canPromote)).toBe(true);
    const openai = tiles.find((t) => t.id === 'openai');
    expect(openai).toMatchObject({ keyInEffect: 'workstation', installed: null });
    expect(openai?.accounts.map((a) => [a.key, a.state, a.source, a.orgKey ?? false, a.canPromote])).toEqual([
      ['main', 'ok', 'workstation', true, false],
      ['work', 'ok', 'workstation', false, true],
    ]);
    const anthropic = tiles.find((t) => t.id === 'anthropic');
    expect(anthropic).toMatchObject({ keyInEffect: 'org' });
    expect(anthropic?.accounts).toMatchObject([{ key: 'main', state: 'ok', source: 'org' }]);
    expect(tiles.find((t) => t.id === 'google')).toMatchObject({
      keyInEffect: 'none',
      accounts: [{ key: 'main', state: 'none' }],
    });
  });

  it('a program that is not installed says so, with its install hint and the restart note', () => {
    const tiles = buildAiRuntimeTiles({ runtimes: [], capabilities: caps });
    expect(tiles.find((t) => t.id === 'codex')).toMatchObject({
      installed: false,
      installHint: 'npm install -g @openai/codex',
      note: expect.stringContaining('restart the runner'),
    });
    expect(tiles.find((t) => t.id === 'gemini')).toMatchObject({
      installed: false,
      installHint: expect.stringContaining('gemini-cli'),
    });
    expect(tiles.find((t) => t.id === 'opencode')).toMatchObject({
      installed: false,
      installHint: expect.stringContaining('opencode'),
    });
  });

  it('a runner without provider-accounts:1 is "too old" for everything but Claude Code, which has had accounts since 0.1.33', () => {
    const old = buildAiRuntimeTiles({ runtimes, capabilities: ['claude-accounts:1'] });
    expect(old.find((t) => t.id === 'claude-code')?.runnerTooOld).toBe(false);
    expect(old.find((t) => t.id === 'codex')?.runnerTooOld).toBe(true);
    expect(old.find((t) => t.id === 'openai')?.runnerTooOld).toBe(true);
    const older = buildAiRuntimeTiles({ runtimes, capabilities: [] });
    expect(older.find((t) => t.id === 'claude-code')?.runnerTooOld).toBe(true);
  });

  it('a runner that reports no accounts[] for a login runtime shows its top-level login as the main account', () => {
    const tiles = buildAiRuntimeTiles({
      runtimes: [{ id: 'codex', version: '0.1', available: true, auth: 'expired' }] as never,
      capabilities: [],
    });
    expect(tiles.find((t) => t.id === 'codex')?.accounts).toMatchObject([{ key: 'main', state: 'expired' }]);
  });
});

describe('the contract', () => {
  it('Codex and Gemini are integration kinds in the AI group, with account instances and a sign-in method', () => {
    for (const id of ['codex', 'gemini'] as const) {
      const kind = integrationKind(id);
      expect(kind).toMatchObject({
        group: 'ai',
        minRunnerForInstance: '0.1.58',
        instances: { by: 'account' },
      });
      expect(validIntegrationInstance(kind as never, '')).toBe(true);
      expect(validIntegrationInstance(kind as never, 'work')).toBe(true);
      expect(validIntegrationInstance(kind as never, 'Not Valid')).toBe(false);
    }
    expect(checkIntegrationRequest('codex', 'work', 'codex_login', 'interactive')).toBeNull();
    // the main account can be signed in too (unlike Claude's named-only login)
    expect(checkIntegrationRequest('codex', '', 'codex_login', 'interactive')).toBeNull();
    expect(checkIntegrationRequest('gemini', '', 'gemini_login', 'interactive')).toBeNull();
    expect(checkIntegrationRequest('gemini', 'work', 'codex_login', 'interactive')).toBe('unknown method');
    expect(INTEGRATION_KINDS.filter((k) => k.group === 'ai').map((k) => k.id)).toEqual([
      'claude-code',
      'codex',
      'gemini',
    ]);
  });

  it('the new command and capability exist', () => {
    expect(RunnerCommandNameSchema.options).toContain('provider.account.promote');
    expect(CommandPayloadSchemas['provider.account.promote'].parse({ scope: 'openai', key: 'work' })).toEqual(
      { scope: 'openai', key: 'work' },
    );
    expect(() =>
      CommandPayloadSchemas['provider.account.promote'].parse({ scope: 'openai', key: 'main' }),
    ).toThrow();
    expect(() =>
      CommandPayloadSchemas['provider.account.promote'].parse({ scope: 'nope', key: 'work' }),
    ).toThrow();
    expect(PROVIDER_ACCOUNTS_CAPABILITY).toBe('provider-accounts:1');
  });

  it('a runtime report carries accounts for any runtime, and key facts carry account names', () => {
    const r = RuntimeInfoSchema.parse({
      id: 'codex',
      version: '1',
      available: true,
      capabilities: [],
      accounts: [{ key: 'main', main: true, source: 'config_dir', login: 'ok', usage: 'ok' }],
    });
    expect(r.accounts).toHaveLength(1);
    const k = RuntimeInfoSchema.parse({
      id: 'direct-model',
      version: '1',
      available: true,
      capabilities: [],
      keys: [{ provider: 'openai', source: 'workstation', accounts: ['work'], main: false }],
    });
    expect(k.keys?.[0]).toMatchObject({ accounts: ['work'], main: false });
  });

  it('the project DTO carries the choice per scope', () => {
    const shape = ProjectDtoSchema.shape.providerAccounts;
    expect(
      shape.parse({
        codex: { key: 'work', fallbackToMain: true },
        openai: { key: 'org', fallbackToMain: false },
      }),
    ).toBeTruthy();
  });

  it('reserves the names every object has as an account name', () => {
    for (const k of ['constructor', 'prototype', '__proto__']) expect(isReservedAccountName(k)).toBe(true);
    expect(ProviderAccountKeySchema.safeParse('constructor').success).toBe(false);
    expect(ProviderAccountKeySchema.safeParse('prototype').success).toBe(false);
    expect(ProviderAccountKeySchema.safeParse('work').success).toBe(true);
  });
});
