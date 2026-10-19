import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VaultWriteCommandSchema } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { runnerPaths } from '../src/paths.ts';
import { readVaultContext } from '../src/vaults/context.ts';
import {
  ensureLocalVault,
  isLocalVaultDir,
  LOCAL_VAULT_MARKER,
  localVaultWarning,
  setAsideLocalVault,
  syncRootOf,
} from '../src/vaults/local.ts';
import { VaultManager } from '../src/vaults/manager.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';
import { makeVault } from './vault-fixtures.ts';

cleanupTmp();

function manager() {
  const root = tmp('aom-local-vault-');
  const paths = runnerPaths(root);
  const sent: Array<{ type: string; payload: Record<string, any> }> = [];
  const m = new VaultManager({
    paths,
    secondMs: 60_000,
    transport: { send: (type, payload) => void sent.push({ type, payload }) },
  });
  return { m, paths, sent, root };
}
const cfg = (vaults: Array<Record<string, unknown>>) =>
  ({
    vaults,
    identity: { name: 'Atlas (aom)', email: 'a@agents.aom.invalid' },
    workstationName: 'Desk',
    resume: [],
  }) as any;
const localVault = (vaultId = 'lv1') => ({
  vaultId,
  kind: 'project',
  projectId: 'p1',
  name: 'Project vault',
  remoteUrl: '',
  syncIntervalSec: 300,
  storage: 'local',
});
const write = (path: string, content: string, over: Record<string, unknown> = {}) =>
  VaultWriteCommandSchema.parse({
    vaultId: 'lv1',
    path,
    mode: 'create',
    content,
    commitMessage: 'msg',
    ...over,
  });

describe('local vaults (project-graphs design section 3)', () => {
  it('configure creates the folder with its marker and reports its path; nothing is cloned, synced or timed', async () => {
    const { m, paths, sent } = manager();
    m.configure(cfg([localVault()]));
    await m.syncNow('lv1');
    const dir = join(paths.vaults, 'lv1');
    expect(existsSync(join(dir, LOCAL_VAULT_MARKER))).toBe(true);
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(isLocalVaultDir(dir)).toBe(true);
    expect(
      sent.some((s) => s.type === 'vault.status' && s.payload.localPath === dir && !s.payload.error),
    ).toBe(true);
    expect(await m.report()).toEqual([{ vaultId: 'lv1', localPath: dir, clean: true }]);
    expect(m.isLocal('lv1')).toBe(true);
    m.stop();
  });

  it('vault.write puts the file in the folder without commit or push, idempotently', async () => {
    const { m, paths } = manager();
    m.configure(cfg([localVault()]));
    const r = await m.write(write('projects/toy/notes.md', '# notes\n'));
    expect(r).toMatchObject({ written: true, committed: false, pushed: false, paused: false });
    expect(readFileSync(join(paths.vaults, 'lv1', 'projects/toy/notes.md'), 'utf8')).toBe('# notes\n');
    expect(await m.write(write('projects/toy/notes.md', '# notes\n'))).toMatchObject({ written: false });
    await expect(m.write(write('../escape.md', 'x'))).rejects.toThrow(/unsafe vault path/);
    m.stop();
  });

  it('move and merge are refused for a local vault', async () => {
    const { m } = manager();
    m.configure(cfg([localVault()]));
    await expect(
      m.move({ vaultId: 'lv1', from: 'a', to: 'b', commitMessage: 'x', push: false } as any),
    ).rejects.toThrow(/local vault/);
    m.stop();
  });

  it('a shift or chat reads standing orders from a local vault like from a clone', async () => {
    const { m, paths } = manager();
    m.configure(cfg([localVault()]));
    await m.write(write('standing-orders.md', 'Always run the tests.\n'));
    const ctx = await readVaultContext(paths.vaults, {
      vaultId: 'lv1',
      kind: 'project',
      folder: 'projects/toy',
    } as any);
    expect(ctx?.standingOrders.map((o) => o.body)).toEqual(['Always run the tests.']);
    // a folder without the marker (or a clone) is not a vault
    mkdirSync(join(paths.vaults, 'stranger'), { recursive: true });
    expect(await readVaultContext(paths.vaults, { vaultId: 'stranger', kind: 'project' } as any)).toBeNull();
    m.stop();
  });

  it('a project given a repository later: the local folder is set aside and the repository is cloned', async () => {
    const { m, paths } = manager();
    m.configure(cfg([localVault()]));
    await m.write(write('projects/toy/notes.md', 'kept\n'));
    const v = makeVault({ 'README.md': '# remote\n' });
    process.env.AOM_ALLOW_LOCAL_REMOTES = '1';
    m.configure(cfg([{ ...localVault(), storage: undefined, remoteUrl: v.origin }]));
    const r = await m.syncNow('lv1');
    expect((r as { status: string }).status).toBe('ok');
    const dir = join(paths.vaults, 'lv1');
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# remote\n');
    const aside = readdirSync(paths.vaults).find((n) => n.startsWith('lv1.was-local-'));
    expect(aside).toBeTruthy();
    expect(readFileSync(join(paths.vaults, aside as string, 'projects/toy/notes.md'), 'utf8')).toBe('kept\n');
    m.stop();
  });

  it('setAsideLocalVault leaves a clone and a missing folder alone', () => {
    const root = tmp('aom-local-vault-');
    expect(setAsideLocalVault(join(root, 'none'))).toBeNull();
    const dir = join(root, 'v');
    ensureLocalVault(dir);
    writeFileSync(join(dir, 'a.md'), 'a');
    expect(setAsideLocalVault(dir, () => new Date('2026-10-19T10:00:00Z'))).toBe(
      `${dir}.was-local-2026-10-19T10-00-00-000Z`,
    );
    expect(existsSync(dir)).toBe(false);
  });
});

describe('sync roots', () => {
  it('names the sync tool a folder sits in, and warns', () => {
    expect(syncRootOf('/home/me/OneDrive/aom/v1', '/home/me')).toBe('OneDrive');
    expect(syncRootOf('/home/me/Library/Mobile Documents/com~apple~CloudDocs/v', '/home/me')).toBe(
      'iCloud Drive',
    );
    expect(syncRootOf('/home/me/Dropbox/x', '/home/me')).toBe('Dropbox');
    expect(syncRootOf('C:\\Users\\me\\OneDrive - Contoso\\vaults', 'C:\\Users\\me')).toBe('OneDrive');
    expect(syncRootOf('/home/me/.aom-runner/vaults/v1', '/home/me')).toBeNull();
    expect(localVaultWarning('/home/me/OneDrive/v')).toMatch(/OneDrive.*back it up yourself.*git init/);
    expect(localVaultWarning('/home/me/.aom-runner/vaults/v')).toMatch(/not synced.*back it up yourself/);
  });
});
