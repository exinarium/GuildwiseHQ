import { describe, expect, it } from 'vitest';
import {
  APP_ERROR_CODES,
  APP_ERROR_TEXT,
  AppCommandResultSchema,
  AppIdentitySchema,
  appInstance,
  IntegrationStatusSchema,
  integrationKind,
  missingAppPermissions,
  parseAppInstance,
} from '../src/index.ts';

const identity = {
  provider: 'github-app',
  host: 'github.com',
  appId: '4242',
  appSlug: 'guild-bot',
  appName: 'Guild Bot',
  installationId: '777',
  account: 'acme',
  botLogin: 'guild-bot[bot]',
  botUserId: '99001',
  commitName: 'guild-bot[bot]',
  commitEmail: '99001+guild-bot[bot]@users.noreply.github.com',
  permissions: { contents: 'write' },
  missingPermissions: [],
};

describe('automated apps', () => {
  it('identity and command result are strict: a token key is a parse failure', () => {
    expect(AppIdentitySchema.safeParse(identity).success).toBe(true);
    expect(AppIdentitySchema.safeParse({ ...identity, token: 'ghs_x' }).success).toBe(false);
    expect(AppCommandResultSchema.safeParse({ ok: true, identity }).success).toBe(true);
    expect(AppCommandResultSchema.safeParse({ ok: true, privateKey: 'x' }).success).toBe(false);
  });

  it('builds and parses the canonical instance', () => {
    expect(appInstance('4242', '777')).toBe('4242:777');
    expect(parseAppInstance('4242:777')).toEqual({ appId: '4242', installationId: '777' });
    expect(parseAppInstance('Iv23li:777')).toBeNull();
    expect(parseAppInstance('4242')).toBeNull();
  });

  it('names the default permissions the installation does not grant', () => {
    expect(missingAppPermissions({ contents: 'read', pull_requests: 'write', metadata: 'read' })).toEqual([
      'contents',
      'issues',
    ]);
    expect(
      missingAppPermissions({ contents: 'admin', pull_requests: 'write', issues: 'write', metadata: 'read' }),
    ).toEqual([]);
  });

  it('has a sentence for every error code', () => {
    for (const c of APP_ERROR_CODES) expect(APP_ERROR_TEXT[c].length).toBeGreaterThan(10);
  });

  it('registers github-app as a local-only workstation kind and accepts its status fields', () => {
    const k = integrationKind('github-app');
    expect(k?.scope).toBe('workstation');
    expect(k?.methods.map((m) => m.flow)).toEqual(['local_only']);
    expect(
      IntegrationStatusSchema.safeParse({
        kind: 'github-app',
        instance: '4242:777',
        state: 'refused',
        scope: 'workstation',
        checkedAt: '2026-11-14T12:00:00.000Z',
        refreshedAt: '2026-11-14T11:50:00.000Z',
        errorCode: 'token_rejected',
      }).success,
    ).toBe(true);
  });
});
