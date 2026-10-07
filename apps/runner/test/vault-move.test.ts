import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type VaultMoveCommand, VaultMoveCommandSchema } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { syncVault } from '../src/vaults/sync.ts';
import { moveVaultFolder, VaultWriteError } from '../src/vaults/write.ts';
import { cleanupTmp, sh } from './helpers.ts';
import { IDENTITY, makeVault, originFile } from './vault-fixtures.ts';

cleanupTmp();

const cmd = (over: Partial<VaultMoveCommand> = {}): VaultMoveCommand =>
  VaultMoveCommandSchema.parse({
    vaultId: 'v1',
    from: 'projects/news',
    to: 'interests/news',
    commitMessage: 'aom: move projects/news to interests/news',
    ...over,
  });

async function clone(seed: Record<string, string>) {
  const v = makeVault(seed);
  await syncVault({ dir: v.mine, remoteUrl: v.origin, identity: IDENTITY, workstationName: 'Desk' });
  return v;
}
const SEED = {
  'README.md': '# vault\n',
  'projects/news/feed.md': '# Feed\n- one\n',
  'projects/news/taste.md': '# Taste\n- Skip x\n',
  'projects/news/transcripts/2026-10-01-a.md': 'transcript\n',
  'projects/other/keep.md': 'stays\n',
};

describe('moveVaultFolder (vault.move, docs/design/restructure.md owner decision 6)', () => {
  it('renames the folder with one commit and keeps the history of the files', async () => {
    const v = await clone(SEED);
    const r = await moveVaultFolder(v.mine, cmd(), IDENTITY);
    expect(r).toEqual({ moved: true, committed: true, conflicts: [] });
    expect(existsSync(join(v.mine, 'projects/news'))).toBe(false);
    expect(readFileSync(join(v.mine, 'interests/news/feed.md'), 'utf8')).toBe('# Feed\n- one\n');
    expect(readFileSync(join(v.mine, 'interests/news/transcripts/2026-10-01-a.md'), 'utf8')).toBe(
      'transcript\n',
    );
    expect(readFileSync(join(v.mine, 'projects/other/keep.md'), 'utf8')).toBe('stays\n');
    expect(sh(v.mine, 'git', ['log', '-1', '--format=%an|%s'])).toBe(
      'Atlas (aom)|aom: move projects/news to interests/news',
    );
    expect(sh(v.mine, 'git', ['status', '--porcelain'])).toBe('');
    // git sees renames, so `git log --follow` keeps the history
    expect(sh(v.mine, 'git', ['show', '--stat', '--format=', '-M', 'HEAD'])).toContain('=>');
  });

  it('is idempotent: running it again changes nothing, and nothing to move is success', async () => {
    const v = await clone(SEED);
    await moveVaultFolder(v.mine, cmd(), IDENTITY);
    const head = sh(v.mine, 'git', ['rev-parse', 'HEAD']);
    expect(await moveVaultFolder(v.mine, cmd(), IDENTITY)).toEqual({
      moved: false,
      committed: false,
      conflicts: [],
    });
    expect(sh(v.mine, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(
      await moveVaultFolder(v.mine, cmd({ from: 'projects/nothing', to: 'interests/nothing' }), IDENTITY),
    ).toEqual({
      moved: false,
      committed: false,
      conflicts: [],
    });
  });

  it('finishes a move that was interrupted after the rename and before the commit', async () => {
    const v = await clone(SEED);
    // the rename happened (as the first half of the command), but the runner stopped before it committed
    mkdirSync(join(v.mine, 'interests'), { recursive: true });
    sh(v.mine, 'mv', ['projects/news', 'interests/news']);
    expect(sh(v.mine, 'git', ['status', '--porcelain'])).not.toBe('');
    const r = await moveVaultFolder(v.mine, cmd(), IDENTITY);
    expect(r).toMatchObject({ committed: true, conflicts: [] });
    expect(sh(v.mine, 'git', ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(v.mine, 'interests/news/feed.md'))).toBe(true);
  });

  it('merges into a folder that already exists, never overwriting, and reports differing files', async () => {
    const v = await clone({
      ...SEED,
      'interests/news/taste.md': '# Taste\n- Different\n',
      'interests/news/feed.md': '# Feed\n- one\n',
    });
    const r = await moveVaultFolder(v.mine, cmd(), IDENTITY);
    expect(r.conflicts).toEqual(['taste.md']);
    // the identical file was dropped from the old place, the differing one stays there, the new one was moved
    expect(readFileSync(join(v.mine, 'interests/news/taste.md'), 'utf8')).toBe('# Taste\n- Different\n');
    expect(readFileSync(join(v.mine, 'projects/news/taste.md'), 'utf8')).toBe('# Taste\n- Skip x\n');
    expect(existsSync(join(v.mine, 'projects/news/feed.md'))).toBe(false);
    expect(readFileSync(join(v.mine, 'interests/news/transcripts/2026-10-01-a.md'), 'utf8')).toBe(
      'transcript\n',
    );
  });

  it('refuses unsafe paths, one folder inside the other and a symlink', async () => {
    const v = await clone(SEED);
    await expect(moveVaultFolder(v.mine, cmd({ to: '../outside' }), IDENTITY)).rejects.toThrow(
      VaultWriteError,
    );
    await expect(moveVaultFolder(v.mine, cmd({ to: 'projects/news/inner' }), IDENTITY)).rejects.toThrow(
      /inside/,
    );
    await expect(moveVaultFolder(v.mine, cmd({ to: 'projects/news' }), IDENTITY)).rejects.toThrow(/inside/);
    writeFileSync(join(v.mine, 'README.md'), 'x');
    sh(v.mine, 'ln', ['-s', '/tmp', 'linked']);
    await expect(
      moveVaultFolder(v.mine, cmd({ from: 'linked/x', to: 'interests/x' }), IDENTITY),
    ).rejects.toThrow(/symlink/);
  });

  it('after a sync the origin has the moved files and not the old ones', async () => {
    const v = await clone(SEED);
    await moveVaultFolder(v.mine, cmd(), IDENTITY);
    const r = await syncVault({
      dir: v.mine,
      remoteUrl: v.origin,
      identity: IDENTITY,
      workstationName: 'Desk',
    });
    expect(r.status).toBe('ok');
    expect(originFile(v, 'interests/news/feed.md')).toBe('# Feed\n- one\n');
    expect(() => originFile(v, 'projects/news/feed.md')).toThrow();
  });
});
