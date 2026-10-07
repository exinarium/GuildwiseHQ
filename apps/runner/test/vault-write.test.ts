import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  renderTasteSeedSection,
  TASTE_HEADER,
  type VaultWriteCommand,
  VaultWriteCommandSchema,
} from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { runnerPaths } from '../src/paths.ts';
import { VaultManager } from '../src/vaults/manager.ts';
import { syncVault } from '../src/vaults/sync.ts';
import { VaultWriteError, writeVaultFile } from '../src/vaults/write.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';
import { IDENTITY, makeVault, originFile, originLog, pushFromOther } from './vault-fixtures.ts';

cleanupTmp();

const cmd = (over: Partial<VaultWriteCommand> = {}): VaultWriteCommand =>
  VaultWriteCommandSchema.parse({
    vaultId: 'v1',
    path: 'projects/toy/decisions/2026-10-03-use-email-019e3f.md',
    mode: 'create',
    content: '# Use email\n\nStatus: accepted\n',
    commitMessage: 'aom: decision TOY-4 use email',
    ...over,
  });

async function clone() {
  const v = makeVault();
  await syncVault({ dir: v.mine, remoteUrl: v.origin, identity: IDENTITY, workstationName: 'Desk' });
  return v;
}

describe('writeVaultFile (vault.write, docs/ARCHITECTURE.md section 16.4)', () => {
  it('create writes the file and commits it as the DevOps identity', async () => {
    const v = await clone();
    const r = await writeVaultFile(v.mine, cmd(), IDENTITY);
    expect(r).toEqual({ written: true, committed: true });
    expect(readFileSync(join(v.mine, 'projects/toy/decisions/2026-10-03-use-email-019e3f.md'), 'utf8')).toBe(
      '# Use email\n\nStatus: accepted\n',
    );
    expect(sh(v.mine, 'git', ['log', '-1', '--format=%an|%ae|%s'])).toBe(
      'Atlas (aom)|atlas@agents.aom.invalid|aom: decision TOY-4 use email',
    );
    expect(sh(v.mine, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('is idempotent: identical content is success without a second commit', async () => {
    const v = await clone();
    await writeVaultFile(v.mine, cmd(), IDENTITY);
    const head = sh(v.mine, 'git', ['rev-parse', 'HEAD']);
    expect(await writeVaultFile(v.mine, cmd(), IDENTITY)).toEqual({ written: false, committed: false });
    expect(sh(v.mine, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    // a create over a different file is refused (never silently overwrites a decision)
    await expect(writeVaultFile(v.mine, cmd({ content: 'something else\n' }), IDENTITY)).rejects.toThrow(
      /already exists with different content/,
    );
  });

  it('append adds a block once and keeps existing content; replace swaps the content', async () => {
    const v = makeVault({ 'standing-orders.md': '# Standing orders\n' });
    await syncVault({ dir: v.mine, remoteUrl: v.origin, identity: IDENTITY, workstationName: 'Desk' });
    const block = '\n## Never force-push\n\nFast-forward only.\n';
    const a = cmd({
      path: 'standing-orders.md',
      mode: 'append',
      content: block,
      commitMessage: 'aom: standing order',
    });
    expect(await writeVaultFile(v.mine, a, IDENTITY)).toEqual({ written: true, committed: true });
    expect(readFileSync(join(v.mine, 'standing-orders.md'), 'utf8')).toBe(`# Standing orders\n${block}`);
    expect(await writeVaultFile(v.mine, a, IDENTITY)).toEqual({ written: false, committed: false });
    const b = cmd({
      path: 'standing-orders.md',
      mode: 'append',
      content: '\n## Second\n',
      commitMessage: 'aom: second',
    });
    await writeVaultFile(v.mine, b, IDENTITY);
    expect(readFileSync(join(v.mine, 'standing-orders.md'), 'utf8')).toBe(
      `# Standing orders\n${block}\n## Second\n`,
    );
    const rep = cmd({ path: 'projects/toy/taste.md', mode: 'replace', content: 'v1\n' });
    expect(await writeVaultFile(v.mine, rep, IDENTITY)).toEqual({ written: true, committed: true });
    expect(await writeVaultFile(v.mine, { ...rep, content: 'v2\n' }, IDENTITY)).toEqual({
      written: true,
      committed: true,
    });
    expect(readFileSync(join(v.mine, 'projects/toy/taste.md'), 'utf8')).toBe('v2\n');
  });

  it('refuses paths that could escape the vault', async () => {
    const v = await clone();
    for (const path of ['../evil.md', '/etc/passwd', 'a/../../b.md', '.git/hooks/pre-commit', 'x\\y.md'])
      await expect(writeVaultFile(v.mine, cmd({ path }), IDENTITY), path).rejects.toBeInstanceOf(
        VaultWriteError,
      );
    expect(existsSync(join(v.root, 'evil.md'))).toBe(false);
  });
});

describe('VaultManager.write: committed and pushed', () => {
  function setup() {
    const root = tmp('aom-m3-runner-');
    const paths = runnerPaths(root);
    const sent: Array<{ type: string; payload: Record<string, any> }> = [];
    const m = new VaultManager({
      paths,
      secondMs: 60_000,
      transport: { send: (type, payload) => void sent.push({ type, payload }) },
    });
    return { m, paths, sent };
  }
  const configure = (m: VaultManager, origin: string) =>
    m.configure({
      vaults: [{ vaultId: 'v1', kind: 'org', name: 'Org', remoteUrl: origin, syncIntervalSec: 3600 }],
      identity: IDENTITY,
      workstationName: 'Desk',
      resume: [],
    });

  it('clones if needed, commits the decision file and pushes it right away', async () => {
    const v = makeVault();
    const { m } = setup();
    configure(m, v.origin);
    const r = await m.write(cmd());
    expect(r).toMatchObject({ written: true, committed: true, pushed: true, paused: false });
    expect(originFile(v, 'projects/toy/decisions/2026-10-03-use-email-019e3f.md')).toBe(
      '# Use email\n\nStatus: accepted\n',
    );
    expect(originLog(v)[0]).toBe('Atlas (aom)|aom: decision TOY-4 use email');
    // a retry of the same command (redelivery after a lost ack) is a success
    expect(await m.write(cmd())).toMatchObject({ written: false, committed: false, pushed: false });
    m.stop();
  });

  it('push:false commits only; the next sync pushes', async () => {
    const v = makeVault();
    const { m } = setup();
    configure(m, v.origin);
    const r = await m.write(cmd({ push: false }));
    expect(r).toMatchObject({ committed: true, pushed: false });
    expect(originLog(v)).toHaveLength(1);
    expect(await m.syncNow('v1')).toMatchObject({ status: 'ok', pushed: true });
    expect(originLog(v)[0]).toContain('aom: decision');
    m.stop();
  });

  it('rebases onto remote edits before pushing', async () => {
    const v = makeVault();
    const { m } = setup();
    configure(m, v.origin);
    await m.syncNow('v1');
    pushFromOther(v, 'standing-orders.md', 'remote rule\n');
    const r = await m.write(cmd());
    expect(r).toMatchObject({ committed: true, pushed: true });
    expect(originFile(v, 'standing-orders.md')).toBe('remote rule\n');
    expect(originFile(v, 'projects/toy/decisions/2026-10-03-use-email-019e3f.md')).toContain('Use email');
    m.stop();
  });

  it('a conflicting sync keeps the commit locally, pauses the vault and still reports the write as done', async () => {
    const v = makeVault({
      'projects/toy/decisions/2026-10-03-use-email-019e3f.md': 'someone else wrote this\n',
    });
    const { m, sent } = setup();
    configure(m, v.origin);
    await m.syncNow('v1');
    // the same decision file appears on the remote with other content after we cloned: our create conflicts at sync time
    pushFromOther(v, 'projects/toy/decisions/2026-10-03-use-email-019e3f.md', 'remote version\n');
    // locally the file still has the old content, so create is refused (different content), not silently merged
    await expect(m.write(cmd())).rejects.toThrow(/already exists/);
    // a replace that conflicts with the remote edit is committed locally and parked
    const r = await m.write(cmd({ mode: 'replace', content: 'local version\n' }));
    expect(r).toMatchObject({
      committed: true,
      pushed: false,
      paused: true,
      conflict: ['projects/toy/decisions/2026-10-03-use-email-019e3f.md'],
    });
    expect(sent.some((s) => s.type === 'vault.conflict')).toBe(true);
    // while paused, further writes only commit locally
    const again = await m.write(cmd({ path: 'projects/toy/decisions/other.md', content: 'x\n' }));
    expect(again).toMatchObject({ committed: true, pushed: false, paused: true });
    m.stop();
  });

  it('fails for a vault this workstation was not told about', async () => {
    const { m } = setup();
    await expect(m.write(cmd({ vaultId: 'nope' }))).rejects.toThrow(/not configured/);
    m.stop();
  });
});

describe('vault writes refuse symlinks (review low)', () => {
  it('does not write through a symlinked directory inside the clone', async () => {
    const v = await clone();
    const outside = join(tmp(), 'outside');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(v.mine, 'docs'));
    await expect(writeVaultFile(v.mine, cmd({ path: 'docs/evil.md' }), IDENTITY)).rejects.toThrow(/symlink/);
    expect(existsSync(join(outside, 'evil.md'))).toBe(false);
  });

  it('does not overwrite a symlinked file', async () => {
    const v = await clone();
    const target = join(tmp(), 'target.md');
    writeFileSync(target, 'precious');
    symlinkSync(target, join(v.mine, 'note.md'));
    await expect(
      writeVaultFile(v.mine, cmd({ path: 'note.md', mode: 'replace', content: 'x' }), IDENTITY),
    ).rejects.toThrow(/symlink/);
    expect(readFileSync(target, 'utf8')).toBe('precious');
  });
});

describe('vault.write section mode (docs/design/interests.md section 6)', () => {
  const TASTE = 'projects/toy/taste.md';
  const section = (version: number, rule: string) =>
    cmd({
      path: TASTE,
      mode: 'section',
      header: TASTE_HEADER,
      content: renderTasteSeedSection([{ text: rule, interestId: null }]),
      section: { id: 'seed', version },
      commitMessage: `aom: taste rules v${version}`,
    });

  it('creates the file with the header, inserts above rating lines, replaces a newer version and ignores stale or identical writes', async () => {
    const v = await clone();
    expect(await writeVaultFile(v.mine, section(1, 'First rule'), IDENTITY)).toEqual({
      written: true,
      committed: true,
    });
    const file = join(v.mine, TASTE);
    expect(readFileSync(file, 'utf8')).toContain('- Rule: First rule');
    // a rating line appended later stays below the managed block
    writeFileSync(file, `${readFileSync(file, 'utf8')}- Prefer articles like "x" (rated useful).\n`);
    sh(v.mine, 'git', ['commit', '-am', 'rating']);
    const head = sh(v.mine, 'git', ['rev-parse', 'HEAD']);
    // same version: nothing changes, no commit
    expect(await writeVaultFile(v.mine, section(1, 'First rule'), IDENTITY)).toEqual({
      written: false,
      committed: false,
    });
    // an older version is a no-op too
    expect(await writeVaultFile(v.mine, section(0, 'Old'), IDENTITY)).toEqual({
      written: false,
      committed: false,
    });
    expect(sh(v.mine, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    // a newer one replaces the block, never duplicates it
    expect(await writeVaultFile(v.mine, section(2, 'Second rule'), IDENTITY)).toEqual({
      written: true,
      committed: true,
    });
    const text = readFileSync(file, 'utf8');
    expect(text.match(/aom:section seed v=/g)).toHaveLength(1);
    expect(text).toContain('Second rule');
    expect(text).not.toContain('First rule');
    expect(text.indexOf('aom:section seed end')).toBeLessThan(text.indexOf('- Prefer articles'));
    expect(sh(v.mine, 'git', ['status', '--porcelain'])).toBe('');
  });
});
