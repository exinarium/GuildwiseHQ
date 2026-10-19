import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexRepository } from '../src/graph/indexer.ts';
import { loadGraph } from '../src/graph/load.ts';
import { GraphIndex } from '../src/graph/query.ts';
import { GraphService } from '../src/graph/service.ts';
import { readManifest } from '../src/graph/store.ts';
import { updateRepository } from '../src/graph/update.ts';
import { makeGraphRepo, writeFiles } from './graph-fixtures.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';

cleanupTmp();

function tree(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(p).isDirectory()) Object.assign(out, tree(p, r));
    else out[r] = readFileSync(p, 'utf8');
  }
  return out;
}
/** The graph shards (nodes and edges), the part an update must reproduce exactly. */
const shards = (graphDir: string): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tree(graphDir)).filter(([k]) => k.endsWith('.jsonl') && !k.endsWith('_work.jsonl')),
  );

const base = (fx: { repo: string; repoKey: string }, out: string) => ({
  repoPath: fx.repo,
  repoKey: fx.repoKey,
  repoName: 'fixture',
  graphDir: join(out, 'graph'),
  cacheDir: join(out, 'cache'),
  indexerVersion: 'test',
  now: () => new Date('2026-10-19T10:00:00Z'),
});

/** What a merge does to the fixture: a new call into an unchanged file, a removed symbol, a new file, a deleted file. */
function mergeChanges(repo: string): string {
  writeFiles(repo, {
    'packages/core/src/money.ts':
      'export function format(n: number): string { return String(n); }\nexport function round(n: number) { return Math.round(n); }\nexport class Money { constructor(public n: number) {} }\n',
    'packages/core/src/ledger.ts':
      "import { format, round } from './money.js';\nexport class Ledger {\n  add(n: number) { return format(round(n)); }\n  total() { return this.add(1); }\n}\n",
    'py/app/extra.py': 'from .models import User\n\ndef extra():\n    return User()\n',
  });
  rmSync(join(repo, 'apps/web/src/dup2.ts'));
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['commit', '-m', 'merge TOY-5']);
  return sh(repo, 'git', ['rev-parse', 'HEAD']);
}

describe('incremental update on merge (design section 6)', () => {
  it('an update gives the shards of a full index of the same commit, and parses only the changed files', async () => {
    const fx = makeGraphRepo();
    const a = tmp('aom-graph-upd-a-');
    await indexRepository(base(fx, a));
    const head = mergeChanges(fx.repo);
    const u = await updateRepository({ ...base(fx, a), toCommit: head });
    expect(u).toMatchObject({ fullReindex: false, filesChanged: 4, commit: head, communitiesReused: true });
    expect(u.fromCommit).toBe(fx.commit);
    expect(u.cacheMisses).toBe(3); // money.ts, ledger.ts and the new py file; the deleted file is not read
    const b = tmp('aom-graph-upd-b-');
    await indexRepository({ ...base(fx, b), commit: head });
    expect(shards(join(a, 'graph'))).toEqual(shards(join(b, 'graph')));
    // the new call into the unchanged file, and the link that a removed file took with it
    const g = new GraphIndex(loadGraph(join(a, 'graph')) as NonNullable<ReturnType<typeof loadGraph>>);
    expect(g.impact('round', 1)).toMatch(/Ledger\.add/);
    expect(g.explain('use')).toMatch(/--calls\[[EIA]\]--> helper/);
    expect(g.explain('use')).not.toContain('candidates'); // only one helper is left, so it is no longer ambiguous
    expect(readManifest(join(a, 'graph'))?.repos[0]).toMatchObject({
      commit: head,
      mergesSinceCommunities: 1,
    });
  });

  it('records the card in the work layer: the modules the merge touched, never a body', async () => {
    const fx = makeGraphRepo();
    const out = tmp('aom-graph-work-');
    await indexRepository(base(fx, out));
    const head = mergeChanges(fx.repo);
    await updateRepository({
      ...base(fx, out),
      toCommit: head,
      work: { ref: 'TOY-5', title: 'Round the total', at: '2026-10-19T11:00:00.000Z', paths: [] },
    });
    const work = readFileSync(join(out, 'graph', 'repos', fx.repoKey, '_work.jsonl'), 'utf8');
    expect(JSON.parse(work.trim())).toMatchObject({
      t: 'w',
      ref: 'TOY-5',
      title: 'Round the total',
      commit: head,
      mods: ['apps/web', 'packages/core', 'py'],
    });
    const md = readFileSync(join(out, 'graph', 'work.md'), 'utf8');
    expect(md).toContain('### `packages/core`');
    expect(md).toContain(`- TOY-5 Round the total (${head.slice(0, 7)}, 2026-10-19)`);
    const g = new GraphIndex(loadGraph(join(out, 'graph')) as NonNullable<ReturnType<typeof loadGraph>>);
    expect(g.query('TOY-5 round total').text).toMatch(/card TOY-5 Round the total/);
    expect(g.explain('packages/core')).toMatch(/touches\[E\]/);
    // a full index later keeps what landed
    await indexRepository({ ...base(fx, out) });
    expect(readFileSync(join(out, 'graph', 'repos', fx.repoKey, '_work.jsonl'), 'utf8')).toBe(work);
    // the same merge reported twice is one entry, and its modules are kept
    await updateRepository({
      ...base(fx, out),
      toCommit: head,
      work: { ref: 'TOY-5', title: 'Round the total', at: '2026-10-19T11:00:00.000Z', paths: [] },
    });
    expect(readFileSync(join(out, 'graph', 'repos', fx.repoKey, '_work.jsonl'), 'utf8')).toBe(work);
  });

  it('a force-push (the recorded commit is no ancestor) is a full index', async () => {
    const fx = makeGraphRepo();
    const out = tmp('aom-graph-force-');
    await indexRepository(base(fx, out));
    // rewrite history: the branch moves to a commit that does not contain the old one
    sh(fx.repo, 'git', ['checkout', '--orphan', 'rewritten']);
    sh(fx.repo, 'git', ['rm', '-rf', '--quiet', '.']);
    writeFiles(fx.repo, { 'lib/only.py': 'def only():\n    return 1\n' });
    sh(fx.repo, 'git', ['add', '-A']);
    sh(fx.repo, 'git', ['commit', '-m', 'rewritten history']);
    const head = sh(fx.repo, 'git', ['rev-parse', 'HEAD']);
    const u = await updateRepository({ ...base(fx, out), toCommit: head });
    expect(u.fullReindex).toBe(true);
    expect(u.fromCommit).toBe(fx.commit);
    const b = tmp('aom-graph-force-b-');
    await indexRepository({ ...base(fx, b), commit: head });
    expect(shards(join(out, 'graph'))).toEqual(shards(join(b, 'graph')));
    expect(Object.keys(shards(join(out, 'graph'))).some((k) => k.includes('apps__web'))).toBe(false); // the old modules are gone
  });

  it('no graph yet, or a commit this clone does not have: a full index', async () => {
    const fx = makeGraphRepo();
    const out = tmp('aom-graph-none-');
    const u = await updateRepository({ ...base(fx, out), toCommit: fx.commit });
    expect(u).toMatchObject({ fullReindex: true, commit: fx.commit });
    expect(u.fromCommit).toBeUndefined();
    const out2 = tmp('aom-graph-unknown-');
    await indexRepository(base(fx, out2));
    const missing = 'f'.repeat(40);
    const u2 = await updateRepository({ ...base(fx, out2), toCommit: missing });
    expect(u2).toMatchObject({ fullReindex: true, commit: fx.commit }); // indexed at the branch head instead
  });

  it('an update to the commit that is already indexed changes nothing', async () => {
    const fx = makeGraphRepo();
    const out = tmp('aom-graph-same-');
    await indexRepository(base(fx, out));
    const before = tree(join(out, 'graph'));
    const u = await updateRepository({ ...base(fx, out), toCommit: fx.commit });
    expect(u).toMatchObject({ written: 0, fullReindex: false, filesChanged: 0 });
    expect(tree(join(out, 'graph'))).toEqual(before);
  });

  it('the communities are kept for a few merges and recomputed every N', async () => {
    const fx = makeGraphRepo();
    const out = tmp('aom-graph-comm-');
    await indexRepository(base(fx, out));
    const comm = () =>
      JSON.parse(readFileSync(join(out, 'graph', 'repos', fx.repoKey, 'communities.json'), 'utf8')) as {
        commit: string;
      };
    expect(comm().commit).toBe(fx.commit);
    const heads: string[] = [];
    for (let i = 1; i <= 3; i++) {
      writeFiles(fx.repo, { [`py/app/m${i}.py`]: `def m${i}():\n    return ${i}\n` });
      sh(fx.repo, 'git', ['add', '-A']);
      sh(fx.repo, 'git', ['commit', '-m', `merge ${i}`]);
      heads.push(sh(fx.repo, 'git', ['rev-parse', 'HEAD']));
    }
    const u1 = await updateRepository({ ...base(fx, out), toCommit: heads[0] as string, communityEvery: 3 });
    expect(u1.communitiesReused).toBe(true);
    expect(comm().commit).toBe(fx.commit); // the manifest of the communities notes the commit they were computed at
    const u2 = await updateRepository({ ...base(fx, out), toCommit: heads[1] as string, communityEvery: 3 });
    expect(u2.communitiesReused).toBe(true);
    const u3 = await updateRepository({ ...base(fx, out), toCommit: heads[2] as string, communityEvery: 3 });
    expect(u3.communitiesReused).toBe(false); // the third merge recomputes
    expect(comm().commit).toBe(heads[2]);
    expect(readManifest(join(out, 'graph'))?.repos[0]?.mergesSinceCommunities).toBe(0);
  });
});

describe('GraphService: graph.update and the rebuild after a vault conflict', () => {
  function service(out: string) {
    const vaultDir = join(out, 'vault');
    const synced: string[] = [];
    const vaults = {
      vault: (id: string) => (id === 'v1' ? { vaultId: 'v1', storage: 'local' } : undefined),
      dir: () => vaultDir,
      exclusive: async <T>(_id: string, fn: (d: string) => Promise<T>) => fn(vaultDir),
      syncNow: async (id: string) => void synced.push(id),
    };
    const svc = new GraphService({
      paths: { graphCache: join(out, 'cache') } as never,
      vaults: vaults as never,
      findRepo: async () => ({ localPath: repoPath }),
      version: '0.1.32',
    });
    let repoPath = '';
    return { svc, vaultDir, setRepo: (p: string) => (repoPath = p), synced };
  }
  const payload = (fx: { repoKey: string }, extra: Record<string, unknown> = {}) => ({
    projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
    repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a2',
    repoKey: fx.repoKey,
    remoteUrlNormalized: 'github.com/acme/fixture',
    repoName: 'fixture',
    projectKey: 'TOY',
    workingBranch: 'main',
    vault: { vaultId: 'v1', storage: 'local' as const, kind: 'project' as const, folder: 'projects/toy' },
    ...extra,
  });

  it('answers graph.update with the counts, the old commit and whether it fell back', async () => {
    const fx = makeGraphRepo();
    const out = tmp('aom-graph-svc-');
    const { svc, setRepo } = service(out);
    setRepo(fx.repo);
    const first = await svc.update(payload(fx)); // no toCommit: a full index
    expect(first).toMatchObject({ ok: true, commit: fx.commit });
    const head = mergeChanges(fx.repo);
    const r = await svc.update(
      payload(fx, {
        toCommit: head,
        fromCommit: fx.commit,
        merge: { ref: 'TOY-5', title: 'Round', at: '2026-10-19T11:00:00.000Z' },
      }),
    );
    expect(r).toMatchObject({
      ok: true,
      commit: head,
      fromCommit: fx.commit,
      filesChanged: 4,
      fullReindex: false,
      indexerVersion: '0.1.32',
    });
    // the answer to the server has counts and commits only
    expect(Object.keys(r).sort()).toEqual(
      [
        'commit',
        'durationMs',
        'edges',
        'filesChanged',
        'files',
        'fromCommit',
        'fullReindex',
        'indexerVersion',
        'modules',
        'nodes',
        'ok',
      ].sort(),
    );
  });

  it('regenerate rebuilds the graph of a folder from the saved request, without the server', async () => {
    const fx = makeGraphRepo();
    const out = tmp('aom-graph-regen-');
    const { svc, setRepo, vaultDir } = service(out);
    setRepo(fx.repo);
    await svc.index(payload(fx));
    const manifest = join(vaultDir, 'projects/toy/graph/manifest.json');
    rmSync(manifest);
    expect(await svc.regenerate('v1', ['projects/other'])).toBe(0);
    expect(await svc.regenerate('v1', ['projects/toy'])).toBe(1);
    expect(existsSync(manifest)).toBe(true);
  });
});
