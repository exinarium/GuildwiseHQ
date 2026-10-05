import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { phasePass } from '../src/dispatcher/phases.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, hireTeam, pipeline, testFail, testPass } from './helpers/pipeline.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const scope = () => ({ orgId: w.owner.id, projectId: w.projectId, audience: 'project' as const });
const SYSTEM = { kind: 'system' as const, id: null };
const pass = () => phasePass(w.t.app.ctx);
const events = async (type: string, phaseId?: string) =>
  (await q('SELECT payload FROM events WHERE type=$1 ORDER BY seq', [type]))
    .map((e) => e.payload)
    .filter((p) => !phaseId || p.phaseId === phaseId);
const status = async (id: string) => (await q('SELECT status FROM phases WHERE id=$1', [id]))[0]?.status;

async function newPhase(name: string, followups: unknown[] = []) {
  return ok<any>(owner('POST', `/api/projects/${w.projectId}/phases`, { name, followups }), 201);
}
async function member(phaseId: string, title: string) {
  const c = await w.card({ title, specify: false });
  await ok(owner('PUT', `/api/cards/${c.id}/phase`, { phaseId }));
  return c;
}
/** A CardFinalized event for a card (the runner reported the completion action). */
const finalize = (cardId: string, action: 'merge' | 'pr' | 'push_branch', ref: Record<string, string> = {}) =>
  seed(w, [
    {
      streamId: streamId.card(cardId),
      event: {
        type: 'CardFinalized',
        payload: {
          cardId,
          action,
          resultRef: action === 'merge' ? { mergeCommit: 'abc1234567', ...ref } : ref,
          toStage: 'done',
        },
      },
      actor: SYSTEM,
      scope: scope(),
    },
  ]);
const cancel = (cardId: string) =>
  seed(w, [
    {
      streamId: streamId.card(cardId),
      event: { type: 'CardCancelled', payload: { cardId, reason: 'not needed' } },
      actor: SYSTEM,
      scope: scope(),
    },
  ]);

describe('phase completion', () => {
  it('waits while any confirmed card is still in flight, a pr card until its branch is merged, then completes once', async () => {
    const p = await newPhase('Complete me', [{ kind: 'regression' }]);
    const a = await member(p.id, 'Merged card');
    const b = await member(p.id, 'PR card');
    const c = await member(p.id, 'Cancelled card');
    await pass();
    expect(await status(p.id)).toBe('open');

    await finalize(a.id, 'merge');
    await cancel(c.id);
    await pass();
    expect(await status(p.id)).toBe('open'); // b is still in flight

    // b finalized with a pull request: resolved only when its branch is in the working branch
    await q(`UPDATE cards SET home_workstation_id=$2, branch_name='aom/toy-2-pr', repo_id=$3 WHERE id=$1`, [
      b.id,
      w.workstationId,
      w.repoId,
    ]);
    const from = r.received.length;
    await finalize(b.id, 'pr', { prUrl: 'https://example.test/pr/1' });
    await pass();
    expect(await status(p.id)).toBe('open');
    const cmd = await r.waitFor('command', (f) => f.command === 'branch.check_merged', 5000, from);
    expect(cmd.payload).toMatchObject({
      cardId: b.id,
      branchName: 'aom/toy-2-pr',
      workingBranch: 'main',
      action: 'pr',
      remoteUrlNormalized: 'github.com/acme/toy',
    });
    // not merged yet: nothing changes, and no second check is queued right away
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { merged: false, reason: 'main does not contain it' },
    });
    await until(
      async () =>
        (await q(`SELECT status FROM runner_commands WHERE type='branch.check_merged'`))[0]?.status ===
        'done',
      3000,
      'check answered',
    );
    await pass();
    expect(
      (await q(`SELECT count(*)::int AS n FROM runner_commands WHERE type='branch.check_merged'`))[0]?.n,
    ).toBe(1);
    expect(await status(p.id)).toBe('open');

    // the next check finds it merged (the runner deleted the branch)
    await q(`UPDATE runner_commands SET created_at = now() - interval '1 hour'`);
    const from2 = r.received.length;
    await pass();
    const cmd2 = await r.waitFor('command', (f) => f.command === 'branch.check_merged', 5000, from2);
    r.send('command.result', {
      commandId: cmd2.commandId,
      ok: true,
      result: { merged: true, branchDeleted: true, remoteBranchDeleted: false },
    });
    await until(async () => (await cardRow(b.id)).merged_into_working_at, 3000, 'merge verified');
    expect(((await events('CardMergeVerified')).at(-1) as any).branchDeleted).toBe(true);

    // two passes at once complete the phase once
    await Promise.all([pass(), pass()]);
    expect(await status(p.id)).toBe('reporting');
    const done = await events('PhaseCompleted', p.id);
    expect(done).toHaveLength(1);
    const outcomes = done[0].cardOutcomes as Array<Record<string, any>>;
    expect(outcomes.map((o) => [o.ref, o.outcome])).toEqual([
      [a.ref, 'finalized'],
      [b.ref, 'finalized'],
      [c.ref, 'cancelled'],
    ]);
    expect(outcomes[0]?.resultRef.mergeCommit).toBe('abc1234567');
    expect(outcomes[2]?.reason).toBe('not needed');
    const tasks = await q('SELECT kind, status, phase_id FROM ba_tasks WHERE phase_id=$1', [p.id]);
    expect(tasks).toEqual([{ kind: 'phase_report', status: 'queued', phase_id: p.id }]);
    await pass();
    expect(await events('PhaseCompleted', p.id)).toHaveLength(1);
  });

  it('a merge awaiting the manager does not complete the phase; a proposed card blocks it', async () => {
    const p = await newPhase('Not yet');
    const a = await member(p.id, 'Large merge');
    await q(`UPDATE cards SET status='waiting', finalize_state='awaiting_approval' WHERE id=$1`, [a.id]);
    await pass();
    expect(await status(p.id)).toBe('open');
    await finalize(a.id, 'merge');
    // the BA proposes one more card: the phase waits for the manager's confirmation
    const extra = await w.card({ title: 'Proposed', specify: false });
    await seed(w, [
      {
        streamId: streamId.card(extra.id),
        event: {
          type: 'CardPhaseChanged',
          payload: {
            cardId: extra.id,
            phaseId: p.id,
            assignment: 'proposed',
            by: { kind: 'agent', role: 'ba' },
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
    ]);
    await pass();
    expect(await status(p.id)).toBe('open');
    await ok(owner('PUT', `/api/cards/${extra.id}/phase`, { phaseId: null }));
    await pass();
    expect(await status(p.id)).toBe('reporting');
  });

  it('a phase with only cancelled cards still completes; unassigning the last open card completes it', async () => {
    const p = await newPhase('All cancelled');
    const a = await member(p.id, 'Gone');
    await cancel(a.id);
    await pass();
    expect(await status(p.id)).toBe('reporting');
    expect(((await events('PhaseCompleted', p.id))[0] as any).cardOutcomes[0].outcome).toBe('cancelled');

    const q2 = await newPhase('Last card leaves');
    const done = await member(q2.id, 'Done one');
    const open = await member(q2.id, 'Open one');
    await finalize(done.id, 'merge');
    await pass();
    expect(await status(q2.id)).toBe('open');
    await ok(owner('PUT', `/api/cards/${open.id}/phase`, { phaseId: null }));
    await pass();
    expect(await status(q2.id)).toBe('reporting');
  });

  it('a phase that was never confirmed (proposed) or has no members does not complete', async () => {
    const empty = await newPhase('Empty');
    const proposed = await newPhase('Proposed only');
    await q(`UPDATE phases SET status='proposed' WHERE id=$1`, [proposed.id]);
    const c = await member(proposed.id, 'Done but unconfirmed');
    await finalize(c.id, 'merge');
    await pass();
    expect(await status(empty.id)).toBe('open');
    expect(await status(proposed.id)).toBe('proposed');
  });

  it('reopening before approval puts the phase back to open and cancels the report task', async () => {
    const p = await newPhase('Reopen');
    const a = await member(p.id, 'Only card');
    await finalize(a.id, 'merge');
    await pass();
    expect(await status(p.id)).toBe('reporting');
    await ok(owner('POST', `/api/phases/${p.id}/reopen`, { reason: 'one more card' }));
    expect(await status(p.id)).toBe('open');
    expect((await q('SELECT status FROM ba_tasks WHERE phase_id=$1', [p.id]))[0]?.status).toBe('cancelled');
    // it completes again when its cards are resolved (a new report task)
    await pass();
    expect(await status(p.id)).toBe('reporting');
    expect((await q('SELECT count(*)::int AS n FROM ba_tasks WHERE phase_id=$1', [p.id]))[0]?.n).toBe(2);
  });

  it('the phase pass leaves archived projects alone', async () => {
    const p = await newPhase('Archived later');
    const a = await member(p.id, 'Card');
    await finalize(a.id, 'merge');
    await q(`UPDATE projects SET status='archived' WHERE id=$1`, [w.projectId]);
    await pass();
    expect(await status(p.id)).toBe('open');
    await q(`UPDATE projects SET status='active' WHERE id=$1`, [w.projectId]);
    await pass();
    expect(await status(p.id)).toBe('reporting');
  });
});

describe('cleanup when a card ends without a merge', () => {
  it('cancelling a card with a worktree removes the worktree and keeps the branch', async () => {
    const c = await w.card({ title: 'Has a worktree', specify: false });
    await q(
      `UPDATE cards SET home_workstation_id=$2, worktree_path='/work/x', branch_name='aom/toy-x', repo_id=$3 WHERE id=$1`,
      [c.id, w.workstationId, w.repoId],
    );
    const from = r.received.length;
    await ok(owner('POST', `/api/cards/${c.id}/cancel`, { reason: 'dropped' }));
    const cmd = await r.waitFor('command', (f) => f.command === 'worktree.remove', 5000, from);
    expect(cmd.payload).toMatchObject({ path: '/work/x', branchName: 'aom/toy-x', deleteBranch: false });
  });
});

describe('a bug filed after finalize (owner decision A6)', () => {
  it('joins the phase it came from, and a phase waiting for its report waits for the bug', async () => {
    const t = pipeline(w, r);
    await hireTeam(w);
    const p = await newPhase('With a suite bug');
    const card = await w.card({ title: 'Feature' });
    await ok(owner('PUT', `/api/cards/${card.id}/phase`, { phaseId: p.id }));
    await t.toTest('Bea', ['Rex']);
    await t.run('Tess', testPass());
    const from = r.received.length;
    await ok(owner('POST', `/api/cards/${card.id}/finalize`, {}));
    const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 5000, from);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: true, action: 'merge', mergeCommit: 'abc' },
    });
    await until(async () => (await cardRow(card.id)).status === 'done', 3000, 'finalized');
    await pass();
    expect(await status(p.id)).toBe('reporting');

    // the post-finalize full suite fails: its bug card joins the phase and reopens it
    await t.run('Tess', testFail('Suite bug'));
    const bug = (await q(`SELECT * FROM cards WHERE card_type='bug' AND origin='full_suite'`))[0]!;
    expect(bug).toMatchObject({ phase_id: p.id, phase_assignment: 'confirmed' });
    expect(await status(p.id)).toBe('open');
    expect((await q('SELECT status FROM ba_tasks WHERE phase_id=$1', [p.id]))[0]?.status).toBe('cancelled');
    await pass();
    expect(await status(p.id)).toBe('open'); // the bug is not done: the phase waits for it
    const detail = await ok<any>(owner('GET', `/api/phases/${p.id}`));
    expect(detail.members.map((m: any) => [m.ref, m.assignment])).toEqual([
      [card.ref, 'confirmed'],
      [bug.ref, 'confirmed'],
    ]);
    // the bug is closed by hand: the phase completes again
    await cancel(bug.id);
    await pass();
    expect(await status(p.id)).toBe('reporting');
  });
});
