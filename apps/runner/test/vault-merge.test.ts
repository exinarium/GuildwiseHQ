import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type VaultMergeCommand, VaultMergeCommandSchema } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { runnerPaths } from '../src/paths.ts';
import { VaultManager } from '../src/vaults/manager.ts';
import { mergeVaultInto } from '../src/vaults/merge.ts';
import { syncVault } from '../src/vaults/sync.ts';
import { VaultWriteError } from '../src/vaults/write.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';
import { IDENTITY, makeVault, originFile } from './vault-fixtures.ts';

cleanupTmp();

const ORG = { 'README.md': '# org vault\n', 'standing-orders.md': '# Standing orders\n- org rule\n' };
const PERSONAL = {
  'README.md': '# personal vault\n',
  'standing-orders.md': '# Standing orders\n- personal rule\n',
  'projects/side/PROJECT.md': '# Side project\n',
  'projects/side/decisions/2026-10-01-x.md': 'decision\n',
  'interests/ainews/INTEREST.md': '# AI news\n',
  'interests/ainews/taste.md': '# Taste\n- no hype\n',
};

const cmd = (v: { origin: string }, over: Partial<VaultMergeCommand> = {}): VaultMergeCommand =>
  VaultMergeCommandSchema.parse({
    vaultId: 'org1',
    from: { vaultId: 'pers1', remoteUrl: v.origin },
    into: 'personal',
    lift: ['interests/ainews'],
    commitMessage: 'Merge the personal vault into the organization vault',
    ...over,
  });

/** An organization vault clone and a clone of the personal vault, each with its own origin. */
async function pair(org: Record<string, string> = ORG, personal: Record<string, string> = PERSONAL) {
  const o = makeVault(org);
  const p = makeVault(personal);
  await syncVault({ dir: o.mine, remoteUrl: o.origin, identity: IDENTITY, workstationName: 'Desk' });
  await syncVault({ dir: p.mine, remoteUrl: p.origin, identity: IDENTITY, workstationName: 'Desk' });
  return { o, p };
}

describe('mergeVaultInto (vault.merge, "drop personal")', () => {
  it('copies the personal vault under personal/ and lifts the interest folders to where interests live', async () => {
    const { o, p } = await pair();
    const r = await mergeVaultInto(o.mine, p.mine, cmd(p), IDENTITY);
    expect(r).toEqual({ copied: 6, committed: true, conflicts: [] });
    expect(readFileSync(join(o.mine, 'personal/projects/side/PROJECT.md'), 'utf8')).toBe('# Side project\n');
    expect(readFileSync(join(o.mine, 'personal/standing-orders.md'), 'utf8')).toContain('personal rule');
    // the organization's own files are untouched
    expect(readFileSync(join(o.mine, 'standing-orders.md'), 'utf8')).toContain('org rule');
    // the lifted interest is at interests/ainews, not under personal/
    expect(readFileSync(join(o.mine, 'interests/ainews/INTEREST.md'), 'utf8')).toBe('# AI news\n');
    expect(existsSync(join(o.mine, 'personal/interests'))).toBe(false);
    expect(existsSync(join(o.mine, 'personal/.git'))).toBe(false);
    expect(sh(o.mine, 'git', ['log', '-1', '--format=%an|%s'])).toBe(
      'Workstation Owner|Merge the personal vault into the organization vault',
    );
    expect(sh(o.mine, 'git', ['status', '--porcelain'])).toBe('');
    // the source is never changed: it stays as a backup
    expect(sh(p.mine, 'git', ['status', '--porcelain'])).toBe('');
    expect(readFileSync(join(p.mine, 'interests/ainews/INTEREST.md'), 'utf8')).toBe('# AI news\n');
  });

  it('is idempotent: a second run copies nothing and makes no commit', async () => {
    const { o, p } = await pair();
    await mergeVaultInto(o.mine, p.mine, cmd(p), IDENTITY);
    const head = sh(o.mine, 'git', ['rev-parse', 'HEAD']);
    expect(await mergeVaultInto(o.mine, p.mine, cmd(p), IDENTITY)).toEqual({
      copied: 0,
      committed: false,
      conflicts: [],
    });
    expect(sh(o.mine, 'git', ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('finishes a merge that was interrupted after copying and before the commit', async () => {
    const { o, p } = await pair();
    // the first run copied files, then the process died: they sit uncommitted in the clone
    await mergeVaultInto(o.mine, p.mine, cmd(p, { commitMessage: 'x' }), IDENTITY);
    sh(o.mine, 'git', ['reset', '--soft', 'HEAD~1']);
    sh(o.mine, 'git', ['reset']);
    expect(sh(o.mine, 'git', ['status', '--porcelain'])).not.toBe('');
    const r = await mergeVaultInto(o.mine, p.mine, cmd(p), IDENTITY);
    expect(r).toMatchObject({ copied: 0, committed: true, conflicts: [] });
    expect(sh(o.mine, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('copies what is missing when the first run stopped half way', async () => {
    const { o, p } = await pair();
    // half of the files exist already (identical), the rest are copied now
    await mergeVaultInto(o.mine, p.mine, cmd(p), IDENTITY);
    sh(o.mine, 'rm', ['-r', 'personal/projects']);
    sh(o.mine, 'git', ['add', '-A']);
    sh(o.mine, 'git', ['commit', '-m', 'lost half']);
    const r = await mergeVaultInto(o.mine, p.mine, cmd(p), IDENTITY);
    expect(r).toMatchObject({ copied: 2, committed: true });
    expect(existsSync(join(o.mine, 'personal/projects/side/PROJECT.md'))).toBe(true);
  });

  it('never overwrites: a file that differs at the destination is reported and stays as it is', async () => {
    const { o, p } = await pair({
      ...ORG,
      'interests/ainews/taste.md': '# Taste\n- the organization wrote this after the migration\n',
      'personal/standing-orders.md': 'an older personal folder\n',
    });
    const r = await mergeVaultInto(o.mine, p.mine, cmd(p), IDENTITY);
    expect(r.conflicts.sort()).toEqual(['interests/ainews/taste.md', 'personal/standing-orders.md']);
    expect(readFileSync(join(o.mine, 'interests/ainews/taste.md'), 'utf8')).toContain('after the migration');
    expect(readFileSync(join(o.mine, 'personal/standing-orders.md'), 'utf8')).toBe(
      'an older personal folder\n',
    );
    // the rest was merged
    expect(readFileSync(join(o.mine, 'interests/ainews/INTEREST.md'), 'utf8')).toBe('# AI news\n');
  });

  it('refuses unsafe paths and a lifted folder that overlaps the target folder', async () => {
    const { o, p } = await pair();
    await expect(mergeVaultInto(o.mine, p.mine, cmd(p, { into: '../out' }), IDENTITY)).rejects.toThrow(
      VaultWriteError,
    );
    await expect(mergeVaultInto(o.mine, p.mine, cmd(p, { lift: ['personal/x'] }), IDENTITY)).rejects.toThrow(
      /overlap/,
    );
    await expect(mergeVaultInto(o.mine, p.mine, cmd(p, { lift: ['a/../b'] }), IDENTITY)).rejects.toThrow(
      VaultWriteError,
    );
  });

  it('ignores a symlink in the source and an empty source', async () => {
    const { o, p } = await pair();
    sh(p.mine, 'ln', ['-s', '/etc/passwd', 'linked.md']);
    const r = await mergeVaultInto(o.mine, p.mine, cmd(p), IDENTITY);
    expect(existsSync(join(o.mine, 'personal/linked.md'))).toBe(false);
    expect(r.copied).toBe(6);
    const empty = makeVault({ 'README.md': 'x' });
    sh(empty.root, 'git', ['init', '-q', join(empty.root, 'blank')]);
    expect(
      await mergeVaultInto(o.mine, join(empty.root, 'blank'), cmd(p, { into: 'blank' }), IDENTITY),
    ).toEqual({ copied: 0, committed: false, conflicts: [] });
  });
});

describe('VaultManager.merge: cloned from the URL in the command, committed and pushed', () => {
  it('merges a vault that is no longer registered, pushes the organization vault, and a retry is a success', async () => {
    const o = makeVault(ORG);
    const p = makeVault(PERSONAL);
    const root = tmp('aom-merge-runner-');
    const m = new VaultManager({
      paths: runnerPaths(root),
      secondMs: 60_000,
      transport: { send: () => {} },
    });
    m.configure({
      vaults: [{ vaultId: 'org1', kind: 'org', name: 'Org', remoteUrl: o.origin, syncIntervalSec: 3600 }],
      identity: IDENTITY,
      workstationName: 'Desk',
      resume: [],
    });
    const c = cmd(p);
    const r = await m.merge(c);
    expect(r).toMatchObject({ copied: 6, committed: true, pushed: true, paused: false });
    expect(originFile(o, 'personal/projects/side/PROJECT.md')).toBe('# Side project\n');
    expect(originFile(o, 'interests/ainews/taste.md')).toContain('no hype');
    // redelivery after a lost acknowledgement
    expect(await m.merge(c)).toMatchObject({ copied: 0, committed: false });
    // an edit made in the source in the meantime is picked up by the next run (the source is synced first)
    writeFileSync(join(p.other, 'projects/side/NEW.md'), 'new\n');
    sh(p.other, 'git', ['add', '-A']);
    sh(p.other, 'git', ['commit', '-m', 'late edit']);
    sh(p.other, 'git', ['push', 'origin', 'main']);
    expect(await m.merge(c)).toMatchObject({ copied: 1, committed: true, pushed: true });
    expect(originFile(o, 'personal/projects/side/NEW.md')).toBe('new\n');
    m.stop();
  });

  it('fails when the organization vault is not configured here', async () => {
    const p = makeVault(PERSONAL);
    const m = new VaultManager({
      paths: runnerPaths(tmp('aom-merge-runner-')),
      secondMs: 60_000,
      transport: { send: () => {} },
    });
    await expect(m.merge(cmd(p))).rejects.toThrow(/not configured/);
    m.stop();
  });

  it('is a no-op success when the source is the same repository (URL spelled differently), and copies nothing', async () => {
    const o = makeVault(ORG);
    const root = tmp('aom-merge-same-');
    const m = new VaultManager({
      paths: runnerPaths(root),
      secondMs: 60_000,
      transport: { send: () => {} },
    });
    m.configure({
      vaults: [{ vaultId: 'org1', kind: 'org', name: 'Org', remoteUrl: o.origin, syncIntervalSec: 3600 }],
      identity: IDENTITY,
      workstationName: 'Desk',
      resume: [],
    });
    const head = sh(o.origin, 'git', ['rev-parse', 'HEAD']);
    const r = await m.merge(cmd(o, { from: { vaultId: 'pers1', remoteUrl: `${o.origin}/` } }));
    expect(r).toMatchObject({ copied: 0, committed: false, pushed: false, conflicts: [] });
    expect(r.skipped).toMatch(/same repository/);
    expect(sh(o.origin, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(existsSync(join(root, 'vaults', 'pers1'))).toBe(false);
    m.stop();
  });
});

describe('mergeVaultInto: the same repository', () => {
  it('refuses to copy a clone of the target into itself (same origin after cloning)', async () => {
    const { o } = await pair();
    const second = tmp('aom-merge-clone-');
    sh(second, 'git', ['clone', o.origin, 'again']);
    const r = await mergeVaultInto(
      o.mine,
      join(second, 'again'),
      cmd(o, { from: { vaultId: 'x', remoteUrl: 'file:///elsewhere' } }),
      IDENTITY,
    );
    expect(r).toMatchObject({ copied: 0, committed: false, conflicts: [] });
    expect(r.skipped).toMatch(/same repository/);
    expect(existsSync(join(o.mine, 'personal'))).toBe(false);
  });
});
