import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CommandPayloadSchemas,
  checkIntegrationRequest,
  connectSteps,
  ENVELOPE_COMMANDS,
  HelloSchema,
  INTEGRATION_KIND_IDS,
  INTEGRATION_KINDS,
  IntegrationSessionSchema,
  IntegrationStatusSchema,
  IntegrationsReportSchema,
  integrationAad,
  integrationCli,
  integrationKind,
  integrationScope,
  RUNNER_ACKED_TYPES,
  RunnerToServerSchema,
  SealedEnvelopeSchema,
  sealForRunner,
  validIntegrationInstance,
} from '../src/index.ts';

const envelope = (type: string, extra: Record<string, unknown>) => ({
  v: 1,
  id: 'x1',
  ts: new Date().toISOString(),
  type,
  ...extra,
});

describe('integration registry', () => {
  it('lists every kind once, each with methods', () => {
    const ids = INTEGRATION_KINDS.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...INTEGRATION_KIND_IDS].sort());
    for (const k of INTEGRATION_KINDS) {
      expect(k.methods.length, k.id).toBeGreaterThan(0);
      const methodIds = k.methods.map((m) => m.id);
      expect(new Set(methodIds).size, k.id).toBe(methodIds.length);
      expect(k.minRunner, k.id).toMatch(/^\d+\.\d+\.\d+$/);
      expect(k.storage.length).toBeGreaterThan(5);
    }
  });

  it('fields methods have fields, secret inputs are typed secret, links are https', () => {
    for (const k of INTEGRATION_KINDS) {
      for (const m of k.methods) {
        if (m.flow === 'fields') expect(m.fields?.length, `${k.id}.${m.id}`).toBeGreaterThan(0);
        if (m.flow === 'interactive' && !m.phase) expect(m.paste, `${k.id}.${m.id}`).toBeDefined();
        for (const f of m.fields ?? [])
          if (/token|key|secret|password/i.test(f.key) && f.key !== 'keyId')
            expect(f.type, `${k.id}.${m.id}.${f.key}`).toBe('secret');
        for (const s of m.steps) if (s.link) expect(s.link.href).toMatch(/^https:\/\//);
      }
    }
  });

  it('Bitbucket and Jira carry the field sets the connect forms need', () => {
    const bb = integrationKind('bitbucket-cloud')?.methods[0]?.fields?.map((f) => f.key);
    expect(bb).toEqual(['email', 'token']);
    const jira = integrationKind('jira')?.methods[0]?.fields?.map((f) => f.key);
    expect(jira).toEqual(['baseUrl', 'email', 'token']);
  });

  it('validates instances and requests', () => {
    const jira = integrationKind('jira');
    const gh = integrationKind('github');
    if (!jira || !gh) throw new Error('missing kinds');
    expect(validIntegrationInstance(jira, '')).toBe(true);
    expect(validIntegrationInstance(jira, 'x')).toBe(false);
    expect(validIntegrationInstance(gh, 'github.com')).toBe(true);
    expect(validIntegrationInstance(gh, '')).toBe(false);
    expect(validIntegrationInstance(gh, 'bad host')).toBe(false);
    expect(checkIntegrationRequest('jira', '', 'token', 'fields')).toBeNull();
    expect(checkIntegrationRequest('jira', '', 'token', 'interactive')).toMatch(/not a interactive/);
    expect(checkIntegrationRequest('claude-code', '', 'default_login', 'interactive')).toMatch(
      /not available/,
    );
    expect(checkIntegrationRequest('nope', '', 'token', 'fields')).toMatch(/unknown/);
    expect(checkIntegrationRequest('claude-code', '', 'setup_token', 'interactive')).toBeNull();
    expect(
      checkIntegrationRequest('mcp', 'plugin_atlassian_atlassian', 'oauth_paste', 'interactive'),
    ).toBeNull();
  });

  it('knows where a credential lives', () => {
    const claude = integrationKind('claude-code');
    const gh = integrationKind('github');
    if (!claude || !gh) throw new Error('missing kinds');
    expect(integrationScope(claude, 'setup_token')).toBe('workstation');
    expect(integrationScope(claude, 'default_login')).toBe('machine');
    expect(integrationScope(gh, 'token')).toBe('machine');
    expect(integrationCli(gh, 'github.example.com')).toBe(
      'aom-runner git-connect github --host github.example.com',
    );
  });

  it('keeps connectSteps text for the CLI', () => {
    expect(connectSteps('github')[0]).toContain('Install the GitHub CLI');
  });
});

describe('integration status and protocol', () => {
  it('bounds the status record', () => {
    const ok = IntegrationStatusSchema.safeParse({
      kind: 'jira',
      instance: '',
      state: 'connected',
      checkedAt: new Date().toISOString(),
      scope: 'workstation',
    });
    expect(ok.success).toBe(true);
    expect(IntegrationStatusSchema.safeParse({ ...ok.data, state: 'nonsense' }).success).toBe(false);
    expect(IntegrationStatusSchema.safeParse({ ...ok.data, detail: 'x'.repeat(401) }).success).toBe(false);
  });

  it('accepts the two new runner messages and the hello flag', () => {
    const report = envelope('integrations.report', {
      integrations: [],
      registryVersion: 1,
      policy: { allowWeb: true, primaryPairing: true, machineScopeFromWeb: 'primary' },
    });
    expect(IntegrationsReportSchema.safeParse(report).success).toBe(true);
    const session = envelope('integration.session', {
      sessionId: 's1',
      kind: 'mcp',
      instance: 'plugin_a_b',
      state: 'awaiting_user',
      prompt: { url: 'https://auth.example.com/x', urlHost: 'auth.example.com', inputKind: 'redirect_url' },
    });
    expect(IntegrationSessionSchema.safeParse(session).success).toBe(true);
    expect(RunnerToServerSchema.safeParse(session).success).toBe(true);
    expect(RUNNER_ACKED_TYPES.has('integration.session')).toBe(true);
    expect(HelloSchema.shape.integrationsVersion).toBeDefined();
  });

  it('has payload schemas for the six commands, two of them carry an envelope', () => {
    for (const c of [
      'integration.connect',
      'integration.begin',
      'integration.input',
      'integration.cancel',
      'integration.test',
      'integration.remove',
    ] as const)
      expect(CommandPayloadSchemas[c]).toBeDefined();
    expect([...ENVELOPE_COMMANDS].sort()).toEqual([
      'deploy.secret.set',
      'env.secret.set',
      'integration.connect',
      'integration.input',
    ]);
    expect(CommandPayloadSchemas['integration.begin'].safeParse({}).success).toBe(false);
  });
});

describe('sealing for the runner', () => {
  it('produces a well-formed envelope that holds no plaintext', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const secret = 'SECRET-TOKEN-VALUE-1234567890';
    const env = await sealForRunner({
      publicKey: der.toString('base64'),
      keyId: createHash('sha256').update(der).digest('hex').slice(0, 16),
      workstationId: 'ws1',
      ref: 'req1',
      kind: 'jira',
      instance: '',
      op: 'connect',
      method: 'token',
      fields: { token: secret, email: 'a@b.c' },
      serverTimeMs: Date.now(),
    });
    expect(SealedEnvelopeSchema.safeParse(env).success).toBe(true);
    expect(JSON.stringify(env)).not.toContain(secret);
    expect(JSON.stringify(env)).not.toContain('a@b.c');
  });

  it('refuses fields over 8 KB', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(
      sealForRunner({
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        keyId: 'k',
        workstationId: 'w',
        ref: 'r',
        kind: 'jira',
        instance: '',
        op: 'connect',
        fields: { a: 'x'.repeat(7000), b: 'y'.repeat(7000) },
        serverTimeMs: 0,
      }),
    ).rejects.toThrow(/too large/);
  });

  it('builds a stable AAD', () => {
    expect(integrationAad({ workstationId: 'w', ref: 'r', kind: 'jira', instance: '', op: 'connect' })).toBe(
      'guildwise-integration-v1\nw\nr\njira\n\nconnect',
    );
  });
});
