import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import {
  cardRow,
  DIFF_LARGE,
  DIFF_SMALL,
  eventsOfType,
  hireTeam,
  pipeline,
  testPass,
} from './helpers/pipeline.ts';
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

const finalize = (id: string, body: unknown = {}, status = 200, cookie = w.owner.cookie) =>
  ok<any>(w.t.req('POST', `/api/cards/${id}/finalize`, { cookie, body }), status);
const desk = () => ok<any>(w.t.req('GET', '/api/desk', { cookie: w.owner.cookie }));

/** A card all the way to Finalize (small tier unless `large`). */
async function cardAtFinalize(over: Record<string, unknown> = {}, large = false) {
  await freshState();
  await hireTeam(w, { reviewers: ['Rex', 'Ria'] });
  const card = await w.card(over);
  await p.run(
    'Bea',
    { kind: 'outcome', outcomeId: 'handoff', note: 'x', data: {} },
    large ? DIFF_LARGE : DIFF_SMALL,
  );
  await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
  if (large) await p.run('Ria', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
  await p.run('Tess', testPass());
  expect((await cardRow(card.id)).stage).toBe('finalize');
  return card;
}

async function nextCommand(from: number, name = 'finalize.execute') {
  return r.waitFor('command', (f) => f.command === name, 5000, from);
}
const result = (commandId: string, res: Record<string, unknown>, okFlag = true) =>
  r.send('command.result', { commandId, ok: okFlag, result: res });

describe('finalize', () => {
  it('merge on a small card goes to the runner without the manager, then finalizes and spawns the full suite', async () => {
    const card = await cardAtFinalize();
    const from = r.received.length;
    const out = await finalize(card.id);
    expect(out).toMatchObject({ state: 'running', action: 'merge', deskItemId: null });
    expect(await cardRow(card.id)).toMatchObject({ status: 'waiting', finalize_state: 'running' });

    const cmd = await nextCommand(from);
    expect(cmd.payload).toMatchObject({
      cardId: card.id,
      ref: card.ref,
      action: 'merge',
      baseBranch: 'main',
      repoId: w.repoId,
    });
    expect((cmd.payload as any).worktreePath).toBe(`/work/${card.ref}`);
    expect((cmd.payload as any).branchName).toMatch(/^guildwise\/toy-/);

    result(cmd.commandId, { ok: true, action: 'merge', mergeCommit: 'abc1234567' });
    await until(async () => (await cardRow(card.id)).status === 'done', 3000, 'card finalized');
    expect(await cardRow(card.id)).toMatchObject({
      stage: 'done',
      finalize_state: null,
      finalize_result: { mergeCommit: 'abc1234567' },
    });
    const fin = (await eventsOfType('CardFinalized')).filter((e) => e.cardId === card.id);
    expect(fin[0]).toMatchObject({
      action: 'merge',
      resultRef: { mergeCommit: 'abc1234567' },
      toStage: 'done',
    });

    // the worktree and the merged branch are removed afterwards
    const wt = await nextCommand(from, 'worktree.remove');
    expect(wt.payload).toMatchObject({ path: `/work/${card.ref}`, deleteBranch: true });

    // a full-suite card is spawned for a tester on the resulting branch
    const suite = (
      await q('SELECT * FROM cards WHERE parent_card_id=$1 AND origin=$2', [card.id, 'full_suite'])
    )[0]!;
    expect(suite).toMatchObject({
      card_type: 'regression',
      stage: 'test',
      status: 'queued',
      scheduled: true,
      repo_id: w.repoId,
    });
    expect(suite.fields).toMatchObject({ suiteBranch: 'main', platform: 'web' });
    const started = (await eventsOfType('FullSuiteStarted')).filter((e) => e.cardId === card.id);
    expect(started[0]).toMatchObject({ branch: 'main', suiteCardId: suite.id });
    // result is idempotent: a redelivered result changes nothing
    result(cmd.commandId, { ok: true, action: 'merge', mergeCommit: 'zzz' });
    await r.barrier();
    expect((await eventsOfType('CardFinalized')).filter((e) => e.cardId === card.id)).toHaveLength(1);
  });

  it('merge on a large card waits for the desk approval; approving queues the command', async () => {
    const card = await cardAtFinalize({ title: 'Large one' }, true);
    expect(await cardRow(card.id)).toMatchObject({ risk_tier: 'large' });
    const from = r.received.length;
    const out = await finalize(card.id);
    expect(out.state).toBe('awaiting_approval');
    expect(out.deskItemId).toBeTruthy();
    expect(await cardRow(card.id)).toMatchObject({ status: 'waiting', finalize_state: 'awaiting_approval' });
    // The command is queued in the same transaction that approves it: nothing queued means nothing can be sent.
    expect(await q(`SELECT 1 FROM runner_commands WHERE type='finalize.execute'`)).toHaveLength(0);
    await r.barrier();
    expect(r.received.slice(from).some((f) => f.type === 'command' && f.command === 'finalize.execute')).toBe(
      false,
    );

    const item = (await desk()).items.find((i: any) => i.id === out.deskItemId);
    expect(item).toMatchObject({ kind: 'approval', subkind: 'large_merge', pinned: true, status: 'open' });
    const d = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: w.owner.cookie }));
    expect(d.testing.finalize).toMatchObject({ state: 'awaiting_approval', requiresApproval: true });
    // The card sits in the Finalize column (not "Test (waiting on bug)") with an approval reason.
    expect(d.card.column).toBe('Finalize');
    const board = await ok<any>(
      w.t.req('GET', `/api/board?projectId=${w.projectId}`, { cookie: w.owner.cookie }),
    );
    const fin = board.columns
      .find((c: any) => c.name === 'Finalize')
      .cards.find((c: any) => c.id === card.id);
    expect(fin).toMatchObject({ status: 'waiting', waitingFor: 'approval' });
    expect(
      board.columns
        .find((c: any) => c.name === 'Test (waiting on bug)')
        .cards.some((c: any) => c.id === card.id),
    ).toBe(false);

    await ok(
      w.t.req('POST', `/api/desk/${out.deskItemId}/resolve`, {
        cookie: w.owner.cookie,
        body: { resolution: 'approved' },
      }),
    );
    const cmd = await nextCommand(from);
    expect(cmd.payload).toMatchObject({ cardId: card.id, action: 'merge' });
    result(cmd.commandId, { ok: true, action: 'merge', mergeCommit: 'fff0001' });
    await until(async () => (await cardRow(card.id)).status === 'done', 3000, 'finalized after approval');
  });

  it('a rejected large merge returns the card to Finalize', async () => {
    const card = await cardAtFinalize({ title: 'Large rejected' }, true);
    const out = await finalize(card.id);
    await ok(
      w.t.req('POST', `/api/desk/${out.deskItemId}/resolve`, {
        cookie: w.owner.cookie,
        body: { resolution: 'rejected', note: 'not yet' },
      }),
    );
    const c = await cardRow(card.id);
    expect(c).toMatchObject({ stage: 'finalize', status: 'queued', finalize_state: 'failed' });
    expect(c.finalize_error).toContain('not yet');
  });

  it('pr on a large card needs no approval (only merges do)', async () => {
    const card = await cardAtFinalize({ title: 'Large pr', completionAction: 'pr' }, true);
    const from = r.received.length;
    const out = await finalize(card.id);
    expect(out).toMatchObject({ state: 'running', action: 'pr' });
    const cmd = await nextCommand(from);
    result(cmd.commandId, { ok: true, action: 'pr', pushedBranch: 'aom/x' });
    await until(async () => (await cardRow(card.id)).status === 'done', 3000, 'pushed');
    // the suite runs on the pushed branch
    const suite = (
      await q('SELECT fields FROM cards WHERE parent_card_id=$1 AND origin=$2', [card.id, 'full_suite'])
    )[0]!;
    expect(suite?.fields.suiteBranch).toBe('aom/x');
    // a worktree of a pull request is removed but its branch kept
    const wt = await nextCommand(from, 'worktree.remove');
    expect((wt.payload as any).deleteBranch).toBe(false);
  });

  it('the manager can override the completion action; a pr without gh carries a notice to the desk', async () => {
    const card = await cardAtFinalize({ title: 'Override' });
    const from = r.received.length;
    const out = await finalize(card.id, { action: 'pr' });
    expect(out.action).toBe('pr');
    expect((await cardRow(card.id)).completion_action).toBe('pr');
    const cmd = await nextCommand(from);
    result(cmd.commandId, {
      ok: true,
      action: 'pr',
      pushedBranch: 'aom/o',
      notice: 'gh is not available: the branch was pushed, open the PR by hand',
    });
    await until(async () => (await cardRow(card.id)).status === 'done', 3000, 'pr finalized');
    const items = (await desk()).items.filter((i: any) => i.subkind === 'pr_notice');
    expect(items).toHaveLength(1);
    expect(items[0].title).toContain('gh is not available');
  });

  it('a failing completion action leaves the card in Finalize and raises a desk escalation', async () => {
    const card = await cardAtFinalize({ title: 'Fails' });
    const from = r.received.length;
    await finalize(card.id);
    const cmd = await nextCommand(from);
    result(cmd.commandId, { ok: false, action: 'merge', error: 'push rejected: protected branch' });
    await until(async () => (await cardRow(card.id)).finalize_state === 'failed', 3000, 'failure recorded');
    expect(await cardRow(card.id)).toMatchObject({
      stage: 'finalize',
      status: 'queued',
      finalize_error: 'push rejected: protected branch',
    });
    const esc = (await desk()).items.find((i: any) => i.subkind === 'finalize_failed');
    expect(esc).toMatchObject({ kind: 'escalation', pinned: true });
    expect(esc.body).toContain('protected branch');
    // the manager can try again
    const again = await finalize(card.id);
    expect(again.state).toBe('running');
  });

  it('a rebase conflict at finalize sends the card to Rework with the files', async () => {
    const card = await cardAtFinalize({ title: 'Conflicts' });
    const from = r.received.length;
    await finalize(card.id);
    const cmd = await nextCommand(from);
    result(cmd.commandId, { ok: false, action: 'merge', conflict: true, conflictedFiles: ['a.txt'] });
    await until(async () => (await cardRow(card.id)).stage === 'build', 3000, 'rework');
    expect(await cardRow(card.id)).toMatchObject({ status: 'queued', rework_round: 1, finalize_state: null });
    const ev = (await eventsOfType('RebaseConflict')).filter((e) => e.cardId === card.id);
    expect(ev[0]).toMatchObject({ stage: 'finalize', conflictedFiles: ['a.txt'] });
  });

  it('only a card waiting in Finalize can be finalized, and only by someone who can manage it', async () => {
    const card = await cardAtFinalize({ title: 'Guarded' });
    const other = await w.t.userSession(uniqueEmail('stranger'));
    expect((await finalize(card.id, {}, 404, other.cookie)).error.code).toBeDefined();
    const early = await w.card({ title: 'Still building' });
    expect((await finalize(early.id, {}, 409)).error.code).toBe('not_finalizable');
  });

  const setDefault = (defaultCompletion: 'merge' | 'pr') =>
    ok(
      w.t.req('PATCH', `/api/projects/${w.projectId}`, {
        cookie: w.owner.cookie,
        body: { defaultCompletion },
      }),
    );
  const shownCard = (id: string) =>
    ok<any>(w.t.req('GET', `/api/cards/${id}`, { cookie: w.owner.cookie })).then((x) => x.card);

  it('a card with no completion action of its own lands as the project says when it is finalized', async () => {
    try {
      const card = await cardAtFinalize({ title: 'Follows the project', completionAction: undefined });
      expect((await cardRow(card.id)).completion_action).toBeNull();
      // The project changed after the card was created: the card follows it.
      await setDefault('pr');
      expect(await shownCard(card.id)).toMatchObject({
        completionAction: null,
        effectiveCompletionAction: 'pr',
        completionActionSource: 'project',
      });
      const from = r.received.length;
      expect(await finalize(card.id)).toMatchObject({ action: 'pr', state: 'running' });
      expect((await nextCommand(from)).payload).toMatchObject({ action: 'pr' });
      // Following the project stores nothing on the card.
      expect((await cardRow(card.id)).completion_action).toBeNull();
    } finally {
      await setDefault('merge');
    }
  });

  it('an explicit completion action on the card is kept when the project default changes', async () => {
    try {
      const card = await cardAtFinalize({ title: 'Overridden', completionAction: 'merge' });
      await setDefault('pr');
      expect(await shownCard(card.id)).toMatchObject({
        completionAction: 'merge',
        effectiveCompletionAction: 'merge',
        completionActionSource: 'card',
      });
      expect(await finalize(card.id)).toMatchObject({ action: 'merge' });
    } finally {
      await setDefault('merge');
    }
  });
});
