import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  // a project on the older `code` workflow (the test default) that later opts in to code-v6
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

describe('older workflow versions are unchanged, and the upgrade is opt-in', () => {
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

  it('upgrading moves only new cards to code-v6; a card in flight keeps its version and finishes on it', async () => {
    await freshKeepDevops();
    const p = l;
    await hireTeam(w);
    const inFlight = await w.card({ title: 'In flight before the upgrade' });
    await p.run('Bea', handoff(), DIFF_SMALL);
    expect((await cardRow(inFlight.id)).stage).toBe('review');

    const up = await call('POST', `/api/projects/${w.projectId}/upgrade-workflow`);
    expect(up).toMatchObject({ workflowKey: 'code-v6', openCardsOnOlderVersion: 1 });
    expect(up.missingRoles.sort()).toEqual(['pre_reviewer', 'planner'].sort());
    // idempotent
    expect((await call('POST', `/api/projects/${w.projectId}/upgrade-workflow`)).workflowKey).toBe('code-v6');

    const fresh = await w.card({ title: 'After the upgrade' });
    expect(fresh).toMatchObject({ workflowKey: 'code-v6', stage: 'planning', designNeeded: true });
    // the card in flight is untouched
    const row = await cardRow(inFlight.id);
    expect(row.stage).toBe('review');
    const wf = await q(`SELECT key, version FROM workflow_versions WHERE id=$1`, [row.workflow_version_id]);
    expect(wf[0]).toMatchObject({ key: 'code', version: 5 });
    await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
    await p.run('Tess', testPass());
    expect((await cardRow(inFlight.id)).stage).toBe('finalize');
    // the project's own (primary) workflow is not rewritten
    const detail = await call('GET', `/api/projects/${w.projectId}`);
    expect(detail.project.workflowKey).toBe('code');
    await q(`DELETE FROM project_workflows WHERE project_id=$1 AND workflow_key='code-v6'`, [w.projectId]);
  });
});

describe('a project created without a workflow takes the server default', () => {
  it('uses AOM_DEFAULT_WORKFLOW, and code-v6 turns the automatic full suite off', async () => {
    // the test config pins the default to `code`; a project may still ask for code-v6 by name
    const proj = await call(
      'POST',
      '/api/projects',
      { key: 'LEAN', name: 'Lean', workflowKey: 'code-v6' },
      201,
    );
    expect(proj.project).toMatchObject({ workflowKey: 'code-v6', fullSuiteAfterFinalize: false });
    const legacy = await call('POST', '/api/projects', { key: 'OLD', name: 'Old' }, 201);
    expect(legacy.project).toMatchObject({ workflowKey: 'code', fullSuiteAfterFinalize: true });
    expect(w.t.app.ctx.config.defaultWorkflow).toBe('code');
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

describe('merge conflicts at Finalize in code-v6', () => {
  async function cardAtFinalize() {
    await freshKeepDevops();
    dispatcher().cooldown.clear();
    await call('POST', `/api/projects/${w.projectId}/upgrade-workflow`);
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
