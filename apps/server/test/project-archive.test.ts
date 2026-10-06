import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, type Member } from './helpers/members.ts';
import { seed } from './helpers/seed.ts';
import { shiftHelpers } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let runner: FakeRunner;
let member: Member;
let keepProjectId: string;
let cardA: any; // claimed, shift running
let cardB: any; // queued
let doneCardId: string;
let questionId: string;
let scheduleId: string;
let shiftId: string;
let allCardIds: string[] = [];
let phaseId: string;
let allPhaseIds: string[] = [];
let baTaskId: string;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  runner = await w.connectRunner();
  member = await addMember(w, 'mgr');
});
afterAll(async () => {
  runner.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const asMember = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: member.cookie, body });
const status = async () => (await q('SELECT status FROM projects WHERE id=$1', [w.projectId]))[0]?.status;

describe('archiving a project', () => {
  it('setup: a running shift, a queued card, a schedule and an open desk item', async () => {
    await w.hire('Una', 'builder', 'junior');
    await w.hire('Scoped', 'reviewer', 'senior', { projectId: w.projectId });
    cardA = await w.card({ title: 'In flight' });
    const h = shiftHelpers(w);
    const start = await h.dispatchTo(runner, 'Una');
    await h.startShift(runner, start);
    shiftId = start.shiftId;
    cardB = await w.card({ title: 'Waiting' });
    const sched = await ok<any>(
      owner('POST', '/api/schedules', {
        projectId: w.projectId,
        name: 'Nightly',
        kind: 'card',
        cron: '0 7 * * *',
        timezone: 'UTC',
        cardTemplate: {
          title: 'Nightly check',
          cardType: 'feature',
          fields: {
            context: 'c',
            requirements: 'r',
            acceptanceCriteria: ['a'],
            affectedAreas: 'x',
            constraints: 'y',
            testPlan: 't',
          },
        },
      }),
      201,
    );
    scheduleId = sched.id;
    questionId = randomUUID();
    await seed(w, [
      {
        streamId: streamId.desk(questionId),
        event: {
          type: 'QuestionRaised',
          payload: {
            deskItemId: questionId,
            projectId: w.projectId,
            askedBy: { kind: 'agent', role: 'builder' },
            question: 'Which colour?',
            blocking: false,
            pinned: false,
            affectedCardIds: [],
          },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' },
      },
    ]);
    // a finished card keeps its history through the archive
    const done = await w.card({ title: 'Already done', specify: false });
    doneCardId = done.id;
    await q(`UPDATE cards SET status='done', stage='done' WHERE id=$1`, [doneCardId]);
    // a phase with pending follow-ups, a deploy target and a queued BA task
    const target = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/deploy-targets`, { name: 'local', kind: 'local_docker' }),
      201,
    );
    const phase = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/phases`, {
        name: 'Doomed phase',
        followups: [{ kind: 'deploy', targetId: target.id }, { kind: 'regression' }],
      }),
      201,
    );
    phaseId = phase.id;
    await ok(owner('PUT', `/api/cards/${cardB.id}/phase`, { phaseId }));
    baTaskId = randomUUID();
    await seed(w, [
      {
        streamId: streamId.baTask(baTaskId),
        event: {
          type: 'BaTaskQueued',
          payload: { taskId: baTaskId, projectId: w.projectId, phaseId, kind: 'phase_report' },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' },
      },
    ]);
    const impact = await ok<any>(asMember('GET', `/api/projects/${w.projectId}/impact`));
    expect(impact).toMatchObject({ activeShifts: 1, schedules: 1 });
    // the question, plus the working-branch re-confirmation the new phase asked for
    expect(impact.openDeskItems).toBeGreaterThanOrEqual(1);
    expect(impact.openCards).toBeGreaterThanOrEqual(2);
  });

  it('any member archives: the shift stops, worktrees go, cards close as archived, schedules and desk items stop', async () => {
    const from = runner.received.length;
    const res = await ok<any>(asMember('POST', `/api/projects/${w.projectId}/archive`));
    expect(res.project.status).toBe('archived');
    expect(await status()).toBe('archived');

    const stop = await runner.waitFor('shift.stop', (f) => f.shiftId === shiftId, 5000, from);
    expect(stop.reason).toBe('card_cancelled');
    const cmd = await runner.waitFor('command', (f) => f.command === 'worktree.remove', 5000, from);
    expect(cmd.payload.path).toBe(`/work/${cardA.ref}`);
    expect(cmd.payload.deleteBranch).toBe(false);
    expect(
      (
        await q(`SELECT 1 FROM runner_commands WHERE type='worktree.remove' AND workstation_id=$1`, [
          w.workstationId,
        ])
      ).length,
    ).toBeGreaterThan(0);

    const cards = await q('SELECT id, status FROM cards WHERE project_id=$1', [w.projectId]);
    for (const c of cards) expect(c.status).toBe(c.id === doneCardId ? 'done' : 'cancelled');
    const cancelled = await q(`SELECT payload FROM events WHERE type='CardCancelled' AND project_id=$1`, [
      w.projectId,
    ]);
    expect(cancelled.length).toBeGreaterThanOrEqual(2);
    for (const e of cancelled) expect(e.payload).toMatchObject({ cause: 'project_archived' });
    expect((await q('SELECT claim_id FROM cards WHERE id=$1', [cardA.id]))[0]?.claim_id).toBeNull();

    const sched = (await q('SELECT enabled, next_fire_at FROM schedules WHERE id=$1', [scheduleId]))[0]!;
    expect(sched.enabled).toBe(false);
    expect(sched.next_fire_at).toBeNull();
    expect((await q('SELECT status FROM desk_items WHERE id=$1', [questionId]))[0]?.status).toBe('dismissed');

    // the phase and its pending follow-ups are cancelled, its queued BA task too; nothing is started
    expect((await q('SELECT status FROM phases WHERE id=$1', [phaseId]))[0]?.status).toBe('cancelled');
    expect(
      (await q('SELECT DISTINCT status FROM phase_followups WHERE phase_id=$1', [phaseId])).map(
        (r) => r.status,
      ),
    ).toEqual(['cancelled']);
    expect((await q('SELECT status FROM ba_tasks WHERE id=$1', [baTaskId]))[0]?.status).toBe('cancelled');
    expect((await q('SELECT 1 FROM devops_requests WHERE summary ILIKE $1', ['%Doomed phase%'])).length).toBe(
      0,
    );

    // agents are kept
    expect((await q(`SELECT status FROM agents WHERE name='Una'`))[0]?.status).toBe('active');
    // history is kept
    expect(
      (await q(`SELECT 1 FROM events WHERE type='ProjectArchived' AND project_id=$1`, [w.projectId])).length,
    ).toBe(1);
    // archived projects are hidden from the default list, shown by status, and their schedules are hidden
    const active = await ok<any>(owner('GET', '/api/projects'));
    expect(active.projects.map((p: any) => p.id)).not.toContain(w.projectId);
    const archived = await ok<any>(owner('GET', '/api/projects?status=archived'));
    expect(archived.projects.map((p: any) => p.id)).toEqual([w.projectId]);
    expect((await ok<any>(asMember('GET', '/api/schedules'))).schedules).toEqual([]);
    expect((await ok<any>(asMember('GET', `/api/projects/${w.projectId}`))).project.status).toBe('archived');
    expect((await asMember('POST', `/api/projects/${w.projectId}/archive`)).status).toBe(409);
  });

  it('the dispatcher ignores an archived project', async () => {
    await q(`UPDATE projects SET status='active' WHERE id=$1`, [w.projectId]);
    const card = await w.card({ title: 'Queued while active' });
    await q(`UPDATE projects SET status='archived' WHERE id=$1`, [w.projectId]);
    const from = runner.received.length;
    await w.t.app.ctx.services.dispatcher.run();
    await runner.barrier();
    expect(runner.received.slice(from).some((f) => f.type === 'shift.start')).toBe(false);
    expect((await q('SELECT status FROM cards WHERE id=$1', [card.id]))[0]?.status).toBe('queued');
    await q(`UPDATE cards SET status='cancelled' WHERE id=$1`, [card.id]);
  });

  it('restore brings the project back; closed cards stay closed and schedules stay off', async () => {
    const res = await ok<any>(asMember('POST', `/api/projects/${w.projectId}/restore`));
    expect(res.project.status).toBe('active');
    expect(await status()).toBe('active');
    expect((await q('SELECT status FROM cards WHERE id=$1', [cardB.id]))[0]?.status).toBe('cancelled');
    expect((await q('SELECT enabled FROM schedules WHERE id=$1', [scheduleId]))[0]?.enabled).toBe(false);
    expect((await asMember('POST', `/api/projects/${w.projectId}/restore`)).status).toBe(409);
    const list = await ok<any>(owner('GET', '/api/projects'));
    expect(list.projects.map((p: any) => p.id)).toContain(w.projectId);
    // it takes work again
    const card = await w.card({ title: 'After restore' });
    const from = runner.received.length;
    await w.t.app.ctx.services.dispatcher.run();
    const start = await runner.waitFor('shift.start', () => true, 5000, from);
    expect(start.brief.card.id).toBe(card.id);
  });
});

// ------------------------------------------------------------------------------------------- permanent delete

const snapshot = async (): Promise<Record<string, string[]>> => {
  const operational: Record<string, string[]> = {
    users: ['last_login_at'],
    workstations: ['connected', 'last_seen_at', 'runtimes', 'hostname', 'platform', 'runner_version'],
    cards: ['lease_expires_at'],
    shifts: ['progress_tail', 'accepted_at'],
    card_transitions: ['id'],
    card_activity: ['id'],
  };
  const out: Record<string, string[]> = {};
  for (const table of PROJECTION_TABLES) {
    const drop = (operational[table] ?? []).map((c) => ` - '${c}'`).join('');
    const r = await q(`SELECT (to_jsonb(t)${drop})::text AS j FROM "${table}" t`);
    out[table] = r.map((x) => x.j as string).sort();
  }
  return out;
};

describe('deleting a project permanently', () => {
  it('only an archived project, only the owner, and only with the project key', async () => {
    // keep a second project alongside, with a card, to prove a delete is scoped
    keepProjectId = (await ok<any>(owner('POST', '/api/projects', { key: 'KEEP', name: 'Keep me' }), 201))
      .project.id;
    await ok(
      owner('POST', '/api/cards', {
        projectId: keepProjectId,
        title: 'Survivor',
        cardType: 'feature',
        fields: {},
        completionAction: 'merge',
        specify: false,
      }),
      201,
    );

    const url = `/api/projects/${w.projectId}/delete`;
    const active = await owner('POST', url, { confirmKey: 'TOY' });
    expect(active.status).toBe(409);
    expect(active.body.error.code).toBe('not_archived');

    await ok(asMember('POST', `/api/projects/${w.projectId}/archive`));
    expect((await asMember('POST', url, { confirmKey: 'TOY' })).status).toBe(403);
    const wrong = await owner('POST', url, { confirmKey: 'toy' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('key_mismatch');
    expect(await status()).toBe('archived');
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    expect(
      (await w.t.req('POST', url, { cookie: stranger.cookie, body: { confirmKey: 'TOY' } })).status,
    ).toBe(404);
  });

  it('removes every row of the project and keeps the audit record', async () => {
    allCardIds = (await q('SELECT id FROM cards WHERE project_id=$1', [w.projectId])).map((r) => r.id);
    allPhaseIds = (await q('SELECT id FROM phases WHERE project_id=$1', [w.projectId])).map((r) => r.id);
    expect(allPhaseIds).toEqual([phaseId]);
    expect(allCardIds.length).toBeGreaterThan(3);
    await ok(owner('POST', `/api/projects/${w.projectId}/delete`, { confirmKey: 'TOY' }));

    // every table that has a project_id or card_id column holds nothing of this project (agents are checked below)
    const cols = await q<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='public' AND column_name IN ('project_id','card_id','mapped_project_id','phase_id')
          AND table_name NOT IN ('events')`,
    );
    expect(cols.length).toBeGreaterThan(10);
    for (const { table_name: t, column_name: c } of cols) {
      const ids = c === 'card_id' ? allCardIds : c === 'phase_id' ? allPhaseIds : [w.projectId];
      const left = await q(`SELECT count(*)::int AS n FROM "${t}" WHERE "${c}" = ANY($1::uuid[])`, [ids]);
      expect(left[0]?.n, `${t}.${c}`).toBe(0);
    }
    expect((await q('SELECT 1 FROM phases WHERE id = ANY($1::uuid[])', [allPhaseIds])).length).toBe(0);
    expect(
      (await q('SELECT 1 FROM phase_followups WHERE phase_id = ANY($1::uuid[])', [allPhaseIds])).length,
    ).toBe(0);
    expect((await q('SELECT 1 FROM deploy_targets WHERE project_id=$1', [w.projectId])).length).toBe(0);
    expect((await q('SELECT 1 FROM ba_tasks WHERE id=$1', [baTaskId])).length).toBe(0);
    expect((await q('SELECT 1 FROM threads WHERE id = ANY($1::uuid[])', [allPhaseIds])).length).toBe(0);
    expect((await q('SELECT 1 FROM projects WHERE id=$1', [w.projectId])).length).toBe(0);
    expect(
      (await q('SELECT 1 FROM thread_messages WHERE thread_id = ANY($1::uuid[])', [allCardIds])).length,
    ).toBe(0);
    expect((await q('SELECT 1 FROM shifts WHERE id=$1', [shiftId])).length).toBe(0);
    expect((await q('SELECT 1 FROM desk_items WHERE id=$1', [questionId])).length).toBe(0);
    expect((await q('SELECT 1 FROM schedules WHERE id=$1', [scheduleId])).length).toBe(0);
    expect((await q('SELECT 1 FROM workstation_repos WHERE project_repo_id=$1', [w.repoId])).length).toBe(0);
    // agents belong to the org: the one allowed on this project only stays active and may now work any project;
    // the id of the project it was hired for stays as history
    expect(
      (
        await q(`SELECT status, allowed_project_ids, hired_for_project_id FROM agents WHERE name='Scoped'`)
      )[0],
    ).toEqual({ status: 'active', allowed_project_ids: null, hired_for_project_id: w.projectId });
    expect((await q(`SELECT status FROM agents WHERE name='Una'`))[0]?.status).toBe('active');
    expect((await q('SELECT status FROM projects WHERE id=$1', [keepProjectId]))[0]?.status).toBe('active');
    expect((await q('SELECT count(*)::int AS n FROM cards WHERE project_id=$1', [keepProjectId]))[0]?.n).toBe(
      1,
    );
    // the log keeps the project's events and the tombstone
    const del = await q(`SELECT payload FROM events WHERE type='ProjectDeleted' AND project_id=$1`, [
      w.projectId,
    ]);
    expect(del[0]?.payload).toMatchObject({ projectId: w.projectId, key: 'TOY', deletedBy: w.owner.id });
    expect(
      (await q(`SELECT 1 FROM events WHERE type='ProjectCreated' AND project_id=$1`, [w.projectId])).length,
    ).toBe(1);
    // gone for everyone
    expect((await owner('GET', `/api/projects/${w.projectId}`)).status).toBe(404);
    expect((await ok<any>(owner('GET', '/api/projects?status=all'))).projects.map((p: any) => p.key)).toEqual(
      ['KEEP'],
    );
    // the key is free again
    await ok(owner('POST', '/api/projects', { key: 'TOY', name: 'Reborn' }), 201);
  });

  it('a projection rebuild does not resurrect the deleted project', async () => {
    const before = await snapshot();
    const { events } = await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(events).toBeGreaterThan(30);
    const after = await snapshot();
    expect(after).toEqual(before);
    expect((await q('SELECT 1 FROM projects WHERE id=$1', [w.projectId])).length).toBe(0);
    expect((await q('SELECT 1 FROM cards WHERE project_id=$1', [w.projectId])).length).toBe(0);
    expect((await q('SELECT 1 FROM cards WHERE id = ANY($1::uuid[])', [allCardIds])).length).toBe(0);
    expect((await q('SELECT key FROM projects ORDER BY key')).map((r) => r.key)).toEqual(['KEEP', 'TOY']);
  });
});
