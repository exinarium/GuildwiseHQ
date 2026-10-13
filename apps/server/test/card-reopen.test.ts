import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember } from './helpers/members.ts';
import { seed } from './helpers/seed.ts';
import { freshState, shiftHelpers } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const cookie = () => w.owner.cookie;
const SYSTEM = { kind: 'system' as const, id: null };
const PR = 'https://bitbucket.org/ws/app/pull-requests/12';
const reopen = (id: string, body: Record<string, unknown>, c = cookie()) =>
  w.t.req('POST', `/api/cards/${id}/reopen`, { cookie: c, body });
const orgId = async (): Promise<string> =>
  (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]!.org_id;
const row = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0]!;

/** Finishes a card the way a `pr` finalize does (the projection result, without a runner). */
async function finalizeWithPr(card: { id: string }, withBranch = true) {
  if (withBranch)
    await q(
      `UPDATE cards SET branch_name='aom/toy-1-x', worktree_path='/work/TOY-1', base_branch='main' WHERE id=$1`,
      [card.id],
    );
  await seed(w, [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'CardFinalized',
        payload: {
          cardId: card.id,
          action: 'pr',
          resultRef: { prUrl: PR, pushedBranch: 'aom/toy-1-x' },
          toStage: 'done',
        },
      },
      actor: SYSTEM,
      scope: { orgId: await orgId(), projectId: w.projectId, audience: 'project' as const },
    },
  ]);
}

describe('reopening a done or cancelled card', () => {
  it('a rebuild from the event log gives the same tables', async () => {
    const a = await w.card({ title: 'A', completionAction: 'pr' });
    const b = await w.card({ title: 'B' });
    await finalizeWithPr(a, false); // branch columns are set by shift events, not by this test
    await ok(reopen(a.id, { toStage: 'build', reason: 'again' }));
    await ok(w.t.req('POST', `/api/cards/${b.id}/cancel`, { cookie: cookie(), body: { reason: 'x' } }));
    await ok(reopen(b.id, { toStage: 'spec', reason: 'y' }));

    const OPERATIONAL: Record<string, string[]> = {
      users: ['last_login_at'],
      workstations: ['connected', 'last_seen_at', 'runtimes', 'hostname', 'platform', 'runner_version'],
      cards: ['lease_expires_at'],
      shifts: ['progress_tail', 'accepted_at'],
      card_transitions: ['id'],
      card_activity: ['id'],
    };
    const snapshot = async () => {
      const out: Record<string, string[]> = {};
      for (const table of PROJECTION_TABLES) {
        const drop = (OPERATIONAL[table] ?? []).map((c) => ` - '${c}'`).join('');
        out[table] = (await q(`SELECT (to_jsonb(t)${drop})::text AS j FROM "${table}" t`))
          .map((x) => x.j as string)
          .sort();
      }
      return out;
    };
    await w.t.app.ctx.notifier.flush();
    const live = await snapshot();
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    const after = await snapshot();
    for (const t of PROJECTION_TABLES) expect(after[t], t).toEqual(live[t]);
    expect((await row(a.id)).finalize_result).toMatchObject({ prUrl: PR });
  });

  it('puts a done card back into Build, keeps the branch and the earlier PR, and writes the timeline', async () => {
    await freshState();
    const card = await w.card({ title: 'Reopen me', completionAction: 'pr' });
    await finalizeWithPr(card);
    expect((await row(card.id)).status).toBe('done');

    const res = await reopen(card.id, { toStage: 'build', reason: 'review found a bug' });
    expect(res.status).toBe(200);
    expect(res.body.card).toMatchObject({ stage: 'build', status: 'queued', finalizedAt: null });
    const c = await row(card.id);
    expect(c).toMatchObject({
      stage: 'build',
      status: 'queued',
      finalized_at: null,
      claim_id: null,
      branch_name: 'aom/toy-1-x',
      worktree_path: '/work/TOY-1',
      finalize_action: 'pr',
    });
    expect(c.finalize_result).toMatchObject({ prUrl: PR });
    expect(c.queued_at).toBeTruthy();

    const detail = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: cookie() }));
    const act = detail.activity.find((a: any) => a.kind === 'reopened');
    expect(act).toMatchObject({ reason: 'review found a bug' });
    expect(act.summary).toMatch(/^Reopened by .* into Build \(was done\)$/);
    const note = detail.thread.find((m: any) => m.kind === 'system' && m.body.startsWith('Reopened by'));
    expect(note.body).toContain(PR);
    expect(note.body).toContain('aom/toy-1-x');
    const ev = await q(`SELECT payload FROM events WHERE type='CardReopened' AND stream_id=$1`, [
      streamId.card(card.id),
    ]);
    expect(ev[0]!.payload).toMatchObject({
      cardId: card.id,
      fromStage: 'done',
      fromStatus: 'done',
      toStage: 'build',
      status: 'queued',
      reason: 'review found a bug',
      by: w.owner.id,
    });
    expect(detail.transitions.at(-1)).toMatchObject({
      fromStatus: 'done',
      toStatus: 'queued',
      toStage: 'build',
    });
  });

  it('reopens a cancelled card into a manual stage as a draft', async () => {
    await freshState();
    const card = await w.card({ title: 'Cancelled' });
    await ok(w.t.req('POST', `/api/cards/${card.id}/cancel`, { cookie: cookie(), body: { reason: 'dupe' } }));
    const res = await reopen(card.id, { toStage: 'spec', reason: 'not a dupe after all' });
    expect(res.status).toBe(200);
    expect(res.body.card).toMatchObject({ stage: 'spec', status: 'draft' });
  });

  it('refuses open cards, unknown and terminal stages, and a missing reason', async () => {
    await freshState();
    const open = await w.card({ title: 'Still open' });
    const refused = await reopen(open.id, { toStage: 'build', reason: 'x' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('not_closed');

    const closed = await w.card({ title: 'Closed' });
    await finalizeWithPr(closed);
    expect((await reopen(closed.id, { toStage: 'nowhere', reason: 'x' })).status).toBe(400);
    const terminal = await reopen(closed.id, { toStage: 'done', reason: 'x' });
    expect(terminal.status).toBe(400);
    expect(terminal.body.error.code).toBe('invalid_stage');
    expect((await reopen(closed.id, { toStage: 'build', reason: '' })).status).toBe(400);
    expect((await row(closed.id)).status).toBe('done');
  });

  it('is for the card owner and the project owner, not for other members or strangers', async () => {
    await freshState();
    const card = await w.card({ title: 'Mine' });
    await finalizeWithPr(card);
    const member = await addMember(w);
    expect((await reopen(card.id, { toStage: 'build', reason: 'x' }, member.cookie)).status).toBe(403);
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    expect((await reopen(card.id, { toStage: 'build', reason: 'x' }, stranger.cookie)).status).toBe(404);
    expect((await row(card.id)).status).toBe('done');
    expect((await reopen(card.id, { toStage: 'build', reason: 'ok' })).status).toBe(200);
  });

  it('holds dependents that have not started and notes the ones that have', async () => {
    await freshState();
    await w.hire('Bea', 'builder', 'junior');
    const h = shiftHelpers(w);
    const dep = await w.card({ title: 'Dependency' });
    const waiting = await w.card({ title: 'Not started', dependencies: [dep.id] });
    const started = await w.card({ title: 'Started', dependencies: [dep.id] });
    await finalizeWithPr(dep);
    await q(`UPDATE cards SET worktree_path='/work/started', branch_name='aom/started' WHERE id=$1`, [
      started.id,
    ]);
    await q(`UPDATE cards SET status='waiting' WHERE id=$1`, [started.id]); // not dispatchable: only the gate matters below

    await ok(reopen(dep.id, { toStage: 'build', reason: 'again' }));
    const mark = r.of('shift.start').length;
    const start = await h.dispatchTo(r, 'Bea', mark);
    expect(start.brief.card.id).toBe(dep.id); // the dependency, not the dependent
    await r.barrier();
    expect(r.of('shift.start').slice(mark)).toHaveLength(1);
    expect((await row(waiting.id)).claim_id).toBeNull();

    const startedThread = await ok<any>(w.t.req('GET', `/api/cards/${started.id}`, { cookie: cookie() }));
    expect(
      startedThread.thread.some((m: any) =>
        m.body.includes(`${dep.ref} (a card this one depends on) was reopened`),
      ),
    ).toBe(true);
    const waitingThread = await ok<any>(w.t.req('GET', `/api/cards/${waiting.id}`, { cookie: cookie() }));
    expect(waitingThread.thread.some((m: any) => m.body.includes('was reopened'))).toBe(false);
  });
});
