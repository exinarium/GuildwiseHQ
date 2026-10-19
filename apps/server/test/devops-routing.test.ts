import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCardMergeConflictApproval } from '../src/commands/devops-routing.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, hireTeam, pipeline } from './helpers/pipeline.ts';
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

const dispatcher = () => w.t.app.ctx.services.dispatcher;
const seen = new Set<string>();

async function freshState() {
  await q(
    `TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages,
       desk_items, card_blockers, ledger_entries, devops_requests, runner_commands, runner_inbox CASCADE`,
  );
  await q('DELETE FROM agents WHERE NOT is_devops');
}

/** A card with a DevOps conflict request; the DevOps shift is started and the report sent. */
async function devopsReports(data: Record<string, unknown>, waived: boolean) {
  await freshState();
  await hireTeam(w);
  await q('UPDATE projects SET merge_large_without_approval=$1', [waived]);
  const card = await w.card({ title: 'Conflicting' });
  await p.toTest('Bea', ['Rex']);
  const s = await p.reject('Tess', 'rebase_conflict', { conflictedFiles: ['src/a.ts'] });
  dispatcher().cooldown.clear();
  void s;
  await dispatcher().run();
  const start = (await r.waitFor('shift.start', (f) => f.kind === 'devops' && !seen.has(f.shiftId))) as any;
  seen.add(start.shiftId);
  r.accepted(start.shiftId);
  r.started(start.shiftId);
  await until(
    async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='running'`, [start.shiftId]))[0],
    3000,
    'devops running',
  );
  const { reportId } = r.report(start.shiftId, {
    kind: 'outcome',
    outcomeId: 'devops_approval',
    note: 'asks',
    data,
  });
  const res = (await r.waitFor('shift.report.result', (f) => f.reportId === reportId)) as any;
  r.ended(start.shiftId, 'reported');
  const req = (
    await q('SELECT * FROM devops_requests WHERE card_id=$1 ORDER BY created_at DESC', [card.id])
  )[0]!;
  return { card, start, res, req };
}

const MERGE = {
  action: 'Resolve the origin/main merge inside the card worktree (12 UU files)',
  reason: 'Merge conflicts in the card branch only',
  commands: ['git merge origin/main'],
};

describe('isCardMergeConflictApproval', () => {
  it('accepts a plain merge-conflict resolution in the card worktree', () => {
    expect(isCardMergeConflictApproval({ ...MERGE })).toBe(true);
  });
  it('refuses anything destructive or shared, or not about the card worktree', () => {
    for (const bad of [
      { ...MERGE, commands: ['git push --force origin card'] },
      { ...MERGE, action: 'Delete the branch after merge conflict resolution in the card worktree' },
      { ...MERGE, reason: 'then git reset --hard on the card worktree' },
      { ...MERGE, action: 'Resolve the merge on the shared main branch in the card worktree' },
      { action: 'Deploy to uat', reason: 'x', commands: [] },
    ])
      expect(isCardMergeConflictApproval(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe('DevOps questions and merge approvals', () => {
  it('a "Question:" report becomes a question that resumes the request with the answer', async () => {
    const { card, req } = await devopsReports(
      { action: 'Question: which P4 branch should I use?', reason: 'A) dev B) main', commands: [] },
      false,
    );
    expect(req.status).toBe('needs_approval');
    expect(req.approval).toMatchObject({ question: true });
    const item = (await q(`SELECT * FROM desk_items WHERE id=$1`, [req.approval.deskItemId]))[0]!;
    expect(item).toMatchObject({ kind: 'question', card_id: card.id, status: 'open' });
    expect(item.data).toMatchObject({ devopsRequestId: req.id });
    expect((await q(`SELECT 1 FROM desk_items WHERE kind='approval' AND subkind='devops'`)).length).toBe(0);
    // the chain: an agent was asked first (BA/peer) or the desk; either way the owner may answer
    await ok(
      w.t.req('POST', `/api/desk/${item.id}/answer`, {
        cookie: w.owner.cookie,
        body: { answer: 'use dev', ledger: { scope: 'feature' } },
      }),
    );
    await until(
      async () => (await q(`SELECT 1 FROM devops_requests WHERE id=$1 AND status='queued'`, [req.id]))[0],
      3000,
      'request resumed',
    );
    const after = (await q('SELECT approval FROM devops_requests WHERE id=$1', [req.id]))[0]!;
    expect(after.approval).toMatchObject({ resolution: 'approved', note: 'use dev' });
    // and the approval cannot be pushed through the approval route
    const res = await w.t.req('POST', `/api/devops/requests/${req.id}/resolve`, {
      cookie: w.owner.cookie,
      body: { resolution: 'approved' },
    });
    expect(res.status).toBe(409);
  });

  it('auto-approves a merge-conflict resolution when the project waives merge approval', async () => {
    const { req } = await devopsReports(MERGE, true);
    expect(req.status).toBe('queued');
    expect(req.approval).toMatchObject({ resolution: 'approved' });
    expect(req.approval.note).toContain('does not require approval for merges');
    expect((await q(`SELECT 1 FROM desk_items WHERE kind='approval' AND status='open'`)).length).toBe(0);
    const ev = await q(
      `SELECT actor_kind FROM events WHERE type='DevOpsApprovalResolved' ORDER BY seq DESC LIMIT 1`,
    );
    expect(ev[0]?.actor_kind).toBe('system');
  });

  it('does not auto-approve when the project requires approval, or for destructive actions', async () => {
    const strict = await devopsReports(MERGE, false);
    expect(strict.req.status).toBe('needs_approval');
    expect((await q(`SELECT 1 FROM desk_items WHERE kind='approval' AND status='open'`)).length).toBe(1);
    const force = await devopsReports({ ...MERGE, commands: ['git push --force origin card'] }, true);
    expect(force.req.status).toBe('needs_approval');
    expect((await q(`SELECT 1 FROM desk_items WHERE kind='approval' AND status='open'`)).length).toBe(1);
    expect(await cardRow(force.card.id)).toBeTruthy();
  });
});
