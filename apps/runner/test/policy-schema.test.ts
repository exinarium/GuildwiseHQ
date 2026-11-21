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
      devops: { agents: {}, sudo: false },
      deploy: 'ask',
      deployPins: [],
      deployPinCommit: false,
      devopsRequests: 'ask',
      allowUnsignedUpdatesFrom: [],
      docker: 'none',
      setupDone: false,
      installScripts: {},
      formatterPins: [],
      devopsAgentRequests: 'ask',
      allowDocker: false,
      ceo: { fullPower: false },
      acceptRootEquivalent: false,
      passkeys: [],
      signingKeys: [],
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
    expect(p.devops.sudo).toBe(true);
    expect(p.passkeys[0]?.signCount).toBe(0);
    expect(p.signingKeys[0]?.autoSign).toBe(false);
    expect(p).not.toHaveProperty('grantedByServer');
  });

  it('refuses what local policy never allows', () => {
    const bad = (x: unknown) => PolicySchema.safeParse(x).success;
    expect(bad({ devops: { agents: {}, sudo: true }, devopsRequests: 'auto' })).toBe(false);
    expect(bad({ docker: 'group' })).toBe(false);
    expect(bad({ docker: 'group', acceptRootEquivalent: true })).toBe(true);
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

describe('release key and test fixtures', () => {
  it('the official key is the placeholder until the owner commits his', () => {
    expect(releaseKeyIsPlaceholder()).toBe(true);
    expect(RELEASE_KEY_ID).toBeNull();
    expect(read('../../../release-key/guildwise-runner-release.pub')).toContain('PLACEHOLDER');
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
