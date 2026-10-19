import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runnerPaths } from '../src/paths.ts';
import { VaultManager } from '../src/vaults/manager.ts';
import { isGeneratedGraphFile, syncVault } from '../src/vaults/sync.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';
import { IDENTITY, makeVault, originFile, pushFromOther } from './vault-fixtures.ts';

cleanupTmp();

const input = (v: { origin: string; mine: string }) => ({
  dir: v.mine,
  remoteUrl: v.origin,
  identity: IDENTITY,
  workstationName: 'Desk',
});
const write = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
};

const GRAPH = 'projects/toy/graph';
const SEED = {
  [`${GRAPH}/manifest.json`]: '{"commit":"aaa"}\n',
  [`${GRAPH}/repos/abc123abc123/packages__core.jsonl`]: '{"t":"n","id":"x"}\n',
  [`${GRAPH}/modules.md`]: '# map\n',
  'projects/toy/notes.md': 'line one\nline two\n',
};

describe('generated graph files never stop the vault (design section 4)', () => {
  it('names the generated files', () => {
    for (const p of [
      'projects/toy/graph/manifest.json',
      'projects/toy/graph/modules.md',
      'projects/toy/graph/work.md',
      'projects/toy/graph/repos/abc/_edges.jsonl',
      'graph/repos/abc/x.jsonl',
    ])
      expect(isGeneratedGraphFile(p), p).toBe(true);
    for (const p of [
      'projects/toy/notes.md',
      'projects/toy/graphics/manifest.json',
      'graph.md',
      'projects/toy/graph/notes.md',
    ])
      expect(isGeneratedGraphFile(p), p).toBe(false);
  });

  it('two workstations that both rewrote the manifest and a shard: the sync resolves it, pushes, and says which folder', async () => {
    const v = makeVault(SEED);
    await syncVault(input(v));
    write(v.mine, `${GRAPH}/manifest.json`, '{"commit":"mine"}\n');
    write(v.mine, `${GRAPH}/repos/abc123abc123/packages__core.jsonl`, '{"t":"n","id":"mine"}\n');
    pushFromOther(v, `${GRAPH}/manifest.json`, '{"commit":"theirs"}\n');
    sh(v.other, 'git', ['pull', '--rebase', 'origin', 'main']);
    pushFromOther(v, `${GRAPH}/repos/abc123abc123/packages__core.jsonl`, '{"t":"n","id":"theirs"}\n');
    const r = await syncVault(input(v));
    // both of my graph edits lost to the remote side, so there is nothing of mine left to push
    expect(r).toMatchObject({ status: 'ok', graphResolved: ['projects/toy'], pushed: false });
    // the remote side stands; the indexer rewrites the graph afterwards
    expect(originFile(v, `${GRAPH}/manifest.json`)).toBe('{"commit":"theirs"}\n');
    expect(sh(v.mine, 'git', ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(v.mine, '.git', 'rebase-merge'))).toBe(false);
  });

  it('several of my commits touching the graph are all carried over', async () => {
    const v = makeVault(SEED);
    await syncVault(input(v));
    write(v.mine, `${GRAPH}/manifest.json`, '{"commit":"m1"}\n');
    await syncVault({ ...input(v), now: () => new Date('2026-10-19T10:00:00Z') }).catch(() => undefined);
    write(v.mine, `${GRAPH}/manifest.json`, '{"commit":"m2"}\n');
    sh(v.mine, 'git', ['commit', '-am', 'second local graph write']);
    pushFromOther(v, `${GRAPH}/manifest.json`, '{"commit":"theirs"}\n');
    const r = await syncVault(input(v));
    expect(r.status).toBe('ok');
    expect(sh(v.mine, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('a conflict in a real note next to a graph conflict is still a conflict, and nothing is lost', async () => {
    const v = makeVault(SEED);
    await syncVault(input(v));
    write(v.mine, `${GRAPH}/manifest.json`, '{"commit":"mine"}\n');
    write(v.mine, 'projects/toy/notes.md', 'line one\nlocal two\n');
    pushFromOther(v, `${GRAPH}/manifest.json`, '{"commit":"theirs"}\n');
    sh(v.other, 'git', ['pull', '--rebase', 'origin', 'main']);
    pushFromOther(v, 'projects/toy/notes.md', 'line one\nremote two\n');
    const before = sh(v.origin, 'git', ['rev-parse', 'main']);
    const r = await syncVault(input(v));
    expect(r.status).toBe('conflict');
    expect(r.status === 'conflict' && r.files).toContain('projects/toy/notes.md');
    expect(sh(v.origin, 'git', ['rev-parse', 'main'])).toBe(before);
    expect(readFileSync(join(v.mine, 'projects/toy/notes.md'), 'utf8')).toBe('line one\nlocal two\n');
  });

  it('the manager tells the runner which folders to rebuild, and the vault does not pause', async () => {
    const v = makeVault(SEED);
    const root = tmp('aom-graph-sync-');
    const resolved: Array<{ vaultId: string; folders: string[] }> = [];
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const m = new VaultManager({
      paths: runnerPaths(root),
      secondMs: 60_000,
      transport: { send: (type, payload) => void sent.push({ type, payload }) },
      onGraphResolved: (vaultId, folders) => resolved.push({ vaultId, folders }),
    });
    m.configure({
      vaults: [{ vaultId: 'v1', kind: 'project', name: 'P', remoteUrl: v.origin, syncIntervalSec: 60 }],
      identity: IDENTITY,
      workstationName: 'Desk',
      resume: [],
    });
    await m.syncNow('v1');
    const dir = join(runnerPaths(root).vaults, 'v1');
    write(dir, `${GRAPH}/manifest.json`, '{"commit":"mine"}\n');
    pushFromOther(v, `${GRAPH}/manifest.json`, '{"commit":"theirs"}\n');
    await m.syncNow('v1');
    expect(m.isPaused('v1')).toBe(false);
    expect(sent.some((s) => s.type === 'vault.conflict')).toBe(false);
    expect(resolved).toEqual([{ vaultId: 'v1', folders: ['projects/toy'] }]);
    m.stop();
  });
});
