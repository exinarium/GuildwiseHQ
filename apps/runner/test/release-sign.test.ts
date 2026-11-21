import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Approvals } from '../src/policy/approvals.ts';
import { approve, type PolicyCliDeps } from '../src/policy/cli.ts';
import { gateReleaseSign } from '../src/policy/gate.ts';
import { HeldStore } from '../src/policy/held.ts';
import { PasskeyStore } from '../src/policy/passkey-store.ts';
import { PolicyStore } from '../src/policy/store.ts';
import {
  ArtefactIndex,
  type MinisignRunner,
  secretKeyKind,
  signArtefact,
  verifyArtefactSignature,
} from '../src/signing/release-sign.ts';
import { verifyMinisign } from '../src/update/minisign.ts';
import { FIXTURES, minisignSign, OTHER_PUB, TEST_KEY_ID, TEST_PUB } from './minisign-helper.ts';

/** A minisign stand-in: signs with the fixture key named by -s, writes -x, like `minisign -S`. */
const fakeMinisign: MinisignRunner = async (args) => {
  const at = (f: string) => args[args.indexOf(f) + 1] as string;
  const key = at('-s').endsWith('other.key') ? 'other.key' : 'test.key';
  if (at('-s').endsWith('protected.key')) return { code: 1, stderr: 'Password: ' };
  writeFileSync(at('-x'), minisignSign(readFileSync(at('-m')), key, at('-t')));
  return { code: 0, stderr: '' };
};

function artefact(under?: string) {
  const dir = under ?? mkdtempSync(join(tmpdir(), 'aom-artefact-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'manifest.json');
  writeFileSync(file, '{"version":"1.10.0"}\n');
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  return { dir, file, sha };
}

const payload = (sha: string, keyId = TEST_KEY_ID) => ({
  releaseId: '0190a000-0000-7000-8000-000000000020',
  targetId: '0190a000-0000-7000-8000-000000000021',
  targetName: 'uat',
  projectName: 'Guildwise',
  version: '1.10.0',
  keyId,
  artefact: 'release/uat/manifest.json',
  repoId: '0190a000-0000-7000-8000-000000000022',
  artefactSha256: sha,
});
const testKey = { keyId: TEST_KEY_ID, keyFile: join(FIXTURES, 'test.key'), autoSign: false };

describe('release.sign on the key holder workstation (R30)', () => {
  it('reads only the KDF field: the fixture keys are told apart', () => {
    expect(secretKeyKind(join(FIXTURES, 'test.key'))).toBe('plain');
    expect(secretKeyKind(join(FIXTURES, 'protected.key'))).toBe('passphrase');
    expect(secretKeyKind(join(FIXTURES, 'test.pub'))).toBe('unknown');
  });

  it('signs the file on disk with the trusted comment and returns only the signature', async () => {
    const a = artefact();
    const r = await signArtefact({
      payload: payload(a.sha),
      key: testKey,
      artefactPath: a.file,
      interactive: false,
      minisign: fakeMinisign,
    });
    expect(r.keyId).toBe(TEST_KEY_ID);
    expect(verifyMinisign(readFileSync(a.file), r.minisig, TEST_PUB)).toMatchObject({
      ok: true,
      trustedComment: 'Guildwise 1.10.0 uat',
    });
  });

  it('refuses when the file on disk is not the one the server named', async () => {
    const a = artefact();
    await expect(
      signArtefact({
        payload: payload('b'.repeat(64)),
        key: testKey,
        artefactPath: a.file,
        interactive: false,
        minisign: fakeMinisign,
      }),
    ).rejects.toThrow(/not the one the server asked to sign/);
  });

  it('a passphrase key never signs unattended', async () => {
    const a = artefact();
    await expect(
      signArtefact({
        payload: payload(a.sha),
        key: { ...testKey, keyFile: join(FIXTURES, 'protected.key') },
        artefactPath: a.file,
        interactive: false,
        minisign: fakeMinisign,
      }),
    ).rejects.toThrow(/passphrase/);
  });

  it('the real minisign binary signs with the plain fixture key (when installed)', async () => {
    const a = artefact();
    const which = await import('node:child_process').then(
      (m) => m.spawnSync('minisign', ['-v']).status === 0,
    );
    if (!which) return;
    const r = await signArtefact({
      payload: payload(a.sha),
      key: testKey,
      artefactPath: a.file,
      interactive: false,
    });
    expect(verifyMinisign(readFileSync(a.file), r.minisig, TEST_PUB).ok).toBe(true);
  });

  it('before a deploy the runner refuses a signature that does not verify against the target key or the file', () => {
    const a = artefact();
    const good = minisignSign(readFileSync(a.file));
    expect(
      verifyArtefactSignature({ artefactPath: a.file, minisig: good, targetPublicKey: OTHER_PUB }).ok,
    ).toBe(false);
    expect(
      verifyArtefactSignature({
        artefactPath: a.file,
        minisig: minisignSign('another file'),
        targetPublicKey: TEST_PUB,
      }).ok,
    ).toBe(false);
    expect(
      verifyArtefactSignature({
        artefactPath: a.file,
        minisig: good,
        targetPublicKey: TEST_PUB,
        expectedSha256: 'c'.repeat(64),
      }).ok,
    ).toBe(false);
    expect(
      verifyArtefactSignature({
        artefactPath: a.file,
        minisig: good,
        targetPublicKey: TEST_PUB,
        writeBeside: true,
      }),
    ).toEqual({
      ok: true,
      keyId: TEST_KEY_ID,
    });
    expect(readFileSync(`${a.file}.minisig`, 'utf8')).toBe(good);
  });

  it('release.sign is held until `approve`, which signs at the keyboard; the runner then sends only the signature', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aom-policy-'));
    const store = new PolicyStore(dir);
    store.write({ ...store.get(), setupDone: true, signingKeys: [testKey] });
    const held = new HeldStore(dir);
    const pairing = mkdtempSync(join(tmpdir(), 'aom-pairing-'));
    // release.sign signs only prepared artefacts of the pairing (<data dir>/release-prep)
    const a = artefact(join(pairing, 'release-prep', 'r-t'));
    new ArtefactIndex(dir).record({
      releaseId: payload(a.sha).releaseId,
      targetId: payload(a.sha).targetId,
      path: a.file,
      sha256: a.sha,
      version: '1.10.0',
    });
    const d = gateReleaseSign(store.get(), payload(a.sha));
    if (d.action !== 'hold') throw new Error('expected hold');
    expect(d.detail).toMatch(/uat[\s\S]*1\.10\.0[\s\S]*8399E5B65A3876B0/);
    const executed: unknown[] = [];
    const approvals = new Approvals({
      policy: store,
      held,
      passkeys: new PasskeyStore(dir),
      pairing,
      serverOrigin: 'https://hq.example',
      send: () => undefined,
      execute: async (r) => {
        executed.push(r);
      },
      refuse: () => undefined,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const r = approvals.hold({
      decision: d,
      commandId: 'c1',
      replay: {
        type: 'command',
        body: { commandId: 'c1', command: 'release.sign', payload: payload(a.sha), artefactPath: a.file },
      },
    });
    await approvals.tick();
    expect(executed).toEqual([]);
    const cli: PolicyCliDeps = {
      store,
      held,
      passkeys: new PasskeyStore(dir),
      out: () => undefined,
      ask: async () => 'yes',
      minisign: fakeMinisign,
    };
    await approve(cli, r.id);
    await approvals.tick();
    const run = executed[0] as { signature: string };
    expect(verifyMinisign(readFileSync(a.file), run.signature, TEST_PUB).ok).toBe(true);
    expect(existsSync(join(held.dir, `${r.id}.json`))).toBe(false);
  });
});
