import { describe, expect, it } from 'vitest';
import {
  backendDetail,
  choiceKeyUse,
  costUsdMicros,
  findModelOption,
  GEMINI_RUNTIME,
  isCostUnknown,
  isKnownChoice,
  modelChoicesFor,
  OPENCODE_RUNTIME,
  providerOfChoice,
  runtimeRoleProblem,
  splitBackendModel,
  validateBackendFields,
} from '../src/index.ts';

const perms = (over = {}) => ({
  allowedTools: ['read', 'edit', 'shell'],
  writableGlobs: null as string[] | null,
  browser: false,
  ...over,
});

describe('runtimeRoleProblem: the rule every harness runtime shares', () => {
  it('gives Codex the same answers as before', () => {
    expect(runtimeRoleProblem('codex', { roleKey: 'builder', permissions: perms() })).toBeNull();
    expect(
      runtimeRoleProblem('codex', { roleKey: 'analyst', permissions: perms({ allowedTools: ['read'] }) }),
    ).toMatch(/no shell/);
  });

  for (const runtime of [GEMINI_RUNTIME, OPENCODE_RUNTIME]) {
    it(`${runtime}: builder and reviewer run, DevOps/CEO/browser/path-limited writers do not`, () => {
      expect(runtimeRoleProblem(runtime, { roleKey: 'builder', permissions: perms() })).toBeNull();
      expect(
        runtimeRoleProblem(runtime, {
          roleKey: 'reviewer',
          permissions: perms({ allowedTools: ['read', 'shell'] }),
        }),
      ).toBeNull();
      expect(runtimeRoleProblem(runtime, { roleKey: 'devops', permissions: perms() })).toMatch(/guard/);
      expect(runtimeRoleProblem(runtime, { roleKey: 'ceo', permissions: perms() })).toMatch(/guard/);
      expect(
        runtimeRoleProblem(runtime, { roleKey: 'tester', permissions: perms({ browser: true }) }),
      ).toMatch(/browsers/);
      expect(
        runtimeRoleProblem(runtime, {
          roleKey: 'writer',
          permissions: perms({ writableGlobs: ['docs/**'] }),
        }),
      ).toMatch(/certain paths/);
    });
    it(`${runtime}: a shell-less role runs, with a shell that only runs aom`, () => {
      expect(
        runtimeRoleProblem(runtime, { roleKey: 'analyst', permissions: perms({ allowedTools: ['read'] }) }),
      ).toBeNull();
    });
  }

  it('does not judge Claude Code or the mock', () => {
    expect(
      runtimeRoleProblem('claude-code', { roleKey: 'devops', isDevops: true, permissions: perms() }),
    ).toBeNull();
    expect(runtimeRoleProblem('mock', { roleKey: 'x', permissions: perms() })).toBeNull();
  });
});

describe('Claude Code backends', () => {
  it('names the backend in the model id and keeps colons of the model', () => {
    expect(splitBackendModel('bedrock:us.anthropic.claude-haiku-4-5-20251001-v1:0')).toEqual({
      backend: 'bedrock',
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    });
    expect(splitBackendModel('vertex:claude-haiku-4-5@20251001')?.backend).toBe('vertex');
    expect(splitBackendModel('gateway:gemini/gemini-2.5-pro')?.model).toBe('gemini/gemini-2.5-pro');
    expect(splitBackendModel('sonnet')).toBeNull();
    expect(splitBackendModel('openai:gpt-5')).toBeNull();
    expect(splitBackendModel('bedrock:')).toBeNull();
  });

  it('validates the fields of each credential', () => {
    expect(validateBackendFields('bedrock', { region: 'us-east-1', bearerToken: 'k' })).toBeNull();
    expect(
      validateBackendFields('bedrock', { region: 'eu-west-1', accessKeyId: 'a', secretAccessKey: 'b' }),
    ).toBeNull();
    expect(validateBackendFields('bedrock', { region: 'nowhere', bearerToken: 'k' })).toMatch(/region/);
    expect(validateBackendFields('bedrock', { region: 'us-east-1' })).toMatch(/API key/);
    expect(validateBackendFields('bedrock', { region: 'us-east-1', accessKeyId: 'a' })).toMatch(/both/);
    expect(
      validateBackendFields('bedrock', {
        region: 'us-east-1',
        bearerToken: 'k',
        accessKeyId: 'a',
        secretAccessKey: 'b',
      }),
    ).toMatch(/not both/);
    const sa = JSON.stringify({ type: 'service_account', private_key: 'x' });
    expect(validateBackendFields('vertex', { projectId: 'my-project-1', serviceAccountJson: sa })).toBeNull();
    expect(validateBackendFields('vertex', { projectId: 'my-project-1', serviceAccountJson: '{}' })).toMatch(
      /service account/,
    );
    expect(validateBackendFields('gateway', { baseUrl: 'https://litellm.example.com' })).toBeNull();
    expect(validateBackendFields('gateway', { baseUrl: 'ftp://x' })).toMatch(/http/);
    expect(validateBackendFields('gateway', { baseUrl: 'https://u:p@x.example' })).toMatch(/user name/);
    expect(validateBackendFields('gateway', { baseUrl: 'https://x.example', authStyle: 'basic' })).toMatch(
      /bearer/,
    );
    expect(backendDetail('gateway', { baseUrl: 'https://litellm.example.com/v1' })).toBe(
      'litellm.example.com',
    );
    expect(backendDetail('vertex', { projectId: 'p1' })).toBe('p1 / global');
  });

  it('lists a group per reported backend, with the warning for a gateway', () => {
    const groups = modelChoicesFor(['claude-code'], [], {
      backends: [
        {
          id: 'bedrock',
          label: 'Amazon Bedrock',
          models: [{ id: 'us.anthropic.claude-sonnet-4-6', label: 'Sonnet 4.6', tier: 'medium' }],
        },
        {
          id: 'gateway',
          label: 'Gateway',
          models: [{ id: 'gemini/gemini-2.5-pro', label: 'gemini-2.5-pro' }],
        },
      ],
    });
    expect(groups.map((g) => [g.runtime, g.provider ?? ''])).toEqual([
      ['claude-code', ''],
      ['claude-code', 'bedrock'],
      ['claude-code', 'gateway'],
    ]);
    expect(groups[1]?.models[0]?.id).toBe('bedrock:us.anthropic.claude-sonnet-4-6');
    expect(groups[1]?.warning).toBeUndefined();
    expect(groups[2]?.warning).toMatch(/less reliably/);
  });

  it('accepts a backend model only on a workstation that has the credential', () => {
    const extras = { backends: [{ id: 'bedrock' as const, label: 'Bedrock', models: [] }] };
    expect(isKnownChoice({ runtime: 'claude-code', model: 'bedrock:us.anthropic.claude-opus-5-5' })).toBe(
      true,
    );
    expect(isKnownChoice({ runtime: 'claude-code', model: 'bedrock:x' }, undefined, extras)).toBe(true);
    expect(isKnownChoice({ runtime: 'claude-code', model: 'vertex:x' }, undefined, extras)).toBe(false);
    expect(isKnownChoice({ runtime: 'claude-code', model: 'sonnet' }, undefined, extras)).toBe(true);
    expect(findModelOption({ runtime: 'claude-code', model: 'gateway:foo/bar' })?.label).toBe('foo/bar');
  });
});

describe('Gemini CLI and opencode choices', () => {
  it('offers the Gemini built-ins plus what the workstation added', () => {
    const g = modelChoicesFor([GEMINI_RUNTIME], [], {
      models: { gemini: [{ id: 'gemini-9-custom', label: 'Custom' }] },
    }).find((x) => x.runtime === GEMINI_RUNTIME);
    expect(g?.label).toBe('Gemini CLI');
    expect(g?.models.map((m) => m.id)).toContain('gemini-2.5-pro');
    expect(g?.models.map((m) => m.id)).toContain('gemini-9-custom');
    expect(isKnownChoice({ runtime: 'gemini', model: 'gemini-2.5-pro' })).toBe(true);
    expect(isKnownChoice({ runtime: 'gemini', model: 'gemini-9-custom' })).toBe(false);
    expect(
      isKnownChoice({ runtime: 'gemini', model: 'gemini-9-custom' }, undefined, {
        models: { gemini: [{ id: 'gemini-9-custom', label: 'Custom' }] },
      }),
    ).toBe(true);
  });

  it('opencode has only the models its workstation reports', () => {
    expect(modelChoicesFor(['opencode']).length).toBe(0);
    const extras = { models: { opencode: [{ id: 'openai/gpt-5', label: 'gpt-5' }] } };
    const g = modelChoicesFor(['opencode'], [], extras);
    expect(g.map((x) => x.runtime)).toEqual(['opencode']);
    expect(isKnownChoice({ runtime: 'opencode', model: 'openai/gpt-5' }, undefined, extras)).toBe(true);
    expect(isKnownChoice({ runtime: 'opencode', model: 'openai/gpt-4' }, undefined, extras)).toBe(false);
    expect(isKnownChoice({ runtime: 'opencode', model: 'gpt-5' })).toBe(false);
  });
});

describe('which key a choice spends', () => {
  it('maps a choice to a provider key id', () => {
    expect(providerOfChoice('claude-code', 'sonnet')).toBeNull();
    expect(providerOfChoice('claude-code', 'bedrock:x')).toBe('bedrock');
    expect(providerOfChoice('direct-model', 'openai:gpt-5')).toBe('openai');
    expect(providerOfChoice('opencode', 'google/gemini-2.5-pro')).toBe('google');
    expect(providerOfChoice('opencode', 'ollama/llama')).toBeNull();
    expect(providerOfChoice('gemini', 'gemini-2.5-pro')).toBe('google');
    expect(providerOfChoice('codex', 'gpt-6-luna')).toBeNull();
  });

  it('reads the reported key; Gemini spends the google key only in key mode', () => {
    const keys = [{ provider: 'google' as const, source: 'org' as const }];
    const reports = [
      { id: 'direct-model', keys },
      { id: 'gemini', authVia: 'login' as const },
    ];
    expect(choiceKeyUse(reports, { runtime: 'gemini', model: 'gemini-2.5-pro' })).toBeNull();
    expect(
      choiceKeyUse([reports[0] as (typeof reports)[0], { id: 'gemini', authVia: 'key' }], {
        runtime: 'gemini',
        model: 'gemini-2.5-pro',
      }),
    ).toEqual({ provider: 'google', source: 'org' });
    expect(choiceKeyUse(reports, { runtime: 'direct-model', model: 'google:gemini-2.5-pro' })).toEqual({
      provider: 'google',
      source: 'org',
    });
    expect(choiceKeyUse(reports, { runtime: 'direct-model', model: 'openai:gpt-5' })).toBeNull();
  });
});

describe('resolution order of provider keys: workstation key, then the organization’s own key, then none', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const reports = (key: object) => [{ id: 'direct-model', keys: [key] }] as never;
  it('a workstation key is in effect whatever organization asks, and is not the organization’s', () => {
    const r = reports({ provider: 'openai', source: 'workstation', orgKey: true, orgIds: [A] });
    expect(choiceKeyUse(r, { runtime: 'direct-model', model: 'openai:gpt-5' }, A)).toEqual({
      provider: 'openai',
      source: 'workstation',
    });
    expect(choiceKeyUse(r, { runtime: 'direct-model', model: 'openai:gpt-5' }, B)).toEqual({
      provider: 'openai',
      source: 'workstation',
    });
  });
  it('an organization key counts only for its own organization', () => {
    const r = reports({ provider: 'openai', source: 'org', orgKey: true, orgIds: [A] });
    expect(choiceKeyUse(r, { runtime: 'direct-model', model: 'openai:gpt-5' }, A)).toEqual({
      provider: 'openai',
      source: 'org',
    });
    expect(choiceKeyUse(r, { runtime: 'direct-model', model: 'openai:gpt-5' }, B)).toBeNull();
    // an older runner reports no organizations: the key is taken as the one there is
    expect(
      choiceKeyUse(
        reports({ provider: 'openai', source: 'org' }),
        { runtime: 'direct-model', model: 'openai:gpt-5' },
        B,
      ),
    ).toEqual({ provider: 'openai', source: 'org' });
  });
  it('a provider with no key at all is none, and a Claude Code backend resolves like any other key', () => {
    expect(
      choiceKeyUse(
        reports({ provider: 'openai', source: 'workstation' }),
        { runtime: 'direct-model', model: 'google:gemini-2.5-pro' },
        A,
      ),
    ).toBeNull();
    const r = reports({ provider: 'bedrock', source: 'org', orgIds: [A] });
    expect(
      choiceKeyUse(r, { runtime: 'claude-code', model: 'bedrock:us.anthropic.claude-sonnet-4-6' }, A),
    ).toEqual({ provider: 'bedrock', source: 'org' });
    expect(choiceKeyUse(r, { runtime: 'claude-code', model: 'sonnet' }, A)).toBeNull();
  });
});

describe('cost of the harness runtimes', () => {
  const t = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  it('prices Gemini 2.5 from Google list prices and the newer ones as unknown', () => {
    expect(isCostUnknown('gemini:gemini-2.5-pro')).toBe(false);
    expect(costUsdMicros('gemini:gemini-2.5-pro', t)).toBe(11_250_000);
    expect(isCostUnknown('gemini:gemini-3.1-pro-preview')).toBe(true);
    expect(costUsdMicros('gemini:gemini-3.1-pro-preview', t)).toBe(0);
  });
  it('prices opencode by its provider and flags the rest', () => {
    expect(isCostUnknown('opencode:openai/gpt-5')).toBe(false);
    expect(costUsdMicros('opencode:openai/gpt-5', t)).toBe(11_250_000);
    expect(isCostUnknown('opencode:anthropic/claude-sonnet-5-5')).toBe(false);
    expect(isCostUnknown('opencode:ollama/llama3')).toBe(true);
    expect(isCostUnknown('opencode:openai-compatible/foo')).toBe(true);
  });
  it('prices Claude behind a gateway like Claude and any other model as unknown', () => {
    expect(isCostUnknown('gateway:anthropic/claude-sonnet-4-5')).toBe(false);
    expect(costUsdMicros('gateway:anthropic/claude-sonnet-4-5', t)).toBeGreaterThan(0);
    expect(isCostUnknown('gateway:gemini/gemini-2.5-pro')).toBe(true);
    expect(costUsdMicros('gateway:gemini/gemini-2.5-pro', t)).toBe(0);
  });
});
