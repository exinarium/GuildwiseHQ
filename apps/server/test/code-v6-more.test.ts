import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerBuiltins } from '../src/catalogue/boot.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import {
  designed,
  freshKeepDevops,
  handoffEv,
  hireLeanTeam,
  leanAttach,
  leanPipeline,
  planned,
  SHA1,
  SHA2,
  verdict,
} from './helpers/lean.ts';
import {
  cardRow,
  DIFF_SMALL,
  eventsOfType,
  handoff,
  hireTeam,
  pipeline,
  testPass,
} from './helpers/pipeline.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];

let w: World;
let r: FakeRunner;
let l: ReturnType<typeof leanPipeline>;
beforeAll(async () => {
  // v6 is not registered yet (before the release); the tests below activate it
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' }, integrationTests: 'off' });
  r = await w.connectRunner();
  l = leanPipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const call = (method: string, url: string, body?: unknown, status = 200) =>
  ok<any>(w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }), status);
const dispatcher = () => w.t.app.ctx.services.dispatcher;

// Code v6 reaches the projects the way v3 to v5 did: the resolver takes the newest ACTIVE version of `code`. The world starts
// without v6 (as before a release), so a card is created on v5; "activating" v6 is the release.
const activateV6 = () => registerBuiltins(w.t.app.ctx); // the server registers the missing code v6 at boot

describe('code v6 follows automatically, like v3 to v5: new cards take it, cards in flight keep their version', () => {
  it('a project on code v5 runs build, review and test as before, without evidence, a planner or a pre-review', async () => {
    await freshKeepDevops();
    const p = l;
    await hireTeam(w);
    const card = await w.card({ title: 'Legacy flow' });
    expect(card).toMatchObject({ workflowKey: 'code', workflowVersion: 5, stage: 'build' });
    await p.run('Bea', handoff(), DIFF_SMALL);
    // no evidence needed, no head SHA recorded, straight to the Opus review
    expect(await cardRow(card.id)).toMatchObject({ stage: 'review', head_sha: null, build_evidence: null });
    await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
    expect((await cardRow(card.id)).stage).toBe('test');
    await p.run('Tess', testPass());
    expect((await cardRow(card.id)).stage).toBe('finalize');
    expect((await cardRow(card.id)).owner_approval_required).toBeNull();
  });

  it('there is no upgrade step: the endpoint is gone (410), the project is not touched, and new cards run code v6', async () => {
    await freshKeepDevops();
    const p = l;
    await hireTeam(w);
    const inFlight = await w.card({ title: 'In flight before the release' });
    await p.run('Bea', handoff(), DIFF_SMALL);
    expect((await cardRow(inFlight.id)).stage).toBe('review');

    await activateV6(); // the release: code v6 is now the newest active version of `code`
    const before = (await q('SELECT count(*)::int AS n FROM events'))[0].n;
    const up = await w.t.req('POST', `/api/projects/${w.projectId}/upgrade-workflow`, {
      cookie: w.owner.cookie,
      body: {},
    });
    expect(up.status).toBe(410);
    expect((await q('SELECT count(*)::int AS n FROM events'))[0].n).toBe(before);

    // the project's detail says new cards are lean team; nothing was enabled next to its own workflow
    const detail = await call('GET', `/api/projects/${w.projectId}`);
    expect(detail.project).toMatchObject({ workflowKey: 'code', leanTeam: true });
    expect(await q(`SELECT workflow_key FROM project_workflows WHERE project_id=$1`, [w.projectId])).toEqual([
      { workflow_key: 'code' },
    ]);

    const fresh = await w.card({ title: 'After the release' });
    expect(fresh).toMatchObject({
      workflowKey: 'code',
      workflowVersion: 6,
      stage: 'planning',
      designNeeded: true,
    });
    // the card in flight is untouched and finishes on v5 (the classic upgrade at review approval never enters v6)
    const row = await cardRow(inFlight.id);
    expect(row.stage).toBe('review');
    const wf = await q(`SELECT key, version FROM workflow_versions WHERE id=$1`, [row.workflow_version_id]);
    expect(wf[0]).toMatchObject({ key: 'code', version: 5 });
    await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
    await p.run('Tess', testPass());
    const done = await cardRow(inFlight.id);
    expect(done.stage).toBe('finalize');
    expect(
      (await q(`SELECT version FROM workflow_versions WHERE id=$1`, [done.workflow_version_id]))[0].version,
    ).toBe(5);
  });
});

describe('a project created without a workflow takes the server default', () => {
  it('uses AOM_DEFAULT_WORKFLOW (code), which is the lean team flow; the legacy key is not offered', async () => {
    const proj = await call('POST', '/api/projects', { key: 'LEAN', name: 'Lean' }, 201);
    expect(proj.project).toMatchObject({ workflowKey: 'code', leanTeam: true });
    expect(w.t.app.ctx.config.defaultWorkflow).toBe('code');
    // the legacy key resolves to code, but a new project never ends up with a workflow of that name in the picker
    const wfs = await call('GET', '/api/workflows');
    expect(JSON.stringify(wfs)).not.toContain('code-v6');
  });

  it('the manual full suite starts one suite card at Test on the working branch', async () => {
    await freshKeepDevops();
    const res = await call('POST', `/api/projects/${w.projectId}/full-suite`, {}, 201);
    expect(res.ref).toMatch(/^TOY-/);
    const card = (await q('SELECT * FROM cards WHERE id=$1', [res.cardId]))[0]!;
    expect(card).toMatchObject({
      card_type: 'regression',
      origin: 'full_suite',
      stage: 'test',
      status: 'queued',
    });
    expect(card.fields).toMatchObject({ suiteBranch: 'main', platform: 'web' });
  });
});

describe('merge conflicts at Finalize in the lean team flow', () => {
  async function cardAtFinalize() {
    await freshKeepDevops();
    dispatcher().cooldown.clear();
    await hireLeanTeam(w);
    const card = await w.card({ title: 'Conflicting card' });
    await l.run('Pia', planned());
    await l.run('Arc', designed(card.ref));
    await l.runAt('Bea', handoffEv(), leanAttach(SHA1), SHA1);
    await l.runAt('Pre', verdict('approve'), {}, SHA1);
    await l.runAt('Rex', verdict('approve'), {}, SHA1);
    await dispatcher().run();
    await until(async () => (await cardRow(card.id)).stage === 'test', 5000, 'test deploy skipped');
    await l.runAt('Tess', testPass(), {}, SHA1);
    expect((await cardRow(card.id)).stage).toBe('finalize');
    return card;
  }
  const conflict = async (cardId: string) => {
    const from = r.received.length;
    await call('POST', `/api/cards/${cardId}/finalize`, {});
    const cmd = (await r.waitFor(
      'command',
      (f) => f.command === 'finalize.execute' && f.payload.cardId === cardId,
      5000,
      from,
    )) as any;
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: {
        ok: false,
        action: 'merge',
        conflict: true,
        conflictedFiles: ['src/a.ts'],
        error: 'conflict',
      },
    });
    await until(async () => (await cardRow(cardId)).park_problem === 'conflict', 5000, 'the card to be held');
  };

  it('holds the card in Finalize while DevOps resolves it in a scratch worktree, then sends the resolution to a merge review that keeps the approvals', async () => {
    const card = await cardAtFinalize();
    await conflict(card.id);
    let row = await cardRow(card.id);
    // not sent back to Build: it stays in Finalize, parked on DevOps' attempt
    expect(row).toMatchObject({
      stage: 'finalize',
      status: 'waiting',
      finalize_state: null,
    });
    expect(await eventsOfType('FinalizeConflictHeld')).toHaveLength(1);
    const req = (await q('SELECT * FROM devops_requests WHERE id=$1', [row.parked_request_id]))[0]!;
    expect(req.origin).toBe('conflict');
    expect(req.summary).toMatch(/SCRATCH worktree/);
    expect(req.summary).toMatch(/--ff-only/);

    await q(
      `UPDATE devops_requests SET status='done', result_summary='Resolved: kept both sides' WHERE id=$1`,
      [req.id],
    );
    await dispatcher().run();
    await until(
      async () => (await cardRow(card.id)).stage === 'merge_review',
      5000,
      'the card to reach the merge review',
    );
    row = await cardRow(card.id);
    expect(row.merge_review).toMatchObject({ oldHead: SHA1 });
    // approvals are not reset: nobody asked for a new review round
    expect((await eventsOfType('ReviewRequested')).filter((e) => e.cardId === card.id)).toHaveLength(1);

    // the reviewer reads the resolution; the branch is at the resolved commit now: the approvals follow it
    const rev = await l.runAt('Rex', verdict('approve'), {}, SHA2);
    expect(rev.start.brief.shift.stage).toBe('merge_review');
    expect(rev.start.brief.mergeReview).toMatchObject({ oldHead: SHA1 });
    row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'test_deploy', head_sha: SHA2 });
    expect(row.build_evidence).toMatchObject({ sha: SHA2, rebasedFrom: SHA1 });
    expect((await eventsOfType('CardHeadObserved')).at(-1)).toMatchObject({ source: 'conflict', sha: SHA2 });
  });

  it('a resolution the reviewer finds touched more than the merge goes back to Build for a full review', async () => {
    const card = await cardAtFinalize();
    await conflict(card.id);
    const row = await cardRow(card.id);
    await q(`UPDATE devops_requests SET status='done', result_summary='Resolved' WHERE id=$1`, [
      row.parked_request_id,
    ]);
    await dispatcher().run();
    await until(async () => (await cardRow(card.id)).stage === 'merge_review', 5000, 'merge review');
    await l.runAt('Rex', verdict('changes'), {}, SHA2);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'build', rework_round: 1, review_approvals: 0 });
  });

  it('a conflict DevOps could not resolve goes back to Build as before', async () => {
    const card = await cardAtFinalize();
    await conflict(card.id);
    const row = await cardRow(card.id);
    await q(`UPDATE devops_requests SET status='failed', result_summary='gave up' WHERE id=$1`, [
      row.parked_request_id,
    ]);
    await dispatcher().run();
    await until(async () => (await cardRow(card.id)).stage === 'build', 5000, 'back to Build');
    expect((await cardRow(card.id)).rework_round).toBeGreaterThan(0);
  });
});
