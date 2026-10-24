import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES, sealProviderKey } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { OpencodeAdapter } from '../src/adapters/opencode.ts';
import type { RuntimeEvent } from '../src/adapters/types.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { ProviderStore } from '../src/direct/store.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox } from '../src/sandbox/sandbox.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { sealOrg, sealWs } from './seal-helpers.ts';

cleanupTmp();
const builder = BUILTIN_ROLES.find((r) => r.key === 'builder') as (typeof BUILTIN_ROLES)[number];
const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const ORG = '11111111-1111-4111-8111-111111111111';
const URL_OWN = 'https://own-gw.example.com';
const URL_WORK = 'https://work-gw.example.com';
const URL_ORG = 'https://org-gw.example.com';
const RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  session_id: 's1',
  usage: { input_tokens: 10, output_tokens: 5 },
});

async function rig() {
  const t = tmp();
  const rec = join(t, 'rec.json');
  const bin = join(t, 'fakeclaude');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('2.1.400 (Claude Code)'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(rec)}, JSON.stringify({ argv: a, env: process.env }));
console.log(${JSON.stringify(RESULT)});
`,
  );
  chmodSync(bin, 0o755);
  const cwd = join(t, 'data', 'worktrees', 'P4-98eeafb0', 'P4-3');
  mkdirSync(cwd, { recursive: true });
  const paths = runnerPaths(join(t, 'data'));
  const keys = new RunnerKeys(join(paths.secrets, 'runner-key.pem'));
  const store = new ProviderStore({ file: join(paths.secrets, 'providers.json'), keys });
  const adapter = new ClaudeCodeAdapter(ClaudeRuntimeConfigSchema.parse({ bin, sandbox: 'off' }), paths, {
    providers: store,
  });
  const gw = (url: string, token: string) => JSON.stringify({ baseUrl: url, authToken: token });
  store.set({
    provider: 'gateway',
    keyId: keys.publicKey.keyId,
    generation: 10,
    baseUrl: URL_OWN,
    ciphertext: await sealWs(keys, 'gateway', gw(URL_OWN, 'own-token-1111'), URL_OWN, 10),
    models: ['m1'],
  });
  store.set({
    provider: 'gateway',
    account: 'work',
    keyId: keys.publicKey.keyId,
    generation: 10,
    baseUrl: URL_WORK,
    ciphertext: await sealProviderKey(keys.publicKey.publicKey, gw(URL_WORK, 'work-token-2222'), {
      scope: 'workstation',
      provider: 'gateway',
      endpoint: URL_WORK,
      generation: 10,
      keyId: keys.publicKey.keyId,
      account: 'work',
    }),
    models: ['m1'],
  });
  store.set({
    provider: 'gateway',
    source: 'org',
    orgId: ORG,
    generation: 1,
    keyId: keys.publicKey.keyId,
    baseUrl: URL_ORG,
    ciphertext: await sealOrg(keys, ORG, 'gateway', gw(URL_ORG, 'org-token-3333'), 1, URL_ORG),
    models: ['m1'],
  });
  const start = async (account?: string) => {
    const sandbox = await ensureSandbox(paths, A, 'Bob', null, account);
    process.env.AOM_CLAUDE_SMOKE = '1';
    try {
      const s = await adapter.start({
        shiftId: 'zz',
        prompt: 'go',
        instructionsMarkdown: '',
        cwd,
        sandbox,
        addDirs: [],
        env: {},
        maxShiftMinutes: 5,
        orgId: ORG,
        ...(account ? { account } : {}),
        agent: {
          agentId: A,
          name: 'Bob',
          roleKey: builder.key,
          seniority: 'senior',
          runtime: 'claude-code',
          model: 'gateway:m1',
          skills: [],
          permissions: builder.permissions,
          isDevops: false,
        },
      } as never);
      const ev: RuntimeEvent[] = [];
      for await (const e of s.events()) ev.push(e);
      return { ev, usage: s.usage() };
    } finally {
      delete process.env.AOM_CLAUDE_SMOKE;
    }
  };
  return { start, read: () => JSON.parse(readFileSync(rec, 'utf8')) as { env: Record<string, string> } };
}

describe('Claude Code on a backend: the project’s account picks the credential (S-A)', () => {
  it('main: the workstation’s own credential; a named account: that account’s; `org`: the organization’s, counted against its cap', async () => {
    const x = await rig();
    const main = await x.start();
    expect(x.read().env.ANTHROPIC_AUTH_TOKEN).toBe('own-token-1111');
    expect(x.read().env.ANTHROPIC_BASE_URL).toBe(URL_OWN);
    expect(main.usage).toMatchObject({ keySource: 'workstation', keyProvider: 'gateway' });
    const work = await x.start('work');
    expect(x.read().env.ANTHROPIC_AUTH_TOKEN).toBe('work-token-2222');
    expect(x.read().env.ANTHROPIC_BASE_URL).toBe(URL_WORK);
    expect(work.usage).toMatchObject({ keySource: 'workstation' });
    expect(work.ev.at(-1)).toMatchObject({ kind: 'exit', code: 0 });
    const org = await x.start('org');
    expect(x.read().env.ANTHROPIC_AUTH_TOKEN).toBe('org-token-3333');
    expect(org.usage).toMatchObject({ keySource: 'org', keyProvider: 'gateway' });
  });

  it('an account this workstation does not have is an error that names it (not a Claude-account error)', async () => {
    const x = await rig();
    await expect(x.start('ghost')).rejects.toThrow(/gateway has no account ghost/);
  });
});

describe('opencode: the project’s account applies to the provider its model names (S-A)', () => {
  it('uses the account’s key for that provider and every other provider’s main key', async () => {
    const t = tmp();
    const paths = runnerPaths(join(t, 'data'));
    const keys = new RunnerKeys(join(paths.secrets, 'runner-key.pem'));
    const store = new ProviderStore({ file: join(paths.secrets, 'providers.json'), keys });
    const put = async (provider: 'openai' | 'anthropic', secret: string, account?: string) =>
      store.set({
        provider,
        ...(account ? { account } : {}),
        keyId: keys.publicKey.keyId,
        generation: 10,
        ciphertext: await sealProviderKey(keys.publicKey.publicKey, secret, {
          scope: 'workstation',
          provider,
          generation: 10,
          keyId: keys.publicKey.keyId,
          ...(account ? { account } : {}),
        }),
        models: [],
      });
    await put('openai', 'sk-main-openai-1');
    await put('openai', 'sk-work-openai-2', 'work');
    await put('anthropic', 'sk-main-anthropic-3');
    const adapter = new OpencodeAdapter(
      { enabled: true, bin: '/nonexistent/opencode', toolchainPaths: [], extraAllowedDomains: [] },
      paths,
      store,
    );
    const keyOf = (list: Array<{ id: string; apiKey?: string }>, id: string) =>
      list.find((p) => p.id === id)?.apiKey;
    const main = adapter.providers(undefined);
    expect(keyOf(main, 'openai')).toBe('sk-main-openai-1');
    const work = adapter.providers(undefined, { provider: 'openai', account: 'work' });
    expect(keyOf(work, 'openai')).toBe('sk-work-openai-2');
    expect(keyOf(work, 'anthropic')).toBe('sk-main-anthropic-3');
    // an account this workstation lacks leaves that provider out: the shift fails clearly instead of spending the main key
    expect(
      keyOf(adapter.providers(undefined, { provider: 'openai', account: 'ghost' }), 'openai'),
    ).toBeUndefined();
  });
});
