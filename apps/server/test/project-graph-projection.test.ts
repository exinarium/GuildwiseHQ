import { graphRepoKey } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateGraphBackfill } from '../src/data-migrations/graph-backfill.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_PROJECT_GRAPHS: 'true', AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  r?.close();
  await w.t.close();
  await closeAdminPool();
});

const rk = graphRepoKey('github.com/acme/toy');
const graphCommands = () =>
  r
    .of('command')
    .filter((c) => c.command === 'graph.index' || c.command === 'graph.update')
    .map((c) => ({ id: c.commandId, name: c.command, payload: c.payload as any }));
const graphRow = async () => (await q('SELECT * FROM project_graphs WHERE project_id=$1', [w.projectId]))[0];
const owner = (url: string, method = 'GET', body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, ...(body === undefined ? {} : { body }) });

describe('project graph status (design sections 1, 5 and 13: status only, never content)', () => {
  it('the owner workstation connecting with the clone is asked to index it into the project vault', async () => {
    r = await w.connectRunner();
    await until(async () => graphCommands().length === 1, 4000, 'graph.index');
    const [cmd] = graphCommands();
    expect(cmd!.name).toBe('graph.index');
    const [vault] = await q('SELECT id, storage FROM vaults WHERE project_id=$1', [w.projectId]);
    expect(cmd!.payload).toMatchObject({
      projectId: w.projectId,
      repoId: w.repoId,
      repoKey: rk,
      remoteUrlNormalized: 'github.com/acme/toy',
      projectKey: 'TOY',
      vault: { vaultId: vault!.id, storage: 'local', kind: 'project', folder: 'projects/toy' },
    });
    const row = await graphRow();
    expect(row).toMatchObject({ status: 'requested', repo_key: rk });
    const events = await q(`SELECT payload FROM events WHERE type='ProjectGraphRequested'`);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.reason).toBe('attached');
    // a second hello does not queue a second command while one waits
    r.close();
    r = await w.connectRunner();
    await r.barrier();
    expect(
      await q(`SELECT 1 FROM runner_commands WHERE type='graph.index' AND status IN ('pending','sent')`),
    ).toHaveLength(1);
  });

  it('the runner answer becomes status: a commit, counts, the indexer version; the API shows exactly that', async () => {
    const [cmd] = graphCommands();
    r.send('command.result', {
      commandId: cmd!.id,
      ok: true,
      result: {
        ok: true,
        commit: 'a'.repeat(40),
        files: 12,
        nodes: 340,
        edges: 800,
        modules: 3,
        indexerVersion: '0.1.32',
        durationMs: 1234,
        // anything else the runner might add is not stored
        symbolNames: ['secretFunction', 'internalBilling'],
      },
    });
    await until(async () => (await graphRow())?.status === 'indexed', 4000, 'indexed');
    expect(await graphRow()).toMatchObject({
      commit_id: 'a'.repeat(40),
      files: 12,
      nodes: 340,
      edges: 800,
      modules: 3,
      indexer_version: '0.1.32',
      duration_ms: 1234,
      workstation_id: w.workstationId,
    });
    const ev = (await q(`SELECT payload FROM events WHERE type='ProjectGraphIndexed'`))[0]!.payload;
    expect(Object.keys(ev).sort()).toEqual(
      [
        'commit',
        'durationMs',
        'edges',
        'files',
        'indexerVersion',
        'modules',
        'nodes',
        'orgId',
        'projectId',
        'repoId',
        'repoKey',
        'vaultId',
        'workstationId',
      ].sort(),
    );
    // no name, path or label of any kind reaches the log or the table
    const dump =
      JSON.stringify(await q('SELECT * FROM project_graphs')) +
      JSON.stringify(await q(`SELECT payload FROM events WHERE type LIKE 'ProjectGraph%'`));
    expect(dump).not.toContain('secretFunction');
    const status = await ok<any>(owner(`/api/projects/${w.projectId}/graph`));
    expect(status).toMatchObject({
      enabled: true,
      vault: { storage: 'local', kind: 'project' },
      repos: [
        { repoId: w.repoId, status: 'indexed', commit: 'a'.repeat(40), nodes: 340, edges: 800, modules: 3 },
      ],
    });
  });

  it('a failure carries a fixed reason code; a later failure never hides an index that exists', async () => {
    const res = await owner(`/api/projects/${w.projectId}/graph/index`, 'POST');
    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(1);
    await until(async () => graphCommands().length === 2, 4000, 'second graph.index');
    r.send('command.result', {
      commandId: graphCommands()[1]!.id,
      ok: true,
      result: { ok: false, reason: 'no_clone' },
    });
    await until(
      async () => (await q(`SELECT 1 FROM events WHERE type='ProjectGraphFailed'`)).length === 1,
      4000,
      'failed event',
    );
    const row = await graphRow();
    expect(row).toMatchObject({ status: 'indexed', fail_reason: 'no_clone' });
    // free text from a runner is not accepted as a reason: it becomes the generic one
    await owner(`/api/projects/${w.projectId}/graph/index`, 'POST');
    await until(async () => graphCommands().length === 3, 4000, 'third graph.index');
    r.send('command.result', {
      commandId: graphCommands()[2]!.id,
      ok: true,
      result: { ok: false, reason: '/home/me/secret/path.ts' },
    });
    await until(
      async () => (await q(`SELECT 1 FROM events WHERE type='ProjectGraphFailed'`)).length === 2,
      4000,
      'second failure',
    );
    expect(
      (await q(`SELECT payload FROM events WHERE type='ProjectGraphFailed' ORDER BY seq DESC LIMIT 1`))[0]!
        .payload.reason,
    ).toBe('error');
  });

  it('only the project owner can ask for a new index; members see the status', async () => {
    const other = await w.t.userSession('graph-outsider@example.test');
    expect(
      (await w.t.req('GET', `/api/projects/${w.projectId}/graph`, { cookie: other.cookie })).status,
    ).toBe(404);
    expect(
      (await w.t.req('POST', `/api/projects/${w.projectId}/graph/index`, { cookie: other.cookie })).status,
    ).toBe(404);
  });

  it('a projection rebuild reproduces the status rows from the events', async () => {
    const before = await q('SELECT * FROM project_graphs ORDER BY repo_id');
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    const after = await q('SELECT * FROM project_graphs ORDER BY repo_id');
    const pick = (rows: any[]) =>
      rows.map(
        ({ status, commit_id, files, nodes, edges, modules, indexer_version, fail_reason, repo_key }) => ({
          status,
          commit_id,
          files,
          nodes,
          edges,
          modules,
          indexer_version,
          fail_reason,
          repo_key,
        }),
      );
    expect(pick(after)).toEqual(pick(before));
  });

  it('the backfill data migration records one request per repository without a graph, once', async () => {
    await q('DELETE FROM project_graphs');
    const env = { pool: w.t.app.ctx.pool, store: w.t.app.ctx.store, clock: w.t.clock, log: () => {} } as any;
    expect(await migrateGraphBackfill({ ...env, projectGraphs: false })).toBeNull();
    expect(await migrateGraphBackfill(env)).toEqual({ requested: 1 });
    expect(await migrateGraphBackfill(env)).toBeNull();
    const reqs = await q(
      `SELECT payload FROM events WHERE type='ProjectGraphRequested' AND payload->>'reason'='backfill'`,
    );
    expect(reqs).toHaveLength(1);
    expect((await graphRow())?.status).toBe('requested');
  });
});

describe('with the setting off (the default of the other suites) nothing is requested', () => {
  it('has no way to queue an index', async () => {
    const { requestProjectGraph } = await import('../src/commands/graph.ts');
    const cfg = w.t.app.ctx.config;
    const was = cfg.projectGraphs.enabled;
    cfg.projectGraphs.enabled = false;
    try {
      expect(await requestProjectGraph(w.t.app.ctx, w.projectId, w.repoId, 'manual')).toBe(false);
    } finally {
      cfg.projectGraphs.enabled = was;
    }
  });
});
