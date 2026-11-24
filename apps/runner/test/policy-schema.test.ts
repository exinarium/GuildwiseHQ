import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DeployTargetSigningSchema,
  parseMinisignPublicKey,
  RunnerReleaseManifestSchema,
  SignedReleaseProofSchema,
} from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, PolicySchema, parsePolicy } from '../src/policy/schema.ts';
import { RELEASE_KEY_ID, releaseKeyIsPlaceholder } from '../src/update/release-key.ts';

const FIX = join(import.meta.dirname, 'fixtures/minisign');
const read = (f: string) => readFileSync(join(FIX, f), 'utf8');
const keyLine = (f: string) => read(f).split('\n')[1] as string;

describe('policy.json schema', () => {
  it('defaults to the safe policy: nothing granted, deploys ask, nothing trusted', () => {
    expect(DEFAULT_POLICY).toEqual({
      version: 1,
      devops: { agents: {} },
      deploy: 'ask',
      deployPins: [],
      deployPinCommit: false,
      devopsRequests: 'ask',
      allowUnsignedUpdatesFrom: [],
      docker: 'none',
      setupDone: false,
      installScripts: {},
      installRegistries: [],
      installNetworkConfig: false,
      vaultRemotes: [],
      formatterPins: [],
      devopsAgentRequests: 'ask',
      allowDocker: false,
      ceo: { fullPower: false },
      acceptRootEquivalent: false,
      passkeys: [],
      signingKeys: [],
      toolchainPins: [],
    });
    expect(DEFAULT_POLICY.startupRefusal).toBeUndefined();
  });

  it('reads a full policy and drops unknown fields', () => {
    const p = parsePolicy(
      JSON.stringify({
        devops: {
          agents: { '00000000-0000-4000-8000-000000000001': '00000000-0000-4000-8000-000000000002' },
          sudo: true,
        },
        deployPins: ['a'.repeat(64)],
        deployPinCommit: true,
        allowUnsignedUpdatesFrom: ['https://uat.example.test:4443'],
        docker: 'narrow',
        runnerUser: { mode: 'dedicated', name: 'guildwise-runner' },
        setupDone: true,
        installScripts: { 'https://github.com/acme/app.git': true },
        startupRefusal: true,
        passkeys: [
          {
            credentialId: 'abc_-1',
            publicKey: 'MFkw',
            alg: -7,
            rpId: 'guildwise.example.test',
            origin: 'https://guildwise.example.test',
          },
        ],
        legacyUpdateOrigin: 'https://guildwise.example.test',
        signingKeys: [
          { keyId: '515674AC008F1CF3', keyFile: '/home/u/.config/guildwise/signing/uat/uat.key' },
        ],
        grantedByServer: true,
      }),
    );
    // 1.10.0: an old file keeps parsing; sudo is dropped and narrow mode maps to no Docker
    expect(p.devops).toEqual({
      agents: { '00000000-0000-4000-8000-000000000001': '00000000-0000-4000-8000-000000000002' },
    });
    expect(p.docker).toBe('none');
    expect(p.passkeys[0]?.signCount).toBe(0);
    expect(p.signingKeys[0]?.autoSign).toBe(false);
    expect(p).not.toHaveProperty('grantedByServer');
  });

  it('refuses what local policy never allows', () => {
    const bad = (x: unknown) => PolicySchema.safeParse(x).success;
    expect(bad({ docker: 'host' })).toBe(false);
    expect(bad({ docker: 'group' })).toBe(false);
    expect(bad({ docker: 'host', acceptRootEquivalent: true })).toBe(true);
    expect(bad({ docker: 'swarm' })).toBe(false);
    expect(bad({ allowUnsignedUpdatesFrom: ['https://x.test/path'] })).toBe(false);
    expect(bad({ allowUnsignedUpdatesFrom: ['*'] })).toBe(false);
    expect(bad({ signingKeys: [{ keyId: '515674AC008F1CF3', keyFile: 'relative.key' }] })).toBe(false);
    expect(
      bad({
        signingKeys: [
          { keyId: '515674AC008F1CF3', keyFile: '/a.key' },
          { keyId: '515674AC008F1CF3', keyFile: '/b.key' },
        ],
      }),
    ).toBe(false);
    expect(bad({ deploy: 'auto' })).toBe(false);
    expect(() => parsePolicy('{not json')).toThrow();
  });
});

describe('policy.json docker values (deps-without-sudo)', () => {
  const ok = (x: unknown) => PolicySchema.safeParse(x).success;
  it('maps the values of before: narrow -> none, group -> host; devops.sudo dropped while the file stays valid', () => {
    expect(PolicySchema.parse({ docker: 'narrow' }).docker).toBe('none');
    const g = PolicySchema.parse({ docker: 'group', acceptRootEquivalent: true });
    expect(g.docker).toBe('host');
    const old = PolicySchema.parse({ devops: { agents: {}, sudo: true }, devopsRequests: 'auto' });
    expect(old.devops).toEqual({ agents: {} });
    expect(old.devopsRequests).toBe('auto');
    expect(ok({ docker: 'rootless' })).toBe(true);
  });

  it('dockerHost: a Mac Docker Desktop socket with host, a /run daemon socket with shared, nothing else', () => {
    const mac = 'unix:///Users/alice/.docker/run/docker.sock';
    const svc = 'unix:///run/docker-svc/docker.sock';
    expect(ok({ docker: 'host', acceptRootEquivalent: true, dockerHost: mac })).toBe(true);
    expect(ok({ docker: 'host', acceptRootEquivalent: true, dockerHost: svc })).toBe(false);
    expect(ok({ docker: 'shared', dockerHost: svc })).toBe(true);
    expect(ok({ docker: 'shared', dockerHost: mac })).toBe(false);
    expect(ok({ docker: 'shared' })).toBe(false);
    expect(ok({ docker: 'rootless', dockerHost: svc })).toBe(false);
    expect(ok({ docker: 'host', acceptRootEquivalent: true, dockerHost: 'tcp://10.0.0.1:2375' })).toBe(false);
    expect(
      ok({
        docker: 'host',
        acceptRootEquivalent: true,
        dockerHost: 'unix:///Users/a/../b/.docker/run/docker.sock',
      }),
    ).toBe(false);
  });

  it('sharedDocker: the acceptance root records for a shared rootless daemon', () => {
    const p = PolicySchema.parse({
      docker: 'shared',
      dockerHost: 'unix:///run/docker-svc/docker.sock',
      sharedDocker: {
        socket: '/run/docker-svc/docker.sock',
        group: 'docker-svc',
        acceptedAt: '2026-11-21T10:00:00.000Z',
      },
    });
    expect(p.sharedDocker?.group).toBe('docker-svc');
  });
});

describe('release key and test fixtures', () => {
  it("the official key is the owner's committed key (0403EF6CE164E7D8), not the placeholder", () => {
    expect(releaseKeyIsPlaceholder()).toBe(false);
    expect(RELEASE_KEY_ID).toBe('0403EF6CE164E7D8');
    expect(read('../../../release-key/guildwise-runner-release.pub')).toContain('0403EF6CE164E7D8');
  });

  it('test keys parse as minisign public keys with the ids minisign printed', () => {
    expect(parseMinisignPublicKey(keyLine('test.pub'))?.keyId).toBe('8399E5B65A3876B0');
    expect(parseMinisignPublicKey(keyLine('other.pub'))?.keyId).toBe('F0D6288B1CBE00A7');
    expect(parseMinisignPublicKey(keyLine('test.pub'))?.publicKey).toHaveLength(32);
    expect(parseMinisignPublicKey('PLACEHOLDER')).toBeNull();
    // a secret key line is never a public key
    expect(parseMinisignPublicKey(keyLine('test.key'))).toBeNull();
    expect(
      DeployTargetSigningSchema.safeParse({
        required: true,
        keyId: '8399E5B65A3876B0',
        publicKey: keyLine('test.pub'),
      }).success,
    ).toBe(true);
  });

  it('the fixture manifest and signature have the proof shape', () => {
    const manifest = read('manifest.json');
    const m = RunnerReleaseManifestSchema.parse(JSON.parse(manifest));
    expect(m).toMatchObject({ version: '1.10.0', floor: '1.10.0', allowDowngrade: false });
    expect(
      createHash('sha256')
        .update(readFileSync(join(FIX, m.file)))
        .digest('hex'),
    ).toBe(m.sha256);
    const proof = SignedReleaseProofSchema.parse({ manifest, minisig: read('manifest.json.minisig') });
    // the signature names the test key: the key id sits in bytes 2..10 of the second line
    const sig = Buffer.from(proof.minisig.split('\n')[1] as string, 'base64');
    expect(sig.subarray(0, 2).toString()).toBe('ED');
    expect(Buffer.from(sig.subarray(2, 10)).reverse().toString('hex').toUpperCase()).toBe('8399E5B65A3876B0');
    expect(proof.minisig).toContain('trusted comment: guildwise-runner 1.10.0');
  });
});
