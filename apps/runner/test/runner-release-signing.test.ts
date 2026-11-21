import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileAuthority } from '../src/policy/authority.ts';
import { approve, defaultCliDeps } from '../src/policy/cli.ts';
import { PolicyStore } from '../src/policy/store.ts';
import { RELEASE_PREP_DIR } from '../src/signing/release-prepare.ts';
import { ArtefactIndex, signArtefact } from '../src/signing/release-sign.ts';
import { type Harness, startHarness } from './harness.ts';
import { sh, tmp, waitUntil } from './helpers.ts';
import { FIXTURES, manifestText, minisignSign, OTHER_PUB, TEST_KEY_ID, TEST_PUB } from './minisign-helper.ts';
import { grantedAuthority } from './test-authority.ts';

/** R30 runner items of the W14 review: release.prepare, failure answers of release.sign, the deploy signature gate, the path. */
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const RELEASE = '0190a000-0000-7000-8000-000000000020';
const TARGET = '0190a000-0000-7000-8000-000000000021';
const REPO = '0190a000-0000-7000-8000-000000000022';
const pubLine = (pub: string) => pub.split('\n')[1] as string;

function realAuthority(over: Record<string, unknown> = {}) {
  const dir = tmp('aom-policy-');
  const store = new PolicyStore(dir);
  store.write({ ...store.get(), setupDone: true, ...over });
  return { dir, store, authority: new FileAuthority(store) };
}

const preparePayload = (commit: string) => ({
  releaseId: RELEASE,
  targetId: TARGET,
  targetName: 'uat',
  projectName: 'Guildwise',
  version: '1.10.0',
  repoId: REPO,
  commit,
  keyId: TEST_KEY_ID,
  publicKey: pubLine(TEST_PUB),
  artefact: 'release/uat/manifest.json',
});

describe('release.prepare (R30, W14)', () => {
  it('is held, then packages with the target key in a clean worktree and reports the exact manifest text', async () => {
    const a = realAuthority();
    let seen: string[] = [];
    h = await startHarness(
      {},
      {
        authority: a.authority,
        policyDir: a.dir,
        approvalsPollMs: 50,
        // the repository's package step, stubbed: it writes the manifest where --out says, embedding the key it got
        prepareExec: async (_cmd, args, o) => {
          seen = args;
          const out = args[args.indexOf('--out') + 1] as string;
          const key = readFileSync(args[args.indexOf('--pubkey') + 1] as string, 'utf8');
          mkdirSync(out, { recursive: true });
          writeFileSync(
            join(out, 'manifest.json'),
            manifestText('1.10.0', 'a'.repeat(64), { key: key.split('\n')[1] }),
          );
          return { code: 0, output: `packaged in ${o.cwd}` };
        },
      },
    );
    mkdirSync(join(h.repo.clone, 'scripts'));
    writeFileSync(join(h.repo.clone, 'scripts', 'package-runner.sh'), '#!/bin/sh\nexit 0\n');
    sh(h.repo.clone, 'git', ['add', '-A']);
    sh(h.repo.clone, 'git', ['commit', '-m', 'package script']);
    writeFileSync(join(h.dataDir, 'repo-ids.json'), JSON.stringify({ [REPO]: h.repo.remoteNormalized }));
    h.server.send('command', {
      commandId: 'c-prep',
      command: 'release.prepare',
      payload: preparePayload(sh(h.repo.clone, 'git', ['rev-parse', 'HEAD']).trim()),
    });
    const held = await h.server.waitFor('approvals.held', (m) =>
      m.items.some((i) => i.kind === 'release.prepare'),
    );
    expect(h.server.of('release.artefact.prepared')).toEqual([]);
    const item = held.items.find((i) => i.kind === 'release.prepare');
    await approve(
      { ...defaultCliDeps(a.dir), ask: async () => 'yes', out: () => undefined },
      item?.id as string,
    );
    await waitUntil(
      () =>
        !!h?.server.received.some(
          (m) =>
            m.type === 'release.artefact.prepared' ||
            (m.type === 'command.result' && m.commandId === 'c-prep'),
        ),
      20_000,
      'prepare answer',
    );
    const res = h.server.of('command.result').find((m) => m.commandId === 'c-prep');
    if (res && !res.ok) throw new Error(`release.prepare failed: ${res.error}`);
    const report = await h.server.waitFor('release.artefact.prepared', (m) => m.releaseId === RELEASE);
    const onDisk = readFileSync(
      join(h.dataDir, RELEASE_PREP_DIR, `${RELEASE}-${TARGET}`, 'release', 'uat', 'manifest.json'),
      'utf8',
    );
    expect(report.manifest).toBe(onDisk);
    expect(report.artefactSha256).toBe(createHash('sha256').update(onDisk).digest('hex'));
    expect(onDisk).toContain(pubLine(TEST_PUB)); // packaged with the target's public key
    expect(seen).toContain('--pubkey');
    const result = await h.server.waitFor('command.result', (m) => m.commandId === 'c-prep');
    expect(result.ok).toBe(true);
    expect(new ArtefactIndex(a.dir).find(RELEASE, TARGET)?.sha256).toBe(report.artefactSha256);
  });
});

describe('release.sign answers', () => {
  const signPayload = {
    releaseId: RELEASE,
    targetId: TARGET,
    targetName: 'uat',
    projectName: 'Guildwise',
    version: '1.10.0',
    keyId: TEST_KEY_ID,
    artefact: 'release/uat/manifest.json',
    repoId: REPO,
    artefactSha256: 'a'.repeat(64),
  };

  it('a refused (no such key) and a denied release.sign get a failure result', async () => {
    const a = realAuthority();
    h = await startHarness({}, { authority: a.authority, policyDir: a.dir, approvalsPollMs: 50 });
    h.server.send('command', { commandId: 's-refused', command: 'release.sign', payload: signPayload });
    const refused = await h.server.waitFor('command.result', (m) => m.commandId === 's-refused');
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/no signing key/) });
    a.store.update((p) => {
      p.signingKeys = [{ keyId: TEST_KEY_ID, keyFile: join(FIXTURES, 'test.key'), autoSign: false }];
      return p;
    });
    h.server.send('command', { commandId: 's-denied', command: 'release.sign', payload: signPayload });
    const held = await h.server.waitFor('approvals.held', (m) =>
      m.items.some((i) => i.kind === 'release.sign'),
    );
    const { deny } = await import('../src/policy/cli.ts');
    deny(
      { ...defaultCliDeps(a.dir), out: () => undefined },
      held.items.find((i) => i.kind === 'release.sign')?.id as string,
    );
    const denied = await h.server.waitFor('command.result', (m) => m.commandId === 's-denied');
    expect(denied).toMatchObject({ ok: false, error: 'denied on the workstation' });
  });

  it('only a file under <data dir>/release-prep is ever signed', async () => {
    const root = tmp('aom-data-');
    const outside = join(tmp(), 'manifest.json');
    writeFileSync(outside, '{"version":"1.10.0"}');
    const sha = createHash('sha256').update(readFileSync(outside)).digest('hex');
    await expect(
      signArtefact({
        payload: { ...signPayload, artefactSha256: sha },
        key: { keyId: TEST_KEY_ID, keyFile: join(FIXTURES, 'test.key'), autoSign: true },
        artefactPath: outside,
        interactive: false,
        allowedRoot: join(root, RELEASE_PREP_DIR),
        minisign: async () => ({ code: 0, stderr: '' }),
      }),
    ).rejects.toThrow(/not a prepared release artefact/);
  });
});

describe('deploy.exec.signing is checked on the workstation (R30 gate)', () => {
  const deploy = (signing: Record<string, unknown>) => ({
    runId: '0190a000-0000-7000-8000-0000000000aa',
    orgId: '0190a000-0000-7000-8000-000000000001',
    projectId: '0190a000-0000-7000-8000-000000000003',
    projectKey: 'TOY',
    vault: { vaultId: 'v1', storage: 'local', folder: 'toy' },
    vaultCommit: null,
    hash: 'a'.repeat(64),
    env: 'uat',
    target: { id: TARGET, name: 'uat', kind: 'docker', host: null, appUrl: null },
    commit: null,
    repo: null,
    trial: false,
    dryRun: false,
    expiresAt: '2099-01-01T00:00:00.000Z',
    signing,
  });

  it('refuses without a prepared artefact, with a signature by another key or over another file; a good one passes the gate', async () => {
    const policyDir = tmp('aom-policy-');
    h = await startHarness({}, { authority: grantedAuthority(), policyDir });
    const art = join(h.dataDir, RELEASE_PREP_DIR, `${RELEASE}-${TARGET}`, 'release', 'uat');
    mkdirSync(art, { recursive: true });
    const text = manifestText('1.10.0', 'a'.repeat(64));
    writeFileSync(join(art, 'manifest.json'), text);
    const sha = createHash('sha256').update(text).digest('hex');
    const base = {
      releaseId: RELEASE,
      keyId: TEST_KEY_ID,
      publicKey: pubLine(TEST_PUB),
      artefact: 'release/uat/manifest.json',
      artefactSha256: sha,
    };
    const send = async (id: string, signing: Record<string, unknown>) => {
      h?.server.send('command', { commandId: id, command: 'deploy.exec', payload: deploy(signing) });
      return (await h?.server.waitFor('command.result', (m) => m.commandId === id))?.result as {
        refused?: string;
      };
    };
    // not prepared on this workstation
    expect((await send('d1', { ...base, minisig: minisignSign(text) })).refused).toBe(
      'runner_signature_invalid',
    );
    new ArtefactIndex(policyDir).record({
      releaseId: RELEASE,
      targetId: TARGET,
      path: join(art, 'manifest.json'),
      sha256: sha,
      version: '1.10.0',
    });
    expect((await send('d2', { ...base, minisig: minisignSign(text, 'other.key') })).refused).toBe(
      'runner_signature_invalid',
    );
    expect(
      (await send('d3', { ...base, publicKey: pubLine(OTHER_PUB), minisig: minisignSign(text, 'other.key') }))
        .refused,
    ).toBe('runner_signature_invalid'); // key id does not match
    expect((await send('d4', { ...base, minisig: minisignSign('another manifest') })).refused).toBe(
      'runner_signature_invalid',
    );
    // a good signature passes the gate (the run then stops on the unknown vault, which is a different refusal)
    const ok = await send('d5', { ...base, minisig: minisignSign(text) });
    expect(ok.refused).not.toBe('runner_signature_invalid');
    expect(readFileSync(join(art, 'manifest.json.minisig'), 'utf8')).toBe(minisignSign(text));
  });
});
