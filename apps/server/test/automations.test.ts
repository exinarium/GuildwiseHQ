import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, type Member } from './helpers/members.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/** Automations: internal-event triggers and the intake trigger (docs/design/workflow-builder.md section 5, WP6). */

let w: World;
let r: FakeRunner;
let guest: Member;
let orgId = '';
let wfKey = '';
let stage = '';

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  guest = await addMember(w, 'guest');
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
  const c = await w.card({ title: 'Probe', specify: false });
  const wf = (
    await q(
      `SELECT v.key, v.definition FROM cards c JOIN workflow_versions v ON v.id=c.workflow_version_id WHERE c.id=$1`,
      [c.id],
    )
  )[0];
  wfKey = wf?.key as string;
  stage = (wf?.definition.stages as Array<{ id: string; kind: string }>).find((s) => s.kind === 'agent')
    ?.id as string;
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const as = (cookie: string) => (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie, body });
const ownerReq = (method: string, url: string, body?: unknown) => as(w.owner.cookie)(method, url, body);
const scheduler = () => w.t.app.ctx.services.scheduler;
const SYSTEM = { kind: 'system' as const, id: null };
const scope = () => ({ orgId, projectId: w.projectId, audience: 'project' as const });
const runsOf = (id: string) =>
  q('SELECT * FROM schedule_runs WHERE schedule_id=$1 ORDER BY started_at, id', [id]);
const cardsOf = (id: string) => q('SELECT * FROM cards WHERE schedule_id=$1 ORDER BY number', [id]);

const make = (
  trigger: Record<string, unknown>,
  template: Record<string, unknown> = {},
  action: Record<string, unknown> = {},
  who: ReturnType<typeof as> = ownerReq,
) =>
  who('POST', '/api/schedules', {
    name: 'Automation',
    trigger,
    action: {
      kind: 'create_card',
      projectId: w.projectId,
      template: { title: 'Follow-up', fields: {}, ...template },
      ...action,
    },
  });

const finalize = (cardId: string) =>
  seed(w, [
    {
      streamId: streamId.card(cardId),
      event: {
        type: 'CardFinalized',
        payload: { cardId, action: 'merge', resultRef: { mergeCommit: 'abc1234' }, toStage: 'done' },
      },
      actor: SYSTEM,
      scope: scope(),
    },
  ]);
const reach = (cardId: string, toStage: string) =>
  seed(w, [
    {
      streamId: streamId.card(cardId),
      event: {
        type: 'StageCompleted',
        payload: { cardId, fromStage: 'x', toStage, outcome: 'approved' },
      },
      actor: SYSTEM,
      scope: scope(),
    },
  ]);
const investigated = (cardId: string) =>
  seed(w, [
    {
      streamId: streamId.card(cardId),
      event: {
        type: 'InvestigationReported',
        payload: { cardId, reportPath: 'docs/r.md', location: 'repo', summary: 'done' },
      },
      actor: SYSTEM,
      scope: scope(),
    },
  ]);
const sweep = async () => {
  await scheduler().run();
};

describe('internal-event triggers', () => {
  it('card_done fires once per event, for the chosen workflow only, and maps fields', async () => {
    const s = await ok<any>(
      make(
        { kind: 'event', event: 'card_done', workflowKey: wfKey },
        {
          title: 'unused',
          mapping: {
            title: 'Release notes for {card.ref}: {card.title}',
            context: 'Done: {card.ref} {event}',
          },
        },
      ),
      201,
    );
    await sweep();
    const a = await w.card({ title: 'Ship {card.ref} please', specify: false });
    await finalize(a.id);
    await sweep();
    await until(async () => (await runsOf(s.id)).length === 1, 5000, 'one run');
    await sweep();
    expect(await runsOf(s.id)).toHaveLength(1);
    const [made] = await cardsOf(s.id);
    // mapped text is inserted verbatim: a token written in a card title is never expanded again
    expect(made?.title).toBe(`Release notes for ${a.ref}: Ship {card.ref} please`);
    expect(made?.fields.context).toContain(`Done: ${a.ref}`);
    expect(made).toMatchObject({ origin: 'trigger', status: 'queued', scheduled: true });
    const [run] = await runsOf(s.id);
    expect(run).toMatchObject({ trigger: 'event', status: 'ok' });
    expect(run?.source_key).toMatch(/^event:\d+$/);
  });

  it('a workflow that does not match does not fire', async () => {
    const s = await ok<any>(make({ kind: 'event', event: 'card_done', workflowKey: 'research' }), 201);
    await sweep();
    const a = await w.card({ title: 'Other', specify: false });
    await finalize(a.id);
    await sweep();
    expect(await runsOf(s.id)).toHaveLength(0);
  });

  it('filters by card type and by a field value', async () => {
    const hit = await ok<any>(
      make({
        kind: 'event',
        event: 'card_done',
        workflowKey: wfKey,
        filter: { cardType: 'feature', fieldEquals: [{ field: 'constraints', equals: 'urgent' }] },
      }),
      201,
    );
    const miss = await ok<any>(
      make({
        kind: 'event',
        event: 'card_done',
        workflowKey: wfKey,
        filter: { fieldEquals: [{ field: 'constraints', equals: 'never' }] },
      }),
      201,
    );
    await sweep();
    const a = await w.card({ title: 'Urgent one', specify: false, fields: { constraints: 'urgent' } });
    await finalize(a.id);
    await sweep();
    await until(async () => (await runsOf(hit.id)).length === 1, 5000, 'filter hit');
    expect(await runsOf(miss.id)).toHaveLength(0);
  });

  it('card_stage_reached fires for the stage chosen and not for others', async () => {
    const s = await ok<any>(
      make({ kind: 'event', event: 'card_stage_reached', workflowKey: wfKey, stageId: stage }),
      201,
    );
    await sweep();
    const a = await w.card({ title: 'Moving', specify: false });
    await reach(a.id, 'elsewhere');
    await sweep();
    expect(await runsOf(s.id)).toHaveLength(0);
    await reach(a.id, stage);
    await sweep();
    await until(async () => (await runsOf(s.id)).length === 1, 5000, 'stage run');
    await sweep();
    expect(await runsOf(s.id)).toHaveLength(1);
  });

  it('investigation_reported fires once per report', async () => {
    const s = await ok<any>(make({ kind: 'event', event: 'investigation_reported' }), 201);
    await sweep();
    const a = await w.card({ title: 'Investigated', specify: false });
    await investigated(a.id);
    await sweep();
    await until(async () => (await runsOf(s.id)).length === 1, 5000, 'investigation run');
    await sweep();
    expect(await runsOf(s.id)).toHaveLength(1);
    expect((await runsOf(s.id))[0]?.label).toContain('nvestigation');
  });

  it('start draft makes a draft card in the first stage; the default queues it', async () => {
    const draft = await ok<any>(make({ kind: 'event', event: 'card_done' }, { start: 'draft' }), 201);
    await sweep();
    const a = await w.card({ title: 'Draft source', specify: false });
    await finalize(a.id);
    await sweep();
    await until(async () => (await cardsOf(draft.id)).length === 1, 5000, 'draft card');
    expect((await cardsOf(draft.id))[0]).toMatchObject({
      status: 'draft',
      origin: 'trigger',
      scheduled: false,
    });
  });

  it('does not answer a card it made itself', async () => {
    const s = await ok<any>(make({ kind: 'event', event: 'card_done' }), 201);
    await sweep();
    const a = await w.card({ title: 'Loop source', specify: false });
    await finalize(a.id);
    await sweep();
    await until(async () => (await cardsOf(s.id)).length === 1, 5000, 'made');
    const [mine] = await cardsOf(s.id);
    await finalize(mine?.id as string);
    await sweep();
    expect(await cardsOf(s.id)).toHaveLength(1);
  });

  it('rate limit: cards over the limit are skipped with one desk notice', async () => {
    const s = await ok<any>(
      make({ kind: 'event', event: 'card_done', workflowKey: wfKey }, {}, { ratePerHour: 2 }),
      201,
    );
    await sweep();
    for (let i = 0; i < 4; i++) {
      const a = await w.card({ title: `Burst ${i}`, specify: false });
      await finalize(a.id);
    }
    await sweep();
    await until(async () => (await runsOf(s.id)).length === 4, 8000, 'four runs');
    expect(await cardsOf(s.id)).toHaveLength(2);
    const skipped = (await runsOf(s.id)).filter((x) => /^Skipped: rate limit/.test(x.summary));
    expect(skipped).toHaveLength(2);
    const notices = await q(
      `SELECT 1 FROM desk_items WHERE title LIKE 'Automation "Automation" is making too many cards' AND status='open'`,
    );
    expect(notices.length).toBeGreaterThanOrEqual(1);
    const events = await q(
      `SELECT 1 FROM events WHERE type='ScheduleSkipped' AND payload->>'scheduleId'=$1`,
      [s.id],
    );
    expect(events).toHaveLength(2);
  });

  it('dedupe thread: one card per source card, even when the event repeats', async () => {
    const s = await ok<any>(
      make({ kind: 'event', event: 'investigation_reported' }, {}, { dedupe: 'thread' }),
      201,
    );
    await sweep();
    const a = await w.card({ title: 'Twice', specify: false });
    await investigated(a.id);
    await sweep();
    await investigated(a.id);
    await sweep();
    await until(async () => (await runsOf(s.id)).length === 2, 5000, 'two runs');
    expect(await cardsOf(s.id)).toHaveLength(1);
    expect((await runsOf(s.id)).some((x) => /^Skipped: a card was already created/.test(x.summary))).toBe(
      true,
    );
  });
});

describe('intake_ticket', () => {
  it('fires once per intake, with the ticket in the mapping, and filters on the source', async () => {
    await w.hire('Ben', 'ba', 'senior');
    const web = await ok<any>(
      make(
        { kind: 'intake_ticket', source: 'web' },
        { mapping: { title: 'Look at: {issue.title}' }, start: 'draft' },
      ),
      201,
    );
    const issues = await ok<any>(make({ kind: 'intake_ticket', source: 'issues' }), 201);
    await sweep();
    await ok(
      w.t.req('POST', '/api/intakes', {
        cookie: w.owner.cookie,
        body: { note: 'Customers cannot reset passwords' },
      }),
      201,
    );
    await sweep();
    await until(async () => (await runsOf(web.id)).length === 1, 5000, 'intake run');
    await sweep();
    expect(await runsOf(web.id)).toHaveLength(1);
    expect(await runsOf(issues.id)).toHaveLength(0);
    expect((await cardsOf(web.id))[0]).toMatchObject({
      title: 'Look at: Customers cannot reset passwords',
      status: 'draft',
      origin: 'trigger',
    });
  });

  it('refuses a project on the trigger', async () => {
    const res = await make({ kind: 'intake_ticket', projectId: w.projectId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_trigger');
  });
});

describe('who may create what, and what is refused', () => {
  it('a member can create an automation only when it makes draft cards', async () => {
    const queued = await make(
      { kind: 'event', event: 'card_done' },
      { start: 'queued' },
      {},
      as(guest.cookie),
    );
    expect(queued.status).toBe(403);
    const made = await ok<any>(make({ kind: 'event', event: 'card_done' }, {}, {}, as(guest.cookie)), 201);
    const row = (await q('SELECT action FROM schedules WHERE id=$1', [made.id]))[0];
    expect(row?.action.template.start).toBe('draft');
    const intake = await ok<any>(
      make({ kind: 'intake_ticket' }, { start: 'draft' }, {}, as(guest.cookie)),
      201,
    );
    expect(intake.id).toBeTruthy();
  });

  it('an owner may queue directly', async () => {
    const s = await ok<any>(make({ kind: 'event', event: 'card_done' }, { start: 'queued' }), 201);
    expect(s.id).toBeTruthy();
  });

  it('refuses e-mail and incoming-webhook triggers with a clear message', async () => {
    for (const trigger of [
      { kind: 'email_received', inboxId: '00000000-0000-4000-8000-000000000001' },
      { kind: 'email_reply', inboxId: '00000000-0000-4000-8000-000000000001' },
      { kind: 'webhook_in', secretHash: 'x' },
      { kind: 'intake_ticket', source: 'email' },
    ]) {
      const res = await make(trigger);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('trigger_not_available');
      expect(res.body.error.message).toMatch(/not available yet/);
    }
  });

  it('refuses conditions an event does not take, an unknown stage and unknown mapping tokens', async () => {
    const a = await make({ kind: 'event', event: 'phase_completed', workflowKey: wfKey });
    expect(a.status).toBe(400);
    const b = await make({ kind: 'event', event: 'card_stage_reached', workflowKey: wfKey, stageId: 'nope' });
    expect(b.body.error.code).toBe('unknown_stage');
    const c = await make({ kind: 'event', event: 'card_stage_reached', workflowKey: wfKey });
    expect(c.body.error.code).toBe('invalid_trigger');
    const d = await make({ kind: 'event', event: 'card_done' }, { mapping: { title: '{nonsense}' } });
    expect(d.body.error.code).toBe('unknown_mapping_token');
  });
});
