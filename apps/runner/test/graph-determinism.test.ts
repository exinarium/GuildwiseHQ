import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexRepository } from '../src/graph/indexer.ts';
import { readManifest } from '../src/graph/store.ts';
import { FIXTURE_FILES, makeGraphRepo, writeFiles } from './graph-fixtures.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';

cleanupTmp();

function tree(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(p).isDirectory()) Object.assign(out, tree(p, r));
    else out[r] = readFileSync(p, 'utf8');
  }
  return out;
}

async function run(
  repo: string,
  repoKey: string,
  graphDir: string,
  cacheDir: string,
  over: Record<string, unknown> = {},
) {
  return indexRepository({
    repoPath: repo,
    repoKey,
    repoName: 'fixture',
    graphDir,
    cacheDir,
    indexerVersion: 'test-1',
    now: () => new Date('2026-10-19T10:00:00Z'),
    ...over,
  });
}

describe('the graph is deterministic (design sections 4 and 14)', () => {
  it('the same commit gives identical bytes in two vaults, with a cold and a warm cache', async () => {
    const fx = makeGraphRepo();
    const a = tmp('aom-graph-a-');
    const b = tmp('aom-graph-b-');
    await run(fx.repo, fx.repoKey, join(a, 'graph'), join(a, 'cache'));
    await run(fx.repo, fx.repoKey, join(b, 'graph'), join(b, 'cache'));
    const ta = tree(join(a, 'graph'));
    const tb = tree(join(b, 'graph'));
    expect(Object.keys(ta).length).toBeGreaterThan(5);
    expect(ta).toEqual(tb);
    // warm cache, later clock: nothing changes (an unchanged commit makes no commit in the vault)
    const warm = await run(fx.repo, fx.repoKey, join(a, 'graph'), join(a, 'cache'), {
      now: () => new Date('2027-01-01T00:00:00Z'),
    });
    expect(warm.written).toBe(0);
    expect(warm.cacheMisses).toBe(0);
    expect(tree(join(a, 'graph'))).toEqual(ta);
  });

  it('no file holds an absolute path of this machine, and no id carries one', async () => {
    const fx = makeGraphRepo();
    const out = tmp('aom-graph-abs-');
    await run(fx.repo, fx.repoKey, join(out, 'graph'), join(out, 'cache'));
    for (const [name, text] of Object.entries(tree(join(out, 'graph')))) {
      expect(text, name).not.toContain(fx.repo);
      expect(text, name).not.toContain(out);
      expect(text, name).not.toContain(homedir());
      expect(text, name).not.toMatch(/"(id|f|to|p)":"(\/|[A-Za-z]:\\)/);
    }
    // ids are `<repoKey>:<relative path>#...` once the repo key is added back
    const shard = readFileSync(join(out, 'graph', 'repos', fx.repoKey, 'packages__core.jsonl'), 'utf8');
    expect(shard).toContain('"id":"packages/core/src/money.ts#file:packages/core/src/money.ts"');
  });

  it('a one-file change rewrites only that module shard', async () => {
    const fx = makeGraphRepo();
    const out = tmp('aom-graph-diff-');
    const graphDir = join(out, 'graph');
    await run(fx.repo, fx.repoKey, graphDir, join(out, 'cache'));
    const before = tree(graphDir);
    writeFiles(fx.repo, {
      'py/app/models.py':
        'class User:\n    def name(self):\n        return "x"\n    def email(self):\n        return "y"\n',
    });
    sh(fx.repo, 'git', ['commit', '-am', 'add a method']);
    const r = await run(fx.repo, fx.repoKey, graphDir, join(out, 'cache'));
    const after = tree(graphDir);
    const changed = Object.keys(after).filter((k) => before[k] !== after[k]);
    // the summaries and the manifest carry the commit; of the graph shards only the changed module's moves
    expect(changed.filter((k) => k.endsWith('.jsonl'))).toEqual([`repos/${fx.repoKey}/py.jsonl`]);
    expect(changed).toContain('manifest.json');
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(r.cacheMisses).toBe(1); // only the changed file was parsed again
  });

  it('records the commit, counts and indexer in the manifest, never a path', async () => {
    const fx = makeGraphRepo();
    const out = tmp('aom-graph-man-');
    const r = await run(fx.repo, fx.repoKey, join(out, 'graph'), join(out, 'cache'));
    const m = readManifest(join(out, 'graph'));
    expect(m?.indexerVersion).toBe('test-1');
    expect(m?.repos[0]).toMatchObject({
      repoKey: fx.repoKey,
      commit: fx.commit,
      files: r.files,
      nodes: r.nodes,
      symbolsInVault: true,
    });
    expect(m?.repos[0]?.skipped).toMatchObject({ sensitive: 3, vendor: 2 });
  });

  it('a repository over the export cap keeps its modules in the vault and its shards in the runner cache', async () => {
    const fx = makeGraphRepo();
    const out = tmp('aom-graph-cap-');
    const graphDir = join(out, 'graph');
    const cacheDir = join(out, 'cache');
    const r = await run(fx.repo, fx.repoKey, graphDir, cacheDir, { maxExportNodes: 10 });
    expect(r.symbolsInVault).toBe(false);
    const files = Object.keys(tree(graphDir)).sort();
    expect(files).toEqual(
      [
        'manifest.json',
        'modules.md',
        `repos/${fx.repoKey}/_repo.jsonl`,
        `repos/${fx.repoKey}/communities.json`,
        `repos/${fx.repoKey}/modules.md`,
      ].sort(),
    );
    expect(existsSync(join(cacheDir, fx.repoKey, 'shards', 'repos', fx.repoKey, 'apps__web.jsonl'))).toBe(
      true,
    );
  });

  it('a project with two repositories keeps both in one manifest and one summary', async () => {
    const one = makeGraphRepo();
    const two = makeGraphRepo({ 'lib/a.py': 'def a():\n    return 1\n' });
    const out = tmp('aom-graph-two-');
    const graphDir = join(out, 'graph');
    await run(one.repo, 'aaaaaaaaaaaa', graphDir, join(out, 'cache'));
    await run(two.repo, 'bbbbbbbbbbbb', graphDir, join(out, 'cache'));
    expect(readManifest(graphDir)?.repos.map((r) => r.repoKey)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
    const summary = readFileSync(join(graphDir, 'modules.md'), 'utf8');
    expect(summary).toContain('aaaaaaaaaaaa');
    expect(summary).toContain('bbbbbbbbbbbb');
    expect(FIXTURE_FILES['.env']).toBeTruthy();
  });
});
