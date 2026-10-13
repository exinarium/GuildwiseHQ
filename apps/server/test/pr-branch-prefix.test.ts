import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prBranchTicket } from '../src/commands/finalize.ts';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, DIFF_SMALL, hireTeam, pipeline, testPass } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  p = pipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const patch = (body: unknown, status = 200) =>
  ok<any>(w.t.req('PATCH', `/api/projects/${w.projectId}`, { cookie: w.owner.cookie, body }), status);
const project = async () =>
  (await ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: w.owner.cookie }))).project;

async function cardAtFinalize() {
  await freshState();
  await hireTeam(w, { reviewers: ['Rex', 'Ria'] });
  const card = await w.card();
  await p.run('Bea', { kind: 'outcome', outcomeId: 'handoff', note: 'x', data: {} }, DIFF_SMALL);
  await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
  await p.run('Tess', testPass());
  expect((await cardRow(card.id)).stage).toBe('finalize');
  return card;
}

describe('pull request branch prefix', () => {
  it('is a project setting: empty by default, saved, validated', async () => {
    expect((await project()).prBranchPrefix).toBe('');
    await patch({ prBranchPrefix: 'pieter' });
    expect((await project()).prBranchPrefix).toBe('pieter');
    await patch({ prBranchPrefix: 'team/pieter' });
    for (const bad of ['a b', '/x', 'x/', 'a..b', 'x'.repeat(41), 'a:b', '-x'])
      await patch({ prBranchPrefix: bad }, 400);
    expect((await project()).prBranchPrefix).toBe('team/pieter');
    await patch({ prBranchPrefix: '' });
    expect((await project()).prBranchPrefix).toBe('');
  });

  it('a non-manager cannot change it', async () => {
    const other = await w.t.userSession(uniqueEmail('stranger'));
    const res = await w.t.req('PATCH', `/api/projects/${w.projectId}`, {
      cookie: other.cookie,
      body: { prBranchPrefix: 'evil' },
    });
    expect([401, 403, 404]).toContain(res.status);
    expect((await project()).prBranchPrefix).toBe('');
  });

  it('survives a projection rebuild', async () => {
    await patch({ prBranchPrefix: 'pieter' });
    const before = (await q('SELECT pr_branch_prefix FROM projects WHERE id=$1', [w.projectId]))[0];
    expect(PROJECTION_TABLES).toContain('projects');
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    const after = (await q('SELECT pr_branch_prefix FROM projects WHERE id=$1', [w.projectId]))[0];
    expect(after).toEqual(before);
    expect(after?.pr_branch_prefix).toBe('pieter');
    await patch({ prBranchPrefix: '' });
  });

  it('the ticket is the tracker key, else the card ref', () => {
    expect(prBranchTicket('DCPL-4276', 'P4-3')).toBe('DCPL-4276');
    expect(prBranchTicket(null, 'P4-3')).toBe('P4-3');
    expect(prBranchTicket('acme/repo#12', 'P4-3')).toBe('P4-3');
  });

  it('finalize.execute carries the prefix (default feature) and the ticket', async () => {
    const card = await cardAtFinalize();
    const from = r.received.length;
    await ok<any>(
      w.t.req('POST', `/api/cards/${card.id}/finalize`, { cookie: w.owner.cookie, body: { action: 'pr' } }),
    );
    const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 5000, from);
    expect(cmd.payload).toMatchObject({ prBranchPrefix: 'feature', ticket: card.ref });
    expect((cmd.payload as any).remoteBranch).toBeUndefined();
  });

  it('uses the project prefix and a branch pushed earlier, so rework updates the same pull request', async () => {
    await patch({ prBranchPrefix: 'pieter' });
    const card = await cardAtFinalize();
    await q(`UPDATE cards SET finalize_result = $2::jsonb WHERE id=$1`, [
      card.id,
      JSON.stringify({ pushedBranch: 'pieter/OLD-1', prUrl: 'https://example.test/pr/1' }),
    ]);
    const from = r.received.length;
    await ok<any>(
      w.t.req('POST', `/api/cards/${card.id}/finalize`, { cookie: w.owner.cookie, body: { action: 'pr' } }),
    );
    const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 5000, from);
    expect(cmd.payload).toMatchObject({
      prBranchPrefix: 'pieter',
      ticket: card.ref,
      remoteBranch: 'pieter/OLD-1',
    });
    await patch({ prBranchPrefix: '' });
  });
});
