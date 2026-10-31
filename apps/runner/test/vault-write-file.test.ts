import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { type VaultWriteFileCommand, VaultWriteFileCommandSchema } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { runnerPaths } from '../src/paths.ts';
import { VaultManager } from '../src/vaults/manager.ts';
import { syncVault } from '../src/vaults/sync.ts';
import { vaultFileHasHash, writeVaultBinary } from '../src/vaults/write.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';
import { IDENTITY, makeVault, originLog } from './vault-fixtures.ts';

cleanupTmp();

const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x01, 0x02]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const cmd = (over: Partial<VaultWriteFileCommand> = {}): VaultWriteFileCommand =>
  VaultWriteFileCommandSchema.parse({
    vaultId: 'v1',
    path: 'projects/toy/docs/files/plan.pdf',
    documentId: '11111111-1111-4111-8111-111111111111',
    sha256: sha(bytes),
    size: bytes.byteLength,
    commitMessage: 'docs: file plan',
    ...over,
  });

async function clone() {
  const v = makeVault();
  await syncVault({ dir: v.mine, remoteUrl: v.origin, identity: IDENTITY, workstationName: 'Desk' });
  return v;
}

describe('writeVaultBinary (vault.write_file)', () => {
  it('writes the bytes unchanged and commits them', async () => {
    const v = await clone();
    const r = await writeVaultBinary(v.mine, cmd(), bytes);
    expect(r).toEqual({ written: true, committed: true });
    expect(readFileSync(join(v.mine, 'projects/toy/docs/files/plan.pdf')).equals(bytes)).toBe(true);
    expect(sh(v.mine, 'git', ['log', '-1', '--format=%s'])).toBe('docs: file plan');
    expect(sh(v.mine, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('is idempotent: the same bytes are success without a second commit', async () => {
    const v = await clone();
    await writeVaultBinary(v.mine, cmd(), bytes);
    const head = sh(v.mine, 'git', ['rev-parse', 'HEAD']);
    expect(await writeVaultBinary(v.mine, cmd(), bytes)).toEqual({ written: false, committed: false });
    expect(sh(v.mine, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(await vaultFileHasHash(v.mine, 'projects/toy/docs/files/plan.pdf', sha(bytes))).toBe(true);
    expect(await vaultFileHasHash(v.mine, 'projects/toy/docs/files/plan.pdf', sha(Buffer.from('x')))).toBe(
      false,
    );
  });

  it('refuses unsafe paths', async () => {
    const v = await clone();
    for (const path of ['../evil.pdf', '/etc/evil.pdf', 'docs/../../evil.pdf', '.git/hooks/x'])
      await expect(writeVaultBinary(v.mine, cmd({ path }), bytes)).rejects.toThrow(/unsafe vault path/);
  });

  it('does not write through a symlinked directory', async () => {
    const v = await clone();
    const outside = tmp('aom-outside-');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(v.mine, 'docs'));
    await expect(writeVaultBinary(v.mine, cmd({ path: 'docs/plan.pdf' }), bytes)).rejects.toThrow(/symlink/);
    expect(existsSync(join(outside, 'plan.pdf'))).toBe(false);
  });
});

describe('VaultManager.writeFile', () => {
  function setup() {
    const root = tmp('aom-wf-runner-');
    const m = new VaultManager({
      paths: runnerPaths(root),
      secondMs: 60_000,
      transport: { send: () => undefined },
    });
    return m;
  }
  const configure = (m: VaultManager, origin: string) =>
    m.configure({
      vaults: [{ vaultId: 'v1', kind: 'org', name: 'Org', remoteUrl: origin, syncIntervalSec: 3600 }],
      identity: IDENTITY,
      workstationName: 'Desk',
      resume: [],
    });

  it('fetches the bytes, commits them and pushes; a repeat downloads nothing', async () => {
    const v = makeVault();
    const m = setup();
    configure(m, v.origin);
    let fetched = 0;
    const fetchBytes = async () => {
      fetched++;
      return bytes;
    };
    const r = await m.writeFile(cmd(), fetchBytes);
    expect(r).toMatchObject({ written: true, committed: true, pushed: true });
    expect(originLog(v).some((l) => l.endsWith('|docs: file plan'))).toBe(true);
    const again = await m.writeFile(cmd(), fetchBytes);
    expect(again).toMatchObject({ written: false, committed: false });
    expect(fetched).toBe(1);
  });

  it('refuses bytes that do not match the announced size or hash, and writes nothing', async () => {
    const v = makeVault();
    const m = setup();
    configure(m, v.origin);
    await expect(m.writeFile(cmd(), async () => Buffer.from('tampered'))).rejects.toThrow(/does not match/);
    await expect(m.writeFile(cmd({ size: bytes.byteLength + 1 }), async () => bytes)).rejects.toThrow(
      /does not match/,
    );
    expect(originLog(v).some((l) => l.endsWith('|docs: file plan'))).toBe(false);
  });

  it('fails for a vault that is not configured', async () => {
    await expect(setup().writeFile(cmd(), async () => bytes)).rejects.toThrow(/not configured/);
  });
});
