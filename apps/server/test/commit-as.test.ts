import { checkOutboundLeaks, NO_COMMIT_IDENTITY_CODE, NO_COMMIT_IDENTITY_MESSAGE } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, DIFF_SMALL, hireTeam, pipeline, testPass } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

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

const url = () => `/api/projects/${w.projectId}/commit-as`;
const owner = (method: string, u: string, body?: unknown) =>
  w.t.req(method, u, { cookie: w.owner.cookie, body });
const ME = { name: 'Pieter Jordaan', email: 'pieter@example.test' };

describe('"Commit as" project setting (backlog #65)', () => {
  it('is empty by default, is set by an event, and can be cleared', async () => {
    expect(await ok<any>(owner('GET', url()))).toMatchObject({ commitAs: null });
    const set = await owner('PUT', url(), { commitAs: ME });
    expect(set.status).toBe(200);
    expect(set.body.commitAs).toEqual(ME);
    const events = await q(`SELECT payload FROM events WHERE type='ProjectCommitAsSet' ORDER BY seq`);
    expect(events.at(-1)?.payload).toMatchObject({ projectId: w.projectId, commitAs: ME });
    // the same value again appends nothing
    const n = events.length;
    await owner('PUT', url(), { commitAs: ME });
    expect((await q(`SELECT 1 FROM events WHERE type='ProjectCommitAsSet'`)).length).toBe(n);
    const cleared = await owner('PUT', url(), { commitAs: null });
    expect(cleared.body.commitAs).toBeNull();
    await owner('PUT', url(), { commitAs: ME });
  });

  it('validates the e-mail address and the name', async () => {
    expect((await owner('PUT', url(), { commitAs: { name: 'X', email: 'not-an-email' } })).status).toBe(400);
    expect((await owner('PUT', url(), { commitAs: { name: ' ', email: 'x@example.test' } })).status).toBe(
      400,
    );
    expect((await owner('PUT', url(), {})).status).toBe(400);
    expect((await ok<any>(owner('GET', url()))).commitAs).toEqual(ME);
  });

  it('only the project Owner (or an organization Owner or Admin) may change it', async () => {
    const stranger = await w.t.userSession(`stranger-${Date.now()}@example.test`);
    const denied = await w.t.req('PUT', url(), { cookie: stranger.cookie, body: { commitAs: ME } });
    expect(denied.status).toBeGreaterThanOrEqual(403);
    const readDenied = await w.t.req('GET', url(), { cookie: stranger.cookie });
    expect(readDenied.status).toBeGreaterThanOrEqual(403);
  });

  it('is rebuilt from events', async () => {
    await owner('PUT', url(), { commitAs: { name: 'Rebuilt Person', email: 'rebuilt@example.test' } });
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect((await ok<any>(owner('GET', url()))).commitAs).toEqual({
      name: 'Rebuilt Person',
      email: 'rebuilt@example.test',
    });
    await owner('PUT', url(), { commitAs: ME });
  });

  it('shows the identity each workstation clone would commit with, from the runner repo report', async () => {
    r.send('repos.report', {
      repos: [
        {
          remoteUrl: 'git@github.com:acme/toy.git',
          localPath: '/tmp/toy',
          headBranch: 'main',
          identity: { name: 'Workstation Owner', email: 'owner@example.test', source: 'global' },
        },
      ],
    });
    await r.barrier();
    await until(
      async () => {
        const c = (await ok<any>(owner('GET', url()))).clones;
        return c[0]?.identity?.source === 'global';
      },
      3000,
      'identity reported',
    );
    const c = (await ok<any>(owner('GET', url()))).clones;
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      repoName: 'toy',
      workstationId: w.workstationId,
      identity: { name: 'Workstation Owner', email: 'owner@example.test', source: 'global' },
    });
  });
});

describe('the setting reaches the runner', () => {
  it('shift.start and finalize.execute carry commitAs; the pull request reads as a person wrote it', async () => {
    await freshState();
    await owner('PUT', url(), { commitAs: ME });
    await hireTeam(w, { reviewers: ['Rex'] });
    const card = await w.card();
    const { start } = await p.run(
      'Bea',
      { kind: 'outcome', outcomeId: 'handoff', note: 'x', data: {} },
      DIFF_SMALL,
    );
    expect((start as any).commitAs).toEqual(ME);
    await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
    await p.run('Tess', testPass());
    expect((await cardRow(card.id)).stage).toBe('finalize');
    const from = r.received.length;
    await ok(w.t.req('POST', `/api/cards/${card.id}/finalize`, { cookie: w.owner.cookie, body: {} }));
    const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 5000, from);
    const payload = cmd.payload as any;
    expect(payload.commitAs).toEqual(ME);
    // no card ref, product name or agent in what a client reads
    expect(payload.prTitle).toBe(card.title);
    expect(payload.prBody).toBe(card.title);
    expect(`${payload.prTitle}\n${payload.prBody}`).not.toContain(card.ref);
    expect(checkOutboundLeaks(`${payload.prTitle}\n${payload.prBody}`).ok).toBe(true);
  });

  it('a shift without a project setting carries none', async () => {
    await freshState();
    await owner('PUT', url(), { commitAs: null });
    await hireTeam(w, { reviewers: ['Rex'] });
    await w.card();
    const { start } = await p.run(
      'Bea',
      { kind: 'outcome', outcomeId: 'handoff', note: 'x', data: {} },
      DIFF_SMALL,
    );
    expect((start as any).commitAs).toBeUndefined();
  });
});

describe('a runner that refuses to commit', () => {
  it('rejects the shift, tells the card, and raises one desk alert per workstation and project', async () => {
    await freshState();
    await hireTeam(w, { reviewers: ['Rex'] });
    const card = await w.card();
    const detail = `${NO_COMMIT_IDENTITY_CODE}: ${NO_COMMIT_IDENTITY_MESSAGE}`;
    await p.reject('Bea', 'internal', { detail });
    const said = await q(
      `SELECT 1 FROM thread_messages WHERE body LIKE '%Project settings > Commit as%' LIMIT 1`,
    );
    expect(said).toHaveLength(1);
    const alerts = await q(
      `SELECT title, body FROM desk_items WHERE subkind='no_commit_identity' AND status='open'`,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.body).toBe(NO_COMMIT_IDENTITY_MESSAGE);
  });
});
