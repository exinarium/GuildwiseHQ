import { describe, expect, it } from 'vitest';
import {
  CommandPayloadSchemas,
  DomainEventSchema,
  type EventType,
  HelloSchema,
  isAckedFromRunner,
  PatchSecuritySettingsRequestSchema,
  RunnerCommandNameSchema,
  RunnerPairRequestSchema,
  RunnerToServerSchema,
  StepUpRequestSchema,
  sessionMethodProvesFactor,
  WelcomeSchema,
} from '../src/index.ts';

const U = '00000000-0000-4000-8000-000000000001';
const W = '00000000-0000-4000-8000-000000000002';
const SHA = 'a'.repeat(64);

describe('1.10.0 security contracts', () => {
  it('registers the new events', () => {
    const types = DomainEventSchema.options.map((o) => o.shape.type.value) as EventType[];
    for (const t of [
      'SessionStarted',
      'SuperAdminSessionRejected',
      'PlatformBlockAdded',
      'PlatformBlockRemoved',
      'SecuritySettingChanged',
      'WorkstationOrgServingSet',
      'WorkstationPasskeyAdded',
      'WorkstationPasskeyRemoved',
      'RenderWorkerAdded',
      'RenderWorkerRevoked',
      'DeployTargetSigningSet',
      'ReleaseArtefactPrepared',
      'ReleaseArtefactSigned',
    ] as const)
      expect(types).toContain(t);
  });

  it('keeps older payloads valid and accepts the new optional fields', () => {
    const parse = (type: string, payload: unknown) => DomainEventSchema.parse({ type, payload });
    expect(parse('PasswordChanged', { userId: U, passwordHash: 'h' })).toBeTruthy();
    expect(
      parse('PasswordChanged', { userId: U, passwordHash: 'h', via: 'reset_link', meta: { ip: '1.2.3.4' } }),
    ).toBeTruthy();
    expect(parse('PasswordResetLinkSent', { userId: U, by: U, orgId: W })).toBeTruthy();
    expect(parse('WorkstationUnlinked', { workstationId: W, by: 'signed_required' })).toBeTruthy();
    expect(
      parse('WorkstationPaired', {
        workstationId: W,
        userId: U,
        name: 'n',
        platform: null,
        hostname: null,
        runnerVersion: '1.10.0',
        tokenHash: 'x',
        release: { version: '1.10.0', sha256: SHA, keyId: '8399E5B65A3876B0' },
      }),
    ).toBeTruthy();
    expect(() =>
      parse('SessionStarted', { userId: U, method: 'password', sessionRef: 'not-a-hash', newDevice: false }),
    ).toThrow();
    expect(
      parse('SessionStarted', {
        userId: U,
        method: 'password_totp',
        sessionRef: SHA,
        newDevice: true,
        uaFamily: 'Firefox/Linux',
      }),
    ).toBeTruthy();
    expect(() => parse('SecuritySettingChanged', { key: 'somethingElse', value: true, by: U })).toThrow();
  });

  it('step-up and settings request shapes', () => {
    expect(StepUpRequestSchema.safeParse({ code: '123456' }).success).toBe(true);
    expect(StepUpRequestSchema.safeParse({ password: 'pw' }).success).toBe(true);
    expect(StepUpRequestSchema.safeParse({ code: '123456', password: 'pw' }).success).toBe(false);
    expect(StepUpRequestSchema.safeParse({}).success).toBe(false);
    expect(PatchSecuritySettingsRequestSchema.safeParse({ enforceTwoFactor: true }).success).toBe(true);
    expect(PatchSecuritySettingsRequestSchema.safeParse({ other: true }).success).toBe(false);
    expect(sessionMethodProvesFactor('password_recovery')).toBe(true);
    for (const m of ['invitation', 'email_verification', 'demo'] as const)
      expect(sessionMethodProvesFactor(m)).toBe(false);
  });

  it('runner protocol: release proof, start-up refusal, welcome flag, held items, passkey and release.sign', () => {
    const release = { manifest: '{"version":"1.10.0"}', minisig: 'untrusted comment: x\nRUSw...' };
    expect(
      RunnerPairRequestSchema.parse({
        code: 'C',
        name: 'n',
        platform: 'linux',
        hostname: 'h',
        runnerVersion: '1.10.0',
        release,
      }).release,
    ).toEqual(release);
    const hello = HelloSchema.shape;
    expect(Object.keys(hello)).toEqual(expect.arrayContaining(['release', 'startupRefused', 'setupPending']));
    expect(Object.keys(WelcomeSchema.shape)).toContain('requireSignedRunners');
    for (const c of ['passkey.offer', 'passkey.withdraw', 'approval.passkey', 'release.sign'])
      expect(RunnerCommandNameSchema.options).toContain(c);
    expect(
      CommandPayloadSchemas['release.sign'].safeParse({
        releaseId: U,
        targetId: W,
        targetName: 'uat',
        projectName: 'GWP',
        version: '1.10.0',
        keyId: '515674AC008F1CF3',
        artefact: 'release/uat/manifest.json',
        repoId: U,
        artefactSha256: SHA,
      }).success,
    ).toBe(true);
    expect(
      CommandPayloadSchemas['approval.passkey'].safeParse({
        itemId: 'h1',
        credentialId: 'abc',
        authenticatorData: 'AAA',
        clientDataJSON: 'BBB',
        signature: 'CCC',
      }).success,
    ).toBe(true);
    const held = RunnerToServerSchema.safeParse({
      v: 1,
      id: U,
      ts: '2026-11-20T23:00:00.000Z',
      type: 'approvals.held',
      items: [
        {
          id: 'h1',
          kind: 'recipe.write',
          summary: 'write delivery/deploy.sh',
          commandHash: SHA,
          createdAt: '2026-11-20T23:00:00.000Z',
          expiresAt: '2026-11-21T23:00:00.000Z',
          passkey: {
            challenge: 'abc',
            nonce: 'n1',
            expiresAt: '2026-11-20T23:05:00.000Z',
            credentialIds: ['abc'],
          },
        },
      ],
    });
    expect(held.success).toBe(true);
    expect(isAckedFromRunner('release.artefact.prepared')).toBe(true);
    expect(isAckedFromRunner('approvals.held')).toBe(false);
  });
});
