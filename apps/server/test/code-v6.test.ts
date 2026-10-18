import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepSubworkflows } from '../src/commands/subworkflows.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import {
  designed,
  EVIDENCE,
  handoffEv,
  hireLeanTeam,
  leanAttach,
  leanPipeline,
  planned,
  resetLean,
  rpcOf,
  SHA1,
  SHA2,
  verdict,
} from './helpers/lean.ts';
import { cardRow, eventsOfType, testPass } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof leanPipeline>;
let rpc: ReturnType<typeof rpcOf>;
beforeAll(async () => {
  // code-v6 is the default of a new project in production; the suites ask for it by name (tests run on `code`).
  w = await createWorld({
    env: { AOM_FIRST_RUN_HIRE_CAP: 'false' },
    project: { workflowKey: 'code-v6' },
    integrationTests: 'off',
  });
  r = await w.connectRunner();
  p = leanPipeline(w, r);
  rpc = rpcOf(r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const call = (method: string, url: string, body?: unknown, status = 200, cookie = w.owner.cookie) =>
  ok<any>(w.t.req(method, url, { cookie, ...(body !== undefined ? { body } : {}) }), status);
const sweep = () => sweepSubworkflows(w.t.app.ctx);
const dispatcher = () => w.t.app.ctx.services.dispatcher;

async function team(opts: { reviewers?: string[]; builders?: string[] } = {}) {
  await freshState();
  await resetLean();
  dispatcher().cooldown.clear();
  await hireLeanTeam(w, opts);
}

/** A card through Planning and design, waiting in Build. */
async function cardInBuild(over: Record<string, unknown> = {}) {
  const card = await w.card(over);
  await p.run('Pia', planned());
  await p.run('Arc', designed(card.ref));
  expect((await cardRow(card.id)).stage).toBe('build');
  return card;
}

/** A card handed off by the builder (small, evidence for SHA1), waiting in Pre-review. */
async function cardInPreReview(over: Record<string, unknown> = {}, paths?: string[]) {
  const card = await cardInBuild(over);
  await p.runAt('Bea', handoffEv(), leanAttach(SHA1, paths), SHA1);
  expect((await cardRow(card.id)).stage).toBe('pre_review');
  return card;
}

describe('the code-v6 flow end to end', () => {
  it('a new project on code-v6 runs a small card through every stage with the mock team', async () => {
    await team();
    const card = await w.card({ title: 'Lean card' });
    // Spec -> Planning; every card is designed (designNeeded defaults to true)
    expect(card).toMatchObject({ stage: 'planning', designNeeded: true, workflowKey: 'code-v6' });

    await p.run('Pia', planned());
    expect((await cardRow(card.id)).stage).toBe('investigate');
    await p.run('Arc', designed(card.ref));
    expect((await cardRow(card.id)).stage).toBe('build');

    await p.runAt('Bea', handoffEv(), leanAttach(SHA1), SHA1);
    let row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'pre_review', head_sha: SHA1, high_risk: false });
    expect(row.build_evidence).toMatchObject({ sha: SHA1 });
    expect(row.build_evidence.commands).toHaveLength(2);

    await p.runAt('Pre', verdict('approve'), {}, SHA1);
    expect((await cardRow(card.id)).stage).toBe('review');
    // every card gets an Opus review
    const reviewStart = await p.runAt('Rex', verdict('approve'), {}, SHA1);
    expect(reviewStart.start.brief.shift.stage).toBe('review');
    expect(reviewStart.start.brief.buildEvidence).toMatchObject({ sha: SHA1 });
    row = await cardRow(card.id);
    // small and low risk: the owner approval is decided now and skipped, the server-run Test deploy follows
    expect(row).toMatchObject({
      stage: 'test_deploy',
      owner_approval_required: false,
      owner_approval_reason: 'auto_small',
    });
    // no agent works the test deploy: the dispatcher's pass decides (integration tests are off: nothing to start)
    await dispatcher().run();
    await until(async () => (await cardRow(card.id)).stage === 'test', 5000, 'test deploy to finish');
    expect((await cardRow(card.id)).test_deploy_state).toBe('skipped');
    expect((await eventsOfType('TestDeployResolved')).map((e) => e.result)).toContain('skipped');

    await p.runAt('Tess', testPass(), {}, SHA1);
    expect((await cardRow(card.id)).stage).toBe('finalize');

    // even when the project flag is on (an old setting), a code-v6 card never auto-spawns the suite
    await q('UPDATE projects SET full_suite_after_finalize=true WHERE id=$1', [w.projectId]);
    // the owner's approval step was skipped, so Finalize does not ask again
    const out = await call('POST', `/api/cards/${card.id}/finalize`, {});
    expect(out).toMatchObject({ state: 'running', action: 'merge', deskItemId: null });
    const cmd = (await r.waitFor(
      'command',
      (f) => f.command === 'finalize.execute' && f.payload.cardId === card.id,
    )) as any;
    // the runner lands only the reviewed commit
    expect(cmd.payload.expectedSha).toBe(SHA1);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: true, action: 'merge', mergeCommit: 'abc1234567' },
    });
    await until(async () => (await cardRow(card.id)).status === 'done', 5000, 'card finalized');
    // code-v6 turns the automatic full suite off: nothing was spawned after the merge
    expect(
      (await q('SELECT 1 FROM cards WHERE parent_card_id=$1 AND origin=$2', [card.id, 'full_suite'])).length,
    ).toBe(0);
  });

  it('a planner works outside the dependency gate: a card whose dependency has not merged is still planned', async () => {
    await team();
    const first = await w.card({ title: 'First' });
    const second = await w.card({ title: 'Second', dependencies: [first.id] });
    expect(second.stage).toBe('planning');
    const start = await p.next('Pia');
    // the planner may take either card; the dependent one is not held back at planning
    const cards = new Set([start.brief.card.ref]);
    await p.startShift(r, start);
    await p.report(r, start.shiftId, planned());
    r.ended(start.shiftId, 'reported');
    const start2 = await p.next('Pia');
    cards.add(start2.brief.card.ref);
    expect(cards).toEqual(new Set([first.ref, second.ref]));
    await p.startShift(r, start2);
    await p.report(r, start2.shiftId, planned());
    r.ended(start2.shiftId, 'reported');
  });
});

describe('pre-review', () => {
  it('findings go back to the builder, who keeps the card (affinity); the Opus review is not spent', async () => {
    await team();
    const card = await cardInPreReview();
    await p.runAt('Pre', verdict('changes'), {}, SHA1);
    // a second builder is hired after the first handed the card off
    await w.hire('Bob', 'builder', 'junior');
    const row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'build', rework_round: 1 });
    const builder = (
      await q('SELECT agent_id FROM card_handoffs WHERE card_id=$1 AND stage=$2', [card.id, 'build'])
    )[0]!.agent_id;
    expect(row.affinity_agent_id).toBe(builder);
    expect(row.affinity_reason).toBe('review');
    // the other builder is not offered the card
    const made = await dispatcher().runPass();
    const bobTook = made.find((m) => m.cardId === card.id && m.agentId !== builder);
    expect(bobTook).toBeUndefined();
    const ev = (await eventsOfType('ChangesRequested')).find((e) => e.cardId === card.id);
    expect(ev).toMatchObject({ fromStage: 'pre_review', toStage: 'build' });
    // no Opus review round was used: the review round count only counts the Opus review
    expect(
      (
        await q(`SELECT count(*)::int AS n FROM card_handoffs WHERE card_id=$1 AND stage='review'`, [card.id])
      )[0]!.n,
    ).toBe(0);
  });

  it('the pre-review does not rate the risk: a risk call it sends (the architect report text) is not stored', async () => {
    await team();
    const card = await cardInPreReview();
    const architectText = '# Design\n\nThe architect investigated the importer and designs it so.';
    await p.runAt('Pre', verdict('approve', { riskAnalysis: architectText, qaFocus: 'x' }), {}, SHA1);
    const row = await cardRow(card.id);
    expect(row.stage).toBe('review');
    expect(row.review_risk).toBeNull();
    const handoff = (
      await q('SELECT data FROM card_handoffs WHERE card_id=$1 AND stage=$2', [card.id, 'pre_review'])
    )[0]!;
    expect(handoff.data).toEqual({ score: 4 });
    // the Opus review's own risk call is what the card keeps
    await p.runAt('Rex', verdict('approve', { riskAnalysis: 'Opus analysis' }), {}, SHA1);
    expect((await cardRow(card.id)).review_risk).toMatchObject({ level: 'low', analysis: 'Opus analysis' });
  });
});

describe('build evidence and the commit it is bound to', () => {
  it('a handoff without evidence is refused', async () => {
    await team();
    const card = await cardInBuild();
    const start = await p.next('Bea');
    await p.startShift(r, start);
    const res = await p.report(r, start.shiftId, handoffEv(null), leanAttach());
    expect(res).toMatchObject({ accepted: false });
    expect(res.error).toMatch(/evidence/);
    // a failing command is refused too, and one without a unit test run
    const failing = await p.report(
      r,
      start.shiftId,
      handoffEv({ commands: [{ kind: 'build', command: 'pnpm build', status: 'failed', result: 'boom' }] }),
      leanAttach(),
    );
    expect(failing.error).toMatch(/failed/);
    const noTest = await p.report(
      r,
      start.shiftId,
      handoffEv({ commands: [{ kind: 'build', command: 'pnpm build', status: 'passed', result: 'ok' }] }),
      leanAttach(),
    );
    expect(noTest.error).toMatch(/unit test/);
    // a stated waiver (nothing to build) is accepted
    const waived = await p.report(
      r,
      start.shiftId,
      handoffEv({ commands: [], waived: 'documentation only' }),
      leanAttach(),
    );
    expect(waived.accepted).toBe(true);
    r.ended(start.shiftId, 'reported');
    expect((await cardRow(card.id)).stage).toBe('pre_review');
  });

  it('a handoff the runner could not bind to a commit is refused', async () => {
    await team();
    await cardInBuild();
    const start = await p.next('Bea');
    await p.startShift(r, start);
    const noSha = { ...leanAttach() } as Record<string, unknown>;
    delete noSha.headSha;
    const res = await p.report(r, start.shiftId, handoffEv(), noSha);
    expect(res.accepted).toBe(false);
    expect(res.error).toMatch(/commit/);
  });

  it('a review shift that starts at another commit than the evidence sends the card back to Build', async () => {
    await team();
    const card = await cardInPreReview();
    // the branch moved (somebody committed) and was not a rebase
    const start = await p.next('Pre');
    r.accepted(start.shiftId);
    r.started(start.shiftId, {
      path: `/work/${card.ref}`,
      branchName: 'x',
      baseBranch: 'main',
      created: false,
      headSha: SHA2,
    });
    await until(async () => (await cardRow(card.id)).stage === 'build', 5000, 'the card to go back to Build');
    const row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'build', build_evidence: null, head_sha: SHA2, review_approvals: 0 });
    expect(await eventsOfType('EvidenceLapsed')).toHaveLength(1);
  });

  it('a clean rebase before review keeps the evidence: it follows the commit', async () => {
    await team();
    const card = await cardInPreReview();
    await p.runAt('Pre', verdict('approve'), {}, SHA2, { rebased: true });
    const row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'review', head_sha: SHA2 });
    expect(row.build_evidence).toMatchObject({ sha: SHA2, rebasedFrom: SHA1 });
  });

  it('a verdict for a commit other than the branch is refused', async () => {
    await team();
    const card = await cardInPreReview();
    const start = await p.next('Pre');
    await p.startShift(r, start, SHA1);
    // the head moves while the pre-reviewer reads (a late commit): the verdict is not for what will merge
    await q('UPDATE cards SET head_sha=$2 WHERE id=$1', [card.id, SHA2]);
    const res = await p.report(r, start.shiftId, verdict('approve'));
    expect(res.accepted).toBe(false);
    expect(res.error).toMatch(/build evidence is for commit/);
    await q('UPDATE cards SET head_sha=$2 WHERE id=$1', [card.id, SHA1]);
    await q('UPDATE shifts SET start_sha=$2 WHERE id=$1', [start.shiftId, SHA2]);
    const res2 = await p.report(r, start.shiftId, verdict('approve'));
    expect(res2.accepted).toBe(false);
    expect(res2.error).toMatch(/you read commit/);
  });
});

describe('high risk', () => {
  it('a diff on a migration path is high risk: a second Opus approval and the owner approval are required, and an agent cannot lower it', async () => {
    await team({ reviewers: ['Rex', 'Ria'] });
    const card = await cardInBuild();
    // the agent claims it is not high risk; the server computes it from the paths
    await p.runAt(
      'Bea',
      { ...handoffEv(), data: { buildEvidence: EVIDENCE, highRisk: false, high_risk: false } },
      leanAttach(SHA1, ['apps/server/migrations/2200_x.sql', 'src/a.ts'], { highRisk: false }),
      SHA1,
    );
    let row = await cardRow(card.id);
    expect(row.high_risk).toBe(true);
    expect(row.high_risk_paths).toEqual(['apps/server/migrations/2200_x.sql']);
    await p.runAt('Pre', verdict('approve'), {}, SHA1);
    // a small card, but high risk: the first approval keeps it in Review
    await p.runAt('Rex', verdict('approve'), {}, SHA1);
    row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'review', review_approvals: 1 });
    expect(row.excluded_agent_ids).toContain((await q(`SELECT id FROM agents WHERE name='Rex'`))[0]!.id);
    // the second approval comes from the other reviewer
    const second = await p.runAt('Ria', verdict('approve'), {}, SHA1);
    expect(second.start.brief.highRisk?.labels.join(' ')).toMatch(/data and migrations/);
    row = await cardRow(card.id);
    expect(row).toMatchObject({
      stage: 'owner_approval',
      owner_approval_required: true,
      owner_approval_reason: 'high_risk',
    });
    const approvals = (await eventsOfType('ReviewApproved')).filter((e) => e.cardId === card.id);
    expect(approvals.map((e) => [e.approvalsSoFar, e.approvalsRequired])).toEqual([
      [1, 2],
      [2, 2],
    ]);
    // the project setting cannot switch it off: a high-risk change is always approved by the owner
    await call('PUT', `/api/projects/${w.projectId}/owner-approval`, { policy: 'large_or_high_risk' });
    expect((await cardRow(card.id)).owner_approval_required).toBe(true);
  });

  it('with one reviewer hired the second approval of a high-risk card may come from the same reviewer', async () => {
    await team();
    const card = await cardInBuild();
    await p.runAt('Bea', handoffEv(), leanAttach(SHA1, ['apps/server/src/auth/login.ts']), SHA1);
    await p.runAt('Pre', verdict('approve'), {}, SHA1);
    await p.runAt('Rex', verdict('approve'), {}, SHA1);
    expect((await cardRow(card.id)).stage).toBe('review');
    await p.runAt('Rex', verdict('approve'), {}, SHA1);
    expect((await cardRow(card.id)).stage).toBe('owner_approval');
  });

  it('a diff with no risky path stays low: the flag is recomputed at every handoff', async () => {
    await team();
    const card = await cardInBuild();
    await p.runAt('Bea', handoffEv(), leanAttach(SHA1, ['migrations/1_x.sql']), SHA1);
    expect((await cardRow(card.id)).high_risk).toBe(true);
    await p.runAt('Pre', verdict('changes'), {}, SHA1);
    await p.runAt('Bea', handoffEv(), leanAttach(SHA2, ['src/ok.ts']), SHA2);
    expect((await cardRow(card.id)).high_risk).toBe(false);
  });
});

describe('the owner approval after the review', () => {
  async function cardAtOwnerApproval(paths = ['apps/server/src/billing/plan.ts']) {
    const card = await cardInBuild();
    await p.runAt('Bea', handoffEv(), leanAttach(SHA1, paths), SHA1);
    await p.runAt('Pre', verdict('approve'), {}, SHA1);
    await p.runAt('Rex', verdict('approve'), {}, SHA1);
    await p.runAt('Rex', verdict('approve'), {}, SHA1);
    await sweep();
    return card;
  }

  it('asks the project owner with the diff, bound to the reviewed commit, and an approval moves the card to the test deploy', async () => {
    await team();
    const card = await cardAtOwnerApproval();
    let row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'owner_approval', status: 'waiting' });
    expect(row.approval).toMatchObject({ state: 'open', sha: SHA1 });
    const detail = await call('GET', `/api/cards/${card.id}`);
    expect(detail.approval.review).toMatchObject({
      sha: SHA1,
      stale: false,
      highRisk: true,
      diff: { truncated: false },
    });
    expect(detail.approval.review.evidence.commands).toHaveLength(2);
    const diff = await call('GET', `/api/cards/${card.id}/diff`);
    expect(diff).toMatchObject({ sha: SHA1, truncated: false });
    expect(diff.body).toContain('diff --git');
    await call('POST', `/api/cards/${card.id}/approval/approve`, { note: 'ok' });
    row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'test_deploy', owner_approved_sha: SHA1 });
  });

  it('is invalid after the head moves: nothing is approved and the owner is asked again for the new commit', async () => {
    await team();
    const card = await cardAtOwnerApproval();
    await w.t.app.ctx.store.append([
      {
        streamId: `card:${card.id}`,
        event: {
          type: 'CardHeadObserved',
          payload: { cardId: card.id, sha: SHA2, source: 'bugfix', from: SHA1 },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: card.orgId ?? null, projectId: w.projectId, audience: 'org' },
      } as never,
    ]);
    const refused = await w.t.req('POST', `/api/cards/${card.id}/approval/approve`, {
      cookie: w.owner.cookie,
      body: {},
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code ?? refused.body.code).toBe('approval_stale');
    let row = await cardRow(card.id);
    expect(row.stage).toBe('owner_approval');
    expect(row.approval).toMatchObject({ state: 'open', sha: SHA2 });
    await call('POST', `/api/cards/${card.id}/approval/approve`, {});
    row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'test_deploy', owner_approved_sha: SHA2 });
  });

  it('an approval that names a commit other than the head is refused (409 approval_stale) and nothing is approved', async () => {
    await team();
    const card = await cardAtOwnerApproval();
    const body = (sha: string) => ({ cookie: w.owner.cookie, body: { sha } });
    const refused = await w.t.req('POST', `/api/cards/${card.id}/approval/approve`, body(SHA2));
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code ?? refused.body.code).toBe('approval_stale');
    expect(await cardRow(card.id)).toMatchObject({ stage: 'owner_approval', owner_approved_sha: null });
    // the commit the owner read is the head: approved, for that commit
    await call('POST', `/api/cards/${card.id}/approval/approve`, { sha: SHA1 });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test_deploy', owner_approved_sha: SHA1 });
  });

  it('a finalize after the head moved lapses the approval: nothing is merged and the card returns to the approval step', async () => {
    await team();
    const card = await cardAtOwnerApproval();
    await call('POST', `/api/cards/${card.id}/approval/approve`, {});
    await dispatcher().run();
    await until(async () => (await cardRow(card.id)).stage === 'test', 5000, 'test deploy');
    await p.runAt('Tess', testPass(), {}, SHA1);
    expect((await cardRow(card.id)).stage).toBe('finalize');
    // a commit lands on the branch after the owner approved
    await q('UPDATE cards SET head_sha=$2 WHERE id=$1', [card.id, SHA2]);
    const out = await call('POST', `/api/cards/${card.id}/finalize`, {});
    expect(out.state).toBe('awaiting_approval');
    expect(
      r.of('command').filter((c) => c.command === 'finalize.execute' && c.payload.cardId === card.id),
    ).toHaveLength(0);
    const row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'owner_approval', owner_approved_sha: null });
    expect(await eventsOfType('OwnerApprovalLapsed')).toHaveLength(1);
  });

  it('a small low-risk card is approved automatically; the project can ask for the owner on every card', async () => {
    await team();
    const auto = await cardInPreReview();
    await p.runAt('Pre', verdict('approve'), {}, SHA1);
    await p.runAt('Rex', verdict('approve'), {}, SHA1);
    expect(await cardRow(auto.id)).toMatchObject({ stage: 'test_deploy', owner_approval_required: false });

    const set = await call('PUT', `/api/projects/${w.projectId}/owner-approval`, { policy: 'always' });
    expect(set.project.ownerApprovalPolicy).toBe('always');
    const card = await cardInBuild({ title: 'asks every time' });
    await p.runAt('Bea', handoffEv(), leanAttach(SHA2), SHA2);
    await p.runAt('Pre', verdict('approve'), {}, SHA2);
    await p.runAt('Rex', verdict('approve'), {}, SHA2);
    expect(await cardRow(card.id)).toMatchObject({
      stage: 'owner_approval',
      owner_approval_required: true,
      owner_approval_reason: 'policy_always',
    });
    await call('PUT', `/api/projects/${w.projectId}/owner-approval`, { policy: 'large_or_high_risk' });
  });
});

describe('the diff the runner uploads', () => {
  it('is stored with the handoff and capped at 2 MB with a note', async () => {
    await team();
    const card = await cardInBuild();
    // the runner cuts at 2 MB itself; a diff just over the cap (a runner that did not) is cut by the server too
    const line = `${'+line of the diff'.padEnd(99, '.')}\n`;
    const over = `diff --git a/x b/x\n${line.repeat(Math.ceil((2 * 1024 * 1024 + 3000) / 100))}`;
    expect(Buffer.byteLength(over)).toBeGreaterThan(2 * 1024 * 1024);
    await p.runAt(
      'Bea',
      handoffEv(),
      leanAttach(SHA1, ['src/x.ts'], {
        diff: { text: over, bytes: Buffer.byteLength(over), truncated: false, base: 'origin/main' },
      }),
      SHA1,
    );
    const d = await call('GET', `/api/cards/${card.id}/diff`);
    expect(d.truncated).toBe(true);
    expect(d.bytes).toBe(Buffer.byteLength(over));
    expect(Buffer.byteLength(d.body)).toBeLessThanOrEqual(2 * 1024 * 1024 + 200);
    expect(d.body).toContain('The diff was cut here');
    // a runner that cut it already says so; the server keeps its flag and the full size
    const small = await cardInBuild({ title: 'second' });
    await p.runAt(
      'Bea',
      handoffEv(),
      leanAttach(SHA2, ['src/y.ts'], {
        diff: { text: 'diff --git a/y b/y\n+y\n', bytes: 5_000_000, truncated: true, base: 'origin/main' },
      }),
      SHA2,
    );
    const d2 = await call('GET', `/api/cards/${small.id}/diff`);
    expect(d2).toMatchObject({ truncated: true, bytes: 5_000_000 });
    // a card with no stored diff has nothing to show
    const other = await w.card({ title: 'no diff' });
    await call('GET', `/api/cards/${other.id}/diff`, undefined, 404);
  });
});

describe('groups and the Card Brief', () => {
  it('the first builder of a group keeps the rest of it; it resumes its session on the next card', async () => {
    await team();
    const a = await w.card({ title: 'Group A' });
    const b = await w.card({ title: 'Group B' });
    // the planner groups both cards and writes a Card Brief for the first
    const start = await p.next('Pia');
    await p.startShift(r, start);
    const own = start.brief.card.ref;
    const other = own === a.ref ? b.ref : a.ref;
    expect((await rpc(start.shiftId, 'card.group', { id: 'feature-x' })).ok).toBe(true);
    expect((await rpc(start.shiftId, 'card.group', { id: 'feature-x', card: other })).ok).toBe(true);
    expect(
      (await rpc(start.shiftId, 'card.brief', { text: 'Build X in module Y; watch the cache.' })).ok,
    ).toBe(true);
    // an agent that is not a planner, architect or BA cannot
    await p.report(r, start.shiftId, planned());
    r.ended(start.shiftId, 'reported');
    expect((await q('SELECT count(*)::int AS n FROM cards WHERE group_id=$1', ['feature-x']))[0]!.n).toBe(2);
    const brief = (await q('SELECT card_brief FROM cards WHERE ref=$1', [own]))[0]!.card_brief;
    expect(brief).toMatch(/Build X/);

    // both cards are planned and designed, and wait in Build
    await p.run('Pia', planned());
    await p.run('Arc', designed(a.ref));
    await p.run('Arc', designed(b.ref));
    expect(
      (await q(`SELECT count(*)::int AS n FROM cards WHERE group_id='feature-x' AND stage='build'`))[0]!.n,
    ).toBe(2);
    // the first builder to claim one of them is the group's builder
    const first = await p.next('Bea');
    await p.startShift(r, first);
    const group = (await q(`SELECT * FROM card_groups WHERE group_id='feature-x'`))[0]!;
    expect(group.builder_agent_id).toBe(first.agent.agentId);
    // another builder joins the team: the rest of the group still goes to the first one
    await w.hire('Bob', 'builder', 'junior');
    // a session id is recorded for the first shift (the runner reports it after the init message)
    r.send('shift.session', {
      shiftId: first.shiftId,
      runtimeSessionId: 'sess-group-1',
      contextTokens: 20_000,
    });
    await r.barrier();
    await p.report(r, first.shiftId, handoffEv(), leanAttach(SHA1));
    r.ended(first.shiftId, 'reported');
    await until(
      async () =>
        (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='ended'`, [first.shiftId])).length > 0,
      3000,
      'ended',
    );

    // the other builder is never offered the second card of the group, whatever the order
    const made = await dispatcher().runPass();
    const grouped = made.filter((m) => m.stage === 'build');
    for (const m of grouped) expect(m.agentId).toBe(first.agent.agentId);
    const second = await p.next('Bea');
    expect(second.brief.card.ref).not.toBe(first.brief.card.ref);
    // one sticky session moves across the per-card worktrees
    expect(second.resumeSessionId).toBe('sess-group-1');
    expect(second.resumeMessage).toMatch(/Next card of your group feature-x/);
    expect(second.brief.group?.id).toBe('feature-x');
    await p.startShift(r, second);
    await p.report(r, second.shiftId, handoffEv(), leanAttach(SHA2));
    r.ended(second.shiftId, 'reported');
  });

  it('only a planner, an architect or the BA groups cards', async () => {
    await team();
    const card = await cardInBuild();
    const start = await p.next('Bea');
    await p.startShift(r, start);
    const res = await rpc(start.shiftId, 'card.group', { id: 'nope' });
    expect(res.ok).toBe(false);
    expect(card.id).toBeTruthy();
    expect((await rpc(start.shiftId, 'card.brief', { text: 'x' })).ok).toBe(false);
  });
});

describe('the Card Brief reaches the builder', () => {
  it('the builder brief carries the Card Brief as written', async () => {
    await team();
    const card = await w.card({ title: 'Brief card' });
    const plan = await p.next('Pia');
    await p.startShift(r, plan);
    await rpc(plan.shiftId, 'card.brief', { text: 'Use the existing queue; do not add a table.' });
    await p.report(r, plan.shiftId, planned());
    r.ended(plan.shiftId, 'reported');
    await p.run('Arc', designed(card.ref));
    const build = await p.next('Bea');
    expect(build.brief.cardBrief).toBe('Use the existing queue; do not add a table.');
  });
});
