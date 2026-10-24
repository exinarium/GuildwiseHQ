import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES, type ProviderKeyId, sealLarge } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  backendOfModel,
  backendProcessEnv,
  backendRoleProblem,
  stampBackendUsage,
  sweepVertexKeys,
  writeVertexKey,
} from '../src/adapters/claude-backend.ts';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import type { RuntimeEvent } from '../src/adapters/types.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { ProviderStore } from '../src/direct/store.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox } from '../src/sandbox/sandbox.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { redact } from '../src/secrets/redact.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { sealOrg, sealWs } from './seal-helpers.ts';

cleanupTmp();
const builder = BUILTIN_ROLES.find((r) => r.key === 'builder') as (typeof BUILTIN_ROLES)[number];
if (!builder) throw new Error('role');
const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const ORG = '11111111-1111-4111-8111-111111111111';
const ORG2 = '22222222-2222-4222-8222-222222222222';

function makeStore() {
  const root = tmp('aom-backends-');
  const keys = new RunnerKeys(join(root, 'secrets', 'runner-key.pem'));
  const store = new ProviderStore({ file: join(root, 'secrets', 'providers.json'), keys });
  const seal = (fields: Record<string, string>, provider: ProviderKeyId = 'bedrock') =>
    sealWs(keys, provider, JSON.stringify(fields), fields.baseUrl);
  return { root, keys, store, seal };
}

const BEDROCK = {
  region: 'us-east-1',
  accessKeyId: 'AKIAEXAMPLE12345678',
  secretAccessKey: 'wJalrSecretKeyExample/abcdef',
  sessionToken: 'tok-session-example-123',
};
const SA = JSON.stringify({
  type: 'service_account',
  project_id: 'p',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQexample\n-----END PRIVATE KEY-----\n',
  client_email: 'sa@p.iam.gserviceaccount.com',
});

describe('the provider store: two slots, three backends', () => {
  it('stores a Bedrock credential, reports names only, and redacts every secret field', async () => {
    const { store, keys, seal } = makeStore();
    const r = store.set({
      provider: 'bedrock',
      keyId: keys.publicKey.keyId,
      ciphertext: await seal(BEDROCK),
      models: ['eu.anthropic.claude-sonnet-4-6'],
    });
    expect(r).toEqual({ stored: true });
    const report = JSON.stringify(store.reportBackends());
    for (const secret of Object.values(BEDROCK).filter((v) => v !== 'us-east-1'))
      expect(report).not.toContain(secret);
    expect(store.reportBackends()[0]).toMatchObject({
      id: 'bedrock',
      detail: 'us-east-1',
      keySource: 'workstation',
    });
    expect(store.reportBackends()[0]?.models.map((m) => m.id)).toContain('eu.anthropic.claude-sonnet-4-6');
    expect(redact(`oops ${BEDROCK.secretAccessKey} and ${BEDROCK.accessKeyId}`)).toBe('oops *** and ***');
    store.clear('bedrock');
    expect(store.reportBackends()).toEqual([]);
    expect(redact(BEDROCK.secretAccessKey)).toBe(BEDROCK.secretAccessKey);
  });

  it('refuses a credential that does not fit its backend', async () => {
    const { store, keys, seal } = makeStore();
    const bad = await seal({ region: 'nowhere', bearerToken: 'k' });
    expect(
      store.set({ provider: 'bedrock', keyId: keys.publicKey.keyId, ciphertext: bad, models: [] }),
    ).toMatchObject({
      stored: false,
      error: expect.stringMatching(/region/),
    });
    expect(store.set({ provider: 'gateway', keyId: keys.publicKey.keyId, models: [] })).toMatchObject({
      stored: false,
    });
    expect(store.set({ provider: 'bedrock', keyId: 'other', ciphertext: bad, models: [] })).toMatchObject({
      stored: false,
      error: expect.stringMatching(/another runner key/),
    });
  });

  it('puts the workstation key over the organization key, and falls back when it is removed', async () => {
    const { store, keys, seal } = makeStore();
    const rsa = (text: string) => {
      // short keys are plain RSA-OAEP in the browser; sealLarge works for both and the runner opens either
      return sealLarge(keys.publicKey.publicKey, text);
    };
    await store.set({
      provider: 'openai',
      keyId: keys.publicKey.keyId,
      source: 'org',
      orgId: ORG,
      generation: 1,
      ciphertext: await sealOrg(keys, ORG, 'openai', 'sk-org-key-1111'),
      models: [],
    });
    expect(store.get('openai', ORG)).toMatchObject({ apiKey: 'sk-org-key-1111', source: 'org' });
    // another organization's work on this workstation has no key here
    expect(store.get('openai', ORG2)).toBeUndefined();
    expect(store.reportKeys()).toEqual([{ provider: 'openai', source: 'org', orgKey: true, orgIds: [ORG] }]);
    store.set({
      provider: 'openai',
      keyId: keys.publicKey.keyId,
      ciphertext: await rsa('sk-own-key-2222'),
      models: [],
    });
    expect(store.get('openai', ORG)).toMatchObject({ apiKey: 'sk-own-key-2222', source: 'workstation' });
    expect(store.get('openai', ORG2)).toMatchObject({ source: 'workstation' });
    expect(store.report()[0]).toMatchObject({ keySource: 'workstation', orgKey: true });
    // clearing the workstation key brings the organization's back; clearing the organization's removes it everywhere
    store.clearPayload({ provider: 'openai' });
    expect(store.get('openai', ORG)).toMatchObject({ apiKey: 'sk-org-key-1111', source: 'org' });
    store.clearPayload({ provider: 'openai', source: 'org', orgId: ORG });
    expect(store.get('openai')).toBeUndefined();
    expect(redact('sk-org-key-1111 sk-own-key-2222')).toBe('sk-org-key-1111 sk-own-key-2222');
    void seal;
  });

  it('survives a restart: both slots are read and their keys are registered for redaction', async () => {
    const { root, store, keys } = makeStore();
    store.set({
      provider: 'google',
      keyId: keys.publicKey.keyId,
      source: 'org',
      orgId: ORG,
      generation: 1,
      ciphertext: await sealOrg(keys, ORG, 'google', 'AIza-org-secret-9999'),
      models: [],
    });
    const again = new ProviderStore({ file: join(root, 'secrets', 'providers.json'), keys });
    expect(again.get('google', ORG)?.source).toBe('org');
    expect(redact('AIza-org-secret-9999')).toBe('***');
  });
});

describe('the environment of a backend session', () => {
  const cred = (id: 'bedrock' | 'vertex' | 'gateway', fields: Record<string, string>) => ({
    id,
    fields,
    models: [],
    source: 'workstation' as const,
  });

  it('Bedrock: the flag, the region and the access key, every alias pinned, scrubbed subprocesses', () => {
    const env = backendProcessEnv(cred('bedrock', BEDROCK), 'us.anthropic.claude-sonnet-4-6');
    expect(env).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: BEDROCK.accessKeyId,
      AWS_SECRET_ACCESS_KEY: BEDROCK.secretAccessKey,
      AWS_SESSION_TOKEN: BEDROCK.sessionToken,
      ANTHROPIC_MODEL: 'us.anthropic.claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'us.anthropic.claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'us.anthropic.claude-sonnet-4-6',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'us.anthropic.claude-sonnet-4-6',
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    });
    const bearer = backendProcessEnv(
      cred('bedrock', { region: 'eu-west-1', bearerToken: 'br-key-123' }),
      'm',
    );
    expect(bearer.AWS_BEARER_TOKEN_BEDROCK).toBe('br-key-123');
    expect(bearer.AWS_ACCESS_KEY_ID).toBeUndefined();
  });

  it('Vertex: the flag, project, region (global by default) and the key file', () => {
    const env = backendProcessEnv(
      cred('vertex', { projectId: 'my-proj-1', serviceAccountJson: SA }),
      'claude-sonnet-4-6',
      {
        vertexKeyFile: '/s/vertex-1.json',
      },
    );
    expect(env).toMatchObject({
      CLAUDE_CODE_USE_VERTEX: '1',
      CLOUD_ML_REGION: 'global',
      ANTHROPIC_VERTEX_PROJECT_ID: 'my-proj-1',
      GOOGLE_APPLICATION_CREDENTIALS: '/s/vertex-1.json',
    });
    expect(JSON.stringify(env)).not.toContain('MIIEvQ');
  });

  it('gateway: base URL and bearer token by default, x-api-key on request, betas off', () => {
    const env = backendProcessEnv(
      cred('gateway', { baseUrl: 'https://litellm.example.com/', authToken: 'gw-key-777' }),
      'gemini/gemini-2.5-pro',
    );
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://litellm.example.com',
      ANTHROPIC_AUTH_TOKEN: 'gw-key-777',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
      ANTHROPIC_MODEL: 'gemini/gemini-2.5-pro',
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    const k = backendProcessEnv(
      cred('gateway', { baseUrl: 'https://g.example.com', authToken: 'k', authStyle: 'x-api-key' }),
      'm',
    );
    expect(k.ANTHROPIC_API_KEY).toBe('k');
    expect(k.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('stamps the key source, prefixes gateway models and drops Claude Code’s own cost for them', () => {
    const u = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: 'gemini/gemini-2.5-pro',
      costUsd: 0.5,
    };
    expect(stampBackendUsage(u, { backend: 'gateway', model: 'm', source: 'org' })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: 'gateway:gemini/gemini-2.5-pro',
      keySource: 'org',
      keyProvider: 'gateway',
    });
    expect(
      stampBackendUsage(
        { ...u, model: undefined },
        { backend: 'bedrock', model: 'us.x', source: 'workstation' },
      ),
    ).toMatchObject({
      model: 'us.x',
      costUsd: 0.5,
      keySource: 'workstation',
    });
  });

  it('knows a backend model and refuses DevOps and the CEO', () => {
    expect(backendOfModel('bedrock:us.anthropic.claude-opus-5-5')?.backend).toBe('bedrock');
    expect(backendOfModel('opus')).toBeNull();
    expect(backendRoleProblem({ roleKey: 'builder' })).toBeNull();
    expect(backendRoleProblem({ roleKey: 'ceo' })).toMatch(/own Claude login/);
    expect(backendRoleProblem({ roleKey: 'x', isDevops: true })).not.toBeNull();
  });
});

describe('Claude Code on a backend, against a fake claude', () => {
  const RESULT = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    session_id: 's1',
    total_cost_usd: 0.4,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { 'gemini/gemini-2.5-pro': { inputTokens: 10, outputTokens: 5 } },
  });

  async function setup(opts: { claudeToken?: boolean } = {}) {
    const t = tmp();
    const rec = join(t, 'rec.json');
    const bin = join(t, 'fakeclaude');
    writeFileSync(
      bin,
      `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('2.1.400 (Claude Code)'); process.exit(0); }
const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
fs.writeFileSync(${JSON.stringify(rec)}, JSON.stringify({ argv: a, env: process.env, keyFile, keyBody: keyFile ? fs.readFileSync(keyFile, 'utf8') : null, creds: fs.existsSync((process.env.CLAUDE_CONFIG_DIR || '') + '/.credentials.json') }));
console.log(${JSON.stringify(RESULT)});
`,
    );
    chmodSync(bin, 0o755);
    const cwd = join(t, 'data', 'worktrees', 'P4-98eeafb0', 'P4-3');
    mkdirSync(cwd, { recursive: true });
    const paths = runnerPaths(join(t, 'data'));
    const sandbox = await ensureSandbox(paths, A, 'Bob');
    const keys = new RunnerKeys(join(paths.secrets, 'runner-key.pem'));
    const store = new ProviderStore({ file: join(paths.secrets, 'providers.json'), keys });
    const cfg = ClaudeRuntimeConfigSchema.parse({
      bin,
      sandbox: 'off',
      ...(opts.claudeToken ? { authMode: 'api_key', apiKey: 'sk-ant-claude-own-key' } : {}),
    });
    const adapter = new ClaudeCodeAdapter(cfg, paths, { providers: store });
    const start = async (model: string, role = builder, extra: object = {}) => {
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
          agent: {
            agentId: A,
            name: 'Bob',
            roleKey: role.key,
            seniority: 'senior',
            runtime: 'claude-code',
            model,
            skills: [],
            permissions: role.permissions,
            isDevops: false,
          },
          ...extra,
        } as never);
        const ev: RuntimeEvent[] = [];
        for await (const e of s.events()) ev.push(e);
        return { ev, usage: s.usage() };
      } finally {
        delete process.env.AOM_CLAUDE_SMOKE;
      }
    };
    return {
      t,
      rec,
      keys,
      store,
      adapter,
      paths,
      sandbox,
      start,
      read: () => JSON.parse(readFileSync(rec, 'utf8')),
    };
  }

  it('runs a gateway agent with the gateway credential and none of the Claude ones, and stamps the usage', async () => {
    const x = await setup({ claudeToken: true });
    x.store.set({
      provider: 'gateway',
      keyId: x.keys.publicKey.keyId,
      source: 'org',
      orgId: ORG,
      generation: 1,
      baseUrl: 'https://litellm.example.com',
      ciphertext: await sealOrg(
        x.keys,
        ORG,
        'gateway',
        JSON.stringify({ baseUrl: 'https://litellm.example.com', authToken: 'gw-secret-token-42' }),
        1,
        'https://litellm.example.com',
      ),
      models: ['gemini/gemini-2.5-pro'],
    });
    const { ev, usage } = await x.start('gateway:gemini/gemini-2.5-pro', builder, { orgId: ORG });
    expect(ev.at(-1)).toMatchObject({ kind: 'exit', code: 0 });
    const r = x.read();
    expect(r.argv[r.argv.indexOf('--model') + 1]).toBe('gemini/gemini-2.5-pro');
    expect(r.env.ANTHROPIC_BASE_URL).toBe('https://litellm.example.com');
    expect(r.env.ANTHROPIC_AUTH_TOKEN).toBe('gw-secret-token-42');
    expect(r.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(r.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(r.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
    expect(r.creds).toBe(false);
    expect(usage).toMatchObject({
      model: 'gateway:gemini/gemini-2.5-pro',
      keySource: 'org',
      keyProvider: 'gateway',
    });
    expect(usage.costUsd).toBeUndefined();
    // the runner's own environment never reaches the agent
    expect(Object.keys(r.env).filter((k) => /^(GH_TOKEN|GITHUB_TOKEN|SSH_AUTH_SOCK)$/.test(k))).toEqual([]);
  });

  it('runs a subscription agent as before: the Claude token, no backend variables', async () => {
    const x = await setup({ claudeToken: true });
    x.store.set({
      provider: 'gateway',
      keyId: x.keys.publicKey.keyId,
      ciphertext: await sealLarge(
        x.keys.publicKey.publicKey,
        JSON.stringify({ baseUrl: 'https://g.example.com' }),
      ),
      models: [],
    });
    await x.start('sonnet');
    const r = x.read();
    expect(r.env.ANTHROPIC_API_KEY).toBe('sk-ant-claude-own-key');
    expect(r.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('writes the Vertex key for the claude process only and removes it afterwards', async () => {
    const x = await setup();
    x.store.set({
      provider: 'vertex',
      keyId: x.keys.publicKey.keyId,
      ciphertext: await sealLarge(
        x.keys.publicKey.publicKey,
        JSON.stringify({ projectId: 'my-proj-1', region: 'us-east5', serviceAccountJson: SA }),
      ),
      models: [],
    });
    await x.start('vertex:claude-sonnet-4-6');
    const r = x.read();
    expect(r.env.CLAUDE_CODE_USE_VERTEX).toBe('1');
    expect(r.env.CLOUD_ML_REGION).toBe('us-east5');
    expect(r.keyBody).toBe(SA);
    expect(r.keyFile.startsWith(x.paths.secrets)).toBe(true);
    expect(existsSync(r.keyFile)).toBe(false);
    expect(readdirSync(x.paths.secrets).filter((f) => f.startsWith('vertex-'))).toEqual([]);
  });

  it('removes the Vertex key when the session fails before the process runs (finding 11)', async () => {
    const x = await setup();
    x.store.set({
      provider: 'vertex',
      keyId: x.keys.publicKey.keyId,
      ciphertext: await sealLarge(
        x.keys.publicKey.publicKey,
        JSON.stringify({ projectId: 'my-proj-1', region: 'us-east5', serviceAccountJson: SA }),
      ),
      models: [],
    });
    // the config folder cannot be made (its parent is a file): everything after the key file was written fails
    const blocker = join(x.t, 'a-file');
    writeFileSync(blocker, 'x');
    const vertexFiles = () => readdirSync(x.paths.secrets).filter((f) => f.startsWith('vertex-'));
    await expect(
      x.start('vertex:claude-sonnet-4-6', builder, {
        sandbox: { ...x.sandbox, configDir: join(blocker, 'config') },
      }),
    ).rejects.toThrow();
    expect(vertexFiles()).toEqual([]);
    // and the chat path
    const chatInput = {
      chatId: 'chat-1',
      cwd: x.t,
      sandbox: { ...x.sandbox, configDir: join(blocker, 'config') },
      agent: {
        agentId: A,
        name: 'Bob',
        roleKey: 'builder',
        seniority: 'senior',
        runtime: 'claude-code',
        model: 'vertex:claude-sonnet-4-6',
        skills: [],
        permissions: builder.permissions,
        isDevops: false,
      },
      env: {},
    };
    await expect(x.adapter.startChat(chatInput as never)).rejects.toThrow();
    expect(vertexFiles()).toEqual([]);
  });

  it('names the Vertex key file at random, exclusively, and sweeps what a crash left (finding 11)', () => {
    const dir = tmp('aom-vertex-');
    const a = writeVertexKey(dir, 'shift-1', '{"a":1}');
    const b = writeVertexKey(dir, 'shift-1', '{"b":2}');
    expect(a).not.toBe(b);
    expect(a).toMatch(/vertex-shift-1-[0-9a-f]{16}\.json$/);
    expect(statSync(a).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, 'providers.json'), '{}');
    expect(sweepVertexKeys(dir)).toBe(2);
    expect(existsSync(a)).toBe(false);
    expect(readdirSync(dir)).toEqual(['providers.json']);
    expect(sweepVertexKeys(join(dir, 'missing'))).toBe(0);
  });

  it('refuses a backend that is not set up, and roles that need the owner’s login', async () => {
    const x = await setup();
    await expect(x.start('bedrock:us.anthropic.claude-sonnet-4-6')).rejects.toThrow(
      /not set up on this workstation/,
    );
    const devops = (BUILTIN_ROLES.find((r) => r.key === 'devops') ?? builder) as typeof builder;
    x.store.set({
      provider: 'gateway',
      keyId: x.keys.publicKey.keyId,
      ciphertext: await sealLarge(
        x.keys.publicKey.publicKey,
        JSON.stringify({ baseUrl: 'https://g.example.com' }),
      ),
      models: [],
    });
    await expect(x.start('gateway:m', { ...devops, key: 'devops' } as never)).rejects.toThrow(
      /runtime_role_refused/,
    );
  });

  it('is available with only a backend credential and reports the backends, not their secrets', async () => {
    const x = await setup();
    const caps = await x.adapter.capabilities().catch(() => undefined);
    void caps;
    process.env.AOM_CLAUDE_SMOKE = '1';
    try {
      x.store.set({
        provider: 'bedrock',
        keyId: x.keys.publicKey.keyId,
        ciphertext: await sealLarge(x.keys.publicKey.publicKey, JSON.stringify(BEDROCK)),
        models: [],
      });
      const c = await x.adapter.capabilities();
      expect(c.backends?.map((b) => b.id)).toEqual(['bedrock']);
      expect(JSON.stringify(c)).not.toContain(BEDROCK.secretAccessKey);
    } finally {
      delete process.env.AOM_CLAUDE_SMOKE;
    }
  });
});
