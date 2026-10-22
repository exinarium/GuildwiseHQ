import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claim } from '../src/dispatcher/claim.ts';
import { phasePass } from '../src/dispatcher/phases.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createFeedInterest } from './helpers/feeds.ts';
import { seed } from './helpers/seed.ts';
import { freshState, shiftHelpers } from './helpers/shifts.ts';
import { createWorld, markOnline, ok, until, type World } from './helpers/world.ts';

/**
 * Manual project pause (an organization Owner or Admin benches a project): who may do it, idempotency, replay, and
 * that nothing new starts on a paused project through any path while running shifts finish and counters stay put.
 */
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

const ctx = () => w.t.app.ctx;
const dispatcher = () => ctx().services.dispatcher;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const pause = (cookie = w.owner.cookie, body: unknown = {}) =>
  w.t.req('POST', `/api/projects/${w.projectId}/pause`, { cookie, body });
const resume = (cookie = w.owner.cookie) =>
  w.t.req('POST', `/api/projects/${w.projectId}/resume`, { cookie, body: {} });
const row = async () => (await q('SELECT * FROM projects WHERE id=$1', [w.projectId]))[0]!;
const isPaused = async () => (await row()).paused_at !== null;
const eventsOf = (type: string) =>
  q(`SELECT payload, actor_kind, actor_id FROM events WHERE type=$1 AND project_id=$2 ORDER BY seq`, [
    type,
    w.projectId,
  ]);
const startsFrom = (from: number, kind?: string) =>
  r.received.slice(from).filter((f: any) => f.type === 'shift.start' && (!kind || f.kind === kind));
const scope = () => ({ orgId: w.owner.id, projectId: w.projectId, audience: 'project' as const });
const SYSTEM = { kind: 'system' as const, id: null };
const online = () => markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
const lastSeq = async () => Number((await q('SELECT max(seq) AS s FROM events'))[0]?.s ?? 0);

/** A user of the world's organization with a role; they also join the project (invited by the Owner, accepted). */
async function projectUser(role: 'admin' | 'member' | 'guest') {
  const u = await w.t.userSession(uniqueEmail(role));
  if (role !== 'guest') await w.t.addOrgMember(w.owner.id, u.id, role);
  // an Admin sees every project of the organization already; a Member and a Guest are invited
  if (role !== 'admin')
    await ok(
      w.t.req('POST', `/api/projects/${w.projectId}/members`, {
        cookie: w.owner.cookie,
        body: { email: u.email },
      }),
      201,
    );
  // an organization member joins at once; a guest accepts the invitation
  if (role === 'guest')
    await ok(w.t.req('POST', `/api/projects/${w.projectId}/members/accept`, { cookie: u.cookie }));
  return u;
}

describe('who may pause and resume', () => {
  it('only an organization Owner or Admin: Member, Guest, agents, runners and signed-out callers are refused', async () => {
    const member = await projectUser('member');
    const guest = await projectUser('guest');
    const admin = await projectUser('admin');

    for (const u of [member, guest]) {
      const p = await pause(u.cookie);
      expect(p.status).toBe(403);
      expect(await isPaused()).toBe(false);
    }
    expect((await pause('')).status).toBe(401);
    // the agent API and the runner token are Bearer credentials: the routes only know signed-in sessions
    for (const url of [`/api/projects/${w.projectId}/pause`, `/api/projects/${w.projectId}/resume`]) {
      const res = await w.t.req('POST', url, {
        headers: { authorization: `Bearer ${w.runnerToken}` },
        body: {},
      });
      expect([401, 403]).toContain(res.status);
    }
    expect(await isPaused()).toBe(false);

    // the Owner pauses; the Member and the Guest cannot resume it either
    await ok(pause(w.owner.cookie, { reason: 'release freeze' }));
    expect(await isPaused()).toBe(true);
    for (const u of [member, guest]) {
      expect((await resume(u.cookie)).status).toBe(403);
      expect(await isPaused()).toBe(true);
    }
    // an Admin resumes, and pauses again
    const resumed = await ok<any>(resume(admin.cookie));
    expect(resumed.project.paused).toBeNull();
    const again = await ok<any>(pause(admin.cookie));
    expect(again.project.paused).toMatchObject({ byUserId: admin.id, reason: null });
    await ok(resume(w.owner.cookie));
    expect(await isPaused()).toBe(false);
    // a reason over 500 characters is refused
    expect((await pause(w.owner.cookie, { reason: 'x'.repeat(501) })).status).toBe(400);
  });

  it('the pause is an event by a user (the audit trail), never by an agent or the system', async () => {
    const [paused] = await eventsOf('ProjectPaused');
    expect(paused).toMatchObject({ actor_kind: 'user', payload: { reason: 'release freeze' } });
    for (const e of [...(await eventsOf('ProjectPaused')), ...(await eventsOf('ProjectResumed'))])
      expect(e.actor_kind).toBe('user');
  });
});

describe('idempotency, DTO and replay', () => {
  it('pausing a paused project and resuming a running one append nothing', async () => {
    const before = (await eventsOf('ProjectPaused')).length;
    const beforeResumed = (await eventsOf('ProjectResumed')).length;
    await ok(resume());
    await ok(resume());
    expect((await eventsOf('ProjectResumed')).length).toBe(beforeResumed);
    await ok(pause(w.owner.cookie, { reason: 'first' }));
    await ok(pause(w.owner.cookie, { reason: 'second' }));
    expect((await eventsOf('ProjectPaused')).length).toBe(before + 1);
    expect((await row()).pause_reason).toBe('first');
  });

  it('the project DTOs carry who, when and why; a rebuild of the projections restores the pause from the events', async () => {
    const detail = await ok<any>(owner('GET', `/api/projects/${w.projectId}`));
    expect(detail.project.paused).toMatchObject({ byUserId: w.owner.id, reason: 'first' });
    expect(typeof detail.project.paused.byName).toBe('string');
    expect(detail.project.paused.at).toMatch(/^\d{4}-/);
    const list = await ok<any>(owner('GET', '/api/projects'));
    expect(list.projects.find((p: any) => p.id === w.projectId).paused.reason).toBe('first');

    const before = await row();
    await rebuildProjections(ctx().pool, ctx().store);
    const after = await row();
    expect(after.paused_at).toEqual(before.paused_at);
    expect(after.paused_by).toBe(w.owner.id);
    expect(after.pause_reason).toBe('first');

    await ok(resume());
    await rebuildProjections(ctx().pool, ctx().store);
    expect(await isPaused()).toBe(false);
    expect((await row()).pause_reason).toBeNull();
    expect((await ok<any>(owner('GET', `/api/projects/${w.projectId}`))).project.paused).toBeNull();
  });
});

describe('DevOps requests', () => {
  it('a DevOps request about a card of the project waits while paused and runs at resume', async () => {
    // (no freshState: it would remove the workstation's DevOps engineer)
    await q(`UPDATE shifts SET status='ended', ended_at=now(), outcome='reported' WHERE status <> 'ended'`);
    await online();
    const card = await w.card({ title: 'Needs devops' });
    await ok(pause());
    const asked = await ok<any>(
      owner('POST', '/api/devops/requests', {
        workstationId: w.workstationId,
        summary: 'about the project',
        cardId: card.id,
      }),
      201,
    );
    const from = r.received.length;
    await dispatcher().run();
    await r.barrier();
    expect(startsFrom(from, 'devops')).toHaveLength(0);
    expect(
      (await q('SELECT status FROM devops_requests WHERE id=$1', [asked.id ?? asked.request?.id]))[0]?.status,
    ).toBe('queued');
    await ok(resume());
    await dispatcher().run();
    await r.waitFor('shift.start', (f) => f.kind === 'devops', 5000, from);
  });
});

describe('cards: nothing is claimed while paused, the claim is refused cleanly, resume dispatches again', () => {
  it('a queued card is not dispatched; counters and the card stay untouched; resume starts it', async () => {
    await freshState();
    await online();
    const una = await w.hire('Una', 'builder', 'junior');
    const card = await w.card({ title: 'Benched card' });
    await ok(pause(w.owner.cookie, { reason: 'freeze' }));
    const usageBefore = (await q(`SELECT count(*)::int AS n FROM shifts WHERE card_id=$1`, [card.id]))[0]?.n;
    const marker = await lastSeq();
    const from = r.received.length;
    for (let i = 0; i < 3; i++) expect(await dispatcher().run()).toEqual([]);
    await r.barrier();
    expect(startsFrom(from)).toHaveLength(0);
    // a claim arriving for the paused project is refused (null), not an error that counts against the card
    expect(await claim(ctx(), { cardId: card.id, agentId: una.id, expectedStage: card.stage })).toBeNull();
    const c = (await q('SELECT * FROM cards WHERE id=$1', [card.id]))[0]!;
    expect(c).toMatchObject({ status: 'queued', claim_id: null, retry_after: null, rework_round: 0 });
    expect((await q(`SELECT count(*)::int AS n FROM shifts WHERE card_id=$1`, [card.id]))[0]?.n).toBe(
      usageBefore,
    );
    // no stop-loss, loop-park, failure or shift event came out of the passes
    const fresh = await q(`SELECT DISTINCT type FROM events WHERE seq > $1 ORDER BY type`, [marker]);
    expect(fresh.map((e) => e.type).filter((t) => /StopLoss|Park|Shift|Claim|Fail|Retry/i.test(t))).toEqual(
      [],
    );

    await ok(resume());
    const start = await shiftHelpers(w).dispatchTo(r, 'Una', from);
    expect(start.brief.card.ref).toBe(card.ref);
  });

  it('the same holds at later stages (a card waiting for review, test or finalize is held too)', async () => {
    await freshState();
    await online();
    await w.hire('Rex', 'reviewer', 'senior');
    await w.hire('Tia', 'tester', 'senior');
    await w.hire('Una', 'builder', 'junior');
    const cardsAt: string[] = [];
    for (const stage of ['review', 'test']) {
      const c = await w.card({ title: `at ${stage}` });
      await q(`UPDATE cards SET stage=$2 WHERE id=$1`, [c.id, stage]);
      cardsAt.push(c.id);
    }
    await ok(pause());
    const from = r.received.length;
    await dispatcher().run();
    await r.barrier();
    expect(startsFrom(from)).toHaveLength(0);
    for (const id of cardsAt)
      expect((await q('SELECT status, claim_id FROM cards WHERE id=$1', [id]))[0]).toMatchObject({
        status: 'queued',
        claim_id: null,
      });
    await ok(resume());
    await dispatcher().run();
    await r.waitFor('shift.start', () => true, 5000, from);
  });

  it('a shift already running finishes; the next handoff does not dispatch until resume', async () => {
    await freshState();
    await online();
    await w.hire('Una', 'builder', 'junior');
    const first = await w.card({ title: 'Running when paused' });
    const second = await w.card({ title: 'Queued behind it' });
    const h = shiftHelpers(w);
    const from = r.received.length;
    const start = await h.dispatchTo(r, 'Una', from);
    await h.startShift(r, start);
    await ok(pause());
    expect((await q('SELECT status FROM shifts WHERE id=$1', [start.shiftId]))[0]?.status).toBe('running');
    // the shift ends normally; the agent is free again but the other card is held
    r.ended(start.shiftId, 'stopped');
    await until(
      async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='ended'`, [start.shiftId]))[0],
      3000,
      'shift ended',
    );
    await online();
    const mid = r.received.length;
    await dispatcher().run();
    await r.barrier();
    expect(startsFrom(mid)).toHaveLength(0);
    await ok(resume());
    await online();
    const next = await h.dispatchTo(r, 'Una', mid);
    expect([first.ref, second.ref]).toContain(next.brief.card.ref);
  });
});

describe('question, DevOps and BA passes', () => {
  it("a blocking question routed to an agent of a paused project goes to the owner's desk at once, not dispatched", async () => {
    await freshState();
    await q(`UPDATE shifts SET status='ended', ended_at=now(), outcome='reported' WHERE status <> 'ended'`);
    await online();
    const sam = await w.hire('Sam', 'builder', 'senior');
    const card = await w.card({ title: 'Question on a paused project' });
    const itemId = randomUUID();
    await seed(w, [
      {
        streamId: streamId.desk(itemId),
        event: {
          type: 'QuestionRaised',
          payload: {
            deskItemId: itemId,
            cardId: card.id,
            projectId: w.projectId,
            askedBy: { kind: 'system' },
            question: 'Five or ten seconds?',
            options: [],
            blocking: true,
            routedTo: 'agent',
            routedAgentId: sam.id,
            pinned: false,
            affectedCardIds: [card.id],
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
    ]);
    await ok(pause());
    const from = r.received.length;
    await dispatcher().run();
    await r.barrier();
    expect(startsFrom(from, 'question')).toHaveLength(0);
    // A paused project never dispatches the question: a blocking one is not left waiting for nobody. It goes to the owner's
    // desk at once, with a note (owner decision, 22 Oct), and is not started.
    expect((await q('SELECT status, routed_to FROM desk_items WHERE id=$1', [itemId]))[0]).toMatchObject({
      status: 'open',
      routed_to: 'manager',
    });
    expect(
      (
        await q(
          `SELECT payload->>'note' AS note FROM events WHERE type='QuestionEscalated' AND stream_id=$1`,
          [streamId.desk(itemId)],
        )
      )[0]?.note,
    ).toMatch(/project is paused/);
    await ok(resume());
    await dispatcher().run();
    await r.barrier();
    expect(startsFrom(from, 'question')).toHaveLength(0);
  });

  it('a BA task of the project waits (and is not written from the template) and starts at resume', async () => {
    await freshState();
    await q(`UPDATE shifts SET status='ended', ended_at=now(), outcome='reported' WHERE status <> 'ended'`);
    await online();
    await w.hire('Ben', 'ba', 'senior');
    const phase = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/phases`, { name: 'Paused phase' }),
      201,
    );
    const card = await w.card({ title: 'Phase card', specify: false });
    await ok(owner('PUT', `/api/cards/${card.id}/phase`, { phaseId: phase.id }));
    await ok(pause());
    await seed(w, [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardFinalized',
          payload: {
            cardId: card.id,
            action: 'merge',
            resultRef: { mergeCommit: 'abc1234567' },
            toStage: 'done',
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
    ]);
    await phasePass(ctx());
    const from = r.received.length;
    await dispatcher().run();
    await r.barrier();
    expect(startsFrom(from, 'ba_task')).toHaveLength(0);
    expect((await q(`SELECT status FROM phases WHERE id=$1`, [phase.id]))[0]?.status).toBe('open');
    await ok(resume());
    await phasePass(ctx());
    await dispatcher().run();
    await r.waitFor('shift.start', (f) => f.kind === 'ba_task', 5000, from);
  });
});

describe('schedules and interests', () => {
  const setNow = (at: Date) => ctx().clock.setOffset(at.getTime() - Date.now());
  const cardsOf = (projectId: string) =>
    q('SELECT * FROM cards WHERE project_id=$1 ORDER BY number', [projectId]);

  it('a cron schedule fire is skipped with project_paused, the cron moves on and nothing is caught up at resume', async () => {
    await freshState();
    const sched = await ok<any>(
      owner('POST', '/api/schedules', {
        projectId: w.projectId,
        name: 'Nightly',
        kind: 'card',
        cron: '0 7 * * *',
        timezone: 'UTC',
        cardTemplate: { title: 'Nightly check', fields: {} },
      }),
      201,
    );
    const due = new Date(
      (await q('SELECT next_fire_at FROM schedules WHERE id=$1', [sched.id]))[0]?.next_fire_at,
    );
    await ok(pause());
    setNow(new Date(due.getTime() + 2000));
    const before = (await cardsOf(w.projectId)).length;
    await ctx().services.scheduler.run();
    expect((await cardsOf(w.projectId)).length).toBe(before);
    const skipped = await q(
      `SELECT payload FROM events WHERE type='ScheduleSkipped' AND payload->>'scheduleId'=$1`,
      [sched.id],
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.payload).toMatchObject({ reason: 'project_paused' });
    const next = new Date(
      (await q('SELECT next_fire_at FROM schedules WHERE id=$1', [sched.id]))[0]?.next_fire_at,
    );
    expect(next.getTime()).toBeGreaterThan(due.getTime());
    await ok(resume());
    await ctx().services.scheduler.run();
    expect((await cardsOf(w.projectId)).length).toBe(before);
    ctx().clock.setOffset(0);
  });

  it('an interest scan is skipped and a manual run is refused while its project is paused', async () => {
    const a = await createFeedInterest(w, { name: 'Benched', scan: { cron: '0 * * * *' } });
    const due = new Date(
      (await q('SELECT next_scan_at FROM interests WHERE id=$1', [a.id]))[0]?.next_scan_at,
    );
    // interests are paused through their backing project (hidden from the project routes, so the state is set as an event would)
    await seed(w, [
      {
        streamId: streamId.project(a.projectId),
        event: { type: 'ProjectPaused', payload: { projectId: a.projectId, by: w.owner.id } },
        actor: { kind: 'user', id: w.owner.id },
        scope: { orgId: w.owner.id, projectId: a.projectId, audience: 'project' },
      },
    ]);
    setNow(new Date(due.getTime() + 1000));
    await ctx().services.scheduler.run();
    expect(await cardsOf(a.projectId)).toHaveLength(0);
    const failed = await q(
      `SELECT payload FROM events WHERE type='InterestRunFailed' AND payload->>'interestId'=$1`,
      [a.id],
    );
    expect(failed[0]?.payload).toMatchObject({ error: 'project_paused', counted: false });
    const manual = await owner('POST', `/api/interests/${a.id}/run`, {});
    expect(manual.status).toBe(409);
    expect(manual.body.error.code).toBe('project_paused');
    ctx().clock.setOffset(0);
  });
});

describe('chats and live refresh', () => {
  it('a chat on a paused project does not start and tells the user why; the browser is told of the change', async () => {
    await freshState();
    await online();
    const agent = await w.hire('Vic', 'builder', 'senior');
    const chat = (
      await ok<any>(
        w.t.req('POST', '/api/chats', {
          cookie: w.owner.cookie,
          body: { agentId: agent.id, projectId: w.projectId },
        }),
        201,
      )
    ).chat;
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    await ok(pause());
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'Hello', clientMsgId: 'm1' });
    await b.until(() => b.of('chat.error').length === 1);
    expect(b.of('chat.error')[0]).toMatchObject({ threadId: chat.threadId, reason: 'project_paused' });
    expect(await q(`SELECT 1 FROM thread_messages WHERE thread_id=$1`, [chat.threadId])).toHaveLength(0);
    await ok(resume());
    b.close?.();
  });
});
