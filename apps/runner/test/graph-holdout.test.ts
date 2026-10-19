import { join } from 'node:path';
import { type GraphScope, graphArmOf, graphHoldout } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { indexRepository } from '../src/graph/indexer.ts';
import { GraphService } from '../src/graph/service.ts';
import { makeGraphRepo } from './graph-fixtures.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

async function service() {
  const fx = makeGraphRepo();
  const out = tmp('aom-graph-holdout-');
  const vaultDir = join(out, 'vault');
  const svc = new GraphService({
    paths: { graphCache: join(out, 'cache') } as never,
    vaults: { vault: () => ({ vaultId: 'v1', storage: 'local' }), dir: () => vaultDir } as never,
    findRepo: async () => ({ localPath: fx.repo }),
    version: 't',
  });
  await indexRepository({
    repoPath: fx.repo,
    repoKey: fx.repoKey,
    repoName: 'fixture',
    graphDir: svc.graphDir(vaultDir, 'projects/toy'),
    cacheDir: svc.cacheDir,
    indexerVersion: 't',
  });
  return svc;
}

describe('the holdout arm of a card (design section 11)', () => {
  it('the assignment is stable per card: every shift of a card has the same arm, inside the window', () => {
    const start = new Date('2026-10-01T00:00:00Z');
    const ids = Array.from(
      { length: 200 },
      (_, i) => `0192f3a0-1111-7000-8000-${String(i).padStart(12, '0')}`,
    );
    for (const id of ids) {
      const arms = ['2026-10-02', '2026-10-09', '2026-10-20'].map((d) =>
        graphArmOf(id, start, new Date(`${d}T12:00:00Z`)),
      );
      expect(new Set(arms).size).toBe(1);
      expect(arms[0]).toBe(graphHoldout(id) ? 'off' : 'on');
    }
  });

  it('an off-arm card carries no graph verbs and no Graph context section; an on-arm card carries both', async () => {
    const svc = await service();
    const card = { title: 'Ledger total', fields: { affectedAreas: 'packages/core ledger' } };
    const scope = (arm: 'on' | 'off'): GraphScope => ({ vaultId: 'v1', folder: 'projects/toy', arm });
    const verbs: Array<[string, Record<string, unknown>]> = [
      ['graph.query', { text: 'ledger total' }],
      ['graph.explain', { node: 'Ledger.add' }],
      ['graph.impact', { node: 'format' }],
      ['graph.path', { a: 'format', b: 'Ledger.add' }],
    ];
    for (const [m, p] of verbs) {
      expect(svc.rpc(m, p, scope('off')), m).toMatchObject({ ok: false });
      expect(svc.rpc(m, p, undefined), m).toMatchObject({ ok: false });
      expect(svc.rpc(m, p, scope('on')), m).toMatchObject({ ok: true });
    }
    expect(svc.briefSection(scope('off'), card)).toBeNull();
    expect(svc.briefSection(undefined, card)).toBeNull();
    expect(svc.briefSection(scope('on'), card)).toContain('## Graph context');
  });
});
