import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enterSubworkflow, resolveSubworkflow, sweepSubworkflows } from '../src/commands/subworkflows.ts';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { designer, roleInput } from './helpers/designer.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, type Member } from './helpers/members.ts';
import { cardRow, pipeline } from './helpers/pipeline.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

// Sub-workflows (docs/design/workflow-builder.md section 4): a `subworkflow` stage is run by the server. Entering it
// creates a child card (same or another project of the organisation); wait mode resolves the parent when the child ends,
// continue mode moves on at once; refusals block the parent with a desk alert. The reactor follows the event log after a
// stored cursor and is idempotent.
let w: World;
let d: ReturnType<typeof designer>;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
let ansProjectId: string;
let member: Member;

const outcome = (id: string, to: string, kind: 'success' | 'failure' = 'success', over = {}) => ({
  id,
  label: id,
  kind,
  to,
  event: 'StageCompleted',
  ...over,
});
const terminal = (id: string) => ({
  id,
  label: id,
  column: id,
  kind: 'terminal',
  claimRole: null,
  doneCriteria: '',
  outcomes: [],
});
const intake = (to: string) => ({
  id: 'intake',
  label: 'Intake',
  column: 'Intake',
  kind: 'manual',
  claimRole: null,
  doneCriteria: 'Intake',
  outcomes: [outcome('ready', to, 'success', { event: 'CardSpecified' })],
});
const agentStage = (id: string, to: string, over: Record<string, unknown> = {}) => ({
  id,
  label: id,
  column: id,
  kind: 'agent',
  claimRole: 'answerer',
  doneCriteria: 'It is done.',
  outcomes: [outcome('ok', to)],
  ...over,
});
const fields = (extra: unknown[] = []) => [
  { key: 'customer', label: 'Customer', type: 'text', required: true },
  { key: 'reply', label: 'Reply', type: 'text', required: false },
  ...extra,
];
const base = (key: string, stages: unknown[], over: Record<string, unknown> = {}) => ({
  key,
  name: key,
  department: 'support',
  fieldSet: 'custom',
  customFields: fields(),
  cardTypes: ['support'],
  initialStage: 'intake',
  stages,
  ...over,
});

/** The child workflow: intake -> answer (agent, role answerer) -> fin; the answer is a field the child fills in. */
const childFlow = (key = 'answering', over: Record<string, unknown> = {}) =>
  base(
    key,
    [
      intake('answer'),
      agentStage('answer', 'fin', { outcomes: [outcome('answered', 'fin')] }),
      terminal('fin'),
    ],
    { customFields: fields([{ key: 'answer', label: 'Answer', type: 'text', required: false }]), ...over },
  );
/** A child that only needs to exist: intake -> work (agent, nobody is hired for it in these tests) -> fin. */
const leafFlow = (key: string) => base(key, [intake('work'), agentStage('work', 'fin'), terminal('fin')]);

const sub = (target: string, over: Record<string, unknown> = {}) => ({
  workflowKey: target,
  mode: 'wait',
  fieldsIn: [{ to: 'customer', from: { field: 'customer' } }],
  fieldsOut: [{ to: 'reply', from: 'answer' }],
  ...over,
});
const noBack = { fieldsOut: [] };
/** intake -> ask (sub-workflow) -> finished | gave_up. */
const parentFlow = (key: string, cfg: Record<string, unknown>, outs?: unknown[]) =>
  base(key, [
    intake('ask'),
    {
      id: 'ask',
      label: 'Ask',
      column: 'Ask',
      kind: 'subworkflow',
      claimRole: null,
      doneCriteria: '',
      subworkflow: cfg,
      outcomes: outs ?? [outcome('done', 'finished'), outcome('failed', 'gave_up', 'failure')],
    },
    terminal('finished'),
    ...(outs ? [] : [terminal('gave_up')]),
  ]);

const ctx = () => w.t.app.ctx;
const tick = () => ctx().services.scheduler.run();
/** Several passes: a sub-workflow chain advances one hop per event round. */
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await tick();
};
/** The project's enabled workflows: its primary, `answering`, and what the test names (the set is replaced). */
const enabledKeys = new Set<string>();
const enable = async (projectId: string, ...keys: string[]) => {
  // Additive (a workflow stays usable for the tests that follow it), capped: a project enables at most 20.
  for (const k of keys) {
    enabledKeys.delete(k);
    enabledKeys.add(k);
  }
  while (enabledKeys.size > 12) enabledKeys.delete(enabledKeys.values().next().value as string);
  const set = [...new Set(['code', 'answering', ...(projectId === w.projectId ? enabledKeys : keys)])];
  await ok(
    w.t.req('PUT', `/api/projects/${projectId}/workflows`, {
      cookie: w.owner.cookie,
      body: { enabled: set.map((workflowKey) => ({ workflowKey, defaultCardTypes: [] })) },
    }),
  );
};
const newCard = async (workflowKey: string, over: Record<string, unknown> = {}, cookie = w.owner.cookie) =>
  (
    await ok<any>(
      w.t.req('POST', '/api/cards', {
        cookie,
        body: {
          projectId: w.projectId,
          title: `Ticket ${workflowKey}`,
          cardType: 'support',
          fields: { customer: 'Acme' },
          specify: true,
          workflowKey,
          ...over,
        },
      }),
      201,
    )
  ).card;
const childrenOf = async (parentId: string) =>
  (await q('SELECT * FROM cards WHERE parent_card_id=$1 ORDER BY number', [parentId])) as any[];
const runsOf = (parentId: string) =>
  q('SELECT * FROM subworkflow_runs WHERE parent_card_id=$1 ORDER BY started_at, entry_seq', [parentId]);
const count = async (type: string, cardId?: string) =>
  Number(
    (
      await q(
        `SELECT count(*)::int AS n FROM events WHERE type=$1 AND ($2::text IS NULL OR payload->>'cardId'=$2)`,
        [type, cardId ?? null],
      )
    )[0]?.n,
  );
const refusals = (cardId: string) =>
  q(`SELECT payload FROM events WHERE type='SubworkflowRefused' AND payload->>'cardId'=$1 ORDER BY seq`, [
    cardId,
  ]).then((rs) => rs.map((x) => x.payload as any));
const publish = (wf: unknown) => d.publish('workflows', wf);
/** Saves a draft, reads its issues and discards it again. */
const probe = async (wf: unknown) => {
  const res = await ok<any>(d.req('POST', '/api/workflows', wf), 201);
  await ok(d.req('DELETE', `/api/workflows/${res.id}`));
  return (res.issues as any[]).filter((i) => i.severity === 'error').map((i) => i.code as string);
};
/**
 * The agent answers this child (and only this one: other open answer cards of earlier tests are cancelled first, the
 * dispatcher would take the oldest), after the child got the answer in its fields.
 */
const answerChild = async (childId: string, answer: string) => {
  for (const o of await q(
    `SELECT id FROM cards WHERE origin='subworkflow' AND stage='answer' AND status='queued' AND id<>$1`,
    [childId],
  ))
    await ok(
      w.t.req('POST', `/api/cards/${o.id}/cancel`, { cookie: w.owner.cookie, body: { reason: 'tidy' } }),
    );
  await ok(
    w.t.req('PATCH', `/api/cards/${childId}`, { cookie: w.owner.cookie, body: { fields: { answer } } }),
  );
  await p.run('Ann', { kind: 'outcome', outcomeId: 'answered', note: answer, data: {} });
};
const detail = (id: string, cookie = w.owner.cookie) =>
  ok<any>(w.t.req('GET', `/api/cards/${id}`, { cookie }));
const board = async (projectId = w.projectId) =>
  (
    await ok<any>(w.t.req('GET', `/api/board?projectId=${projectId}`, { cookie: w.owner.cookie }))
  ).columns.flatMap((c: any) => c.cards.map((x: any) => ({ ...x, column: c.name }))) as any[];

beforeAll(async () => {
  w = await createWorld();
  d = designer(w);
  await ok(w.t.req('POST', '/api/departments', { cookie: w.owner.cookie, body: { name: 'support' } }), 201);
  await d.publish(
    'roles',
    roleInput(
      'answerer',
      [
        'answering',
        'plain-answers',
        'shrinking',
        'rework-flow',
        'depth-leaf',
        'chain-4',
        'chain-5',
        'ring-a',
        'ring-b',
        'drafty',
        'attach-flow',
        'cancel-flow',
        'cancel-flow-2',
        'cancel-flow-3',
      ].map((k) => [k, '*'] as [string, string]),
    ),
  );
  await publish(childFlow('answering'));
  const ans = await ok<any>(
    w.t.req('POST', '/api/projects', {
      cookie: w.owner.cookie,
      body: { key: 'ANS', name: 'Answers', workflowKey: 'answering' },
    }),
    201,
  );
  ansProjectId = ans.project.id;
  member = await addMember(w, 'sub-member');
  r = await w.connectRunner();
  p = pipeline(w, r);
  await w.hire('Ann', 'answerer', 'junior', { allowedProjectIds: [w.projectId, ansProjectId] });
});
afterAll(async () => {
  r?.close();
  await w.t.close();
  await closeAdminPool();
});

describe('save-time validation (rule 10 with the registry)', () => {
  it('refuses an unknown target, one that is not approved, and a project of another organisation', async () => {
    expect(await probe(parentFlow('probe-1', sub('nope')))).toContain('subworkflow_unknown_target');
    await d.draft('workflows', childFlow('unapproved'));
    expect(await probe(parentFlow('probe-2', sub('unapproved', noBack)))).toContain(
      'subworkflow_target_not_approved',
    );
    expect(
      await probe(
        parentFlow(
          'probe-3',
          sub('answering', { project: { projectId: '0190aaaa-0000-7000-8000-000000000001' } }),
        ),
      ),
    ).toContain('subworkflow_cross_org');
    expect(
      (await probe(parentFlow('probe-4', sub('answering')))).filter((c) => c.startsWith('subworkflow_')),
    ).toEqual([]);
  });

  it('a target that is not enabled in the named project is refused', async () => {
    await publish(childFlow('plain-answers'));
    expect(
      await probe(
        parentFlow('probe-5', sub('plain-answers', { project: { projectId: ansProjectId }, ...noBack })),
      ),
    ).toContain('subworkflow_target_not_enabled');
  });

  it('a cycle through another workflow is refused when the second workflow is saved, and cannot be submitted', async () => {
    await publish(parentFlow('cycle-a', sub('answering')));
    await publish(parentFlow('cycle-b', sub('cycle-a', noBack)));
    const res = await ok<any>(
      d.req('POST', '/api/workflows', parentFlow('cycle-a', sub('cycle-b', noBack))),
      201,
    );
    expect(res.issues.map((i: any) => i.code)).toContain('subworkflow_cycle');
    const submit = await d.req('POST', `/api/workflows/${res.id}/submit`);
    expect(submit.status).toBe(422);
    expect(submit.body.error.code).toBe('invalid_definition');
    await ok(d.req('DELETE', `/api/workflows/${res.id}`));
  });

  it('a workflow that starts itself is refused', async () => {
    expect(await probe(parentFlow('selfish', sub('selfish', noBack)))).toContain('subworkflow_cycle');
  });

  it('three levels are fine, four are refused', async () => {
    await publish(leafFlow('depth-leaf'));
    await publish(parentFlow('depth-3', sub('depth-leaf', noBack)));
    await publish(parentFlow('depth-2', sub('depth-3', noBack)));
    expect(await probe(parentFlow('depth-1', sub('depth-2', noBack)))).toEqual([]);
    await publish(parentFlow('depth-1', sub('depth-2', noBack)));
    expect(await probe(parentFlow('depth-0', sub('depth-1', noBack)))).toContain('subworkflow_too_deep');
  });
});

describe('wait mode', () => {
  it('starts a child with the fields mapped in, waits, and takes the done outcome with the fields mapped back', async () => {
    await publish(parentFlow('wait-done', sub('answering')));
    await enable(w.projectId, 'wait-done', 'answering');
    const card = await newCard('wait-done', { fields: { customer: 'Globex' } });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'ask', status: 'queued' });
    // The dispatcher never takes a sub-workflow stage, even with an agent free for the child's role.
    await ctx().services.dispatcher.run();
    expect(await q('SELECT 1 FROM shifts WHERE card_id=$1', [card.id])).toEqual([]);

    await tick();
    expect(await cardRow(card.id)).toMatchObject({ stage: 'ask', status: 'waiting' });
    const [child] = await childrenOf(card.id);
    expect(child).toMatchObject({
      origin: 'subworkflow',
      project_id: w.projectId,
      stage: 'answer',
      status: 'queued',
      fields: { customer: 'Globex' },
      owner_user_id: w.owner.id,
    });
    expect(child.title).toContain('Ask');
    const [run] = await runsOf(card.id);
    expect(run).toMatchObject({
      status: 'open',
      mode: 'wait',
      workflow_key: 'answering',
      child_card_id: child.id,
    });
    expect(await count('SubworkflowStarted', card.id)).toBe(1);

    // The board chip data and the card detail panel.
    const tile = (await board()).find((c) => c.id === card.id);
    expect(tile).toMatchObject({
      status: 'waiting',
      waitingFor: 'subworkflow',
      column: 'Ask',
      waitingOn: { id: child.id, ref: child.ref, title: child.title, column: 'answer', projectKey: 'TOY' },
    });
    expect((await board()).find((c) => c.id === child.id)).toMatchObject({
      startedBy: { id: card.id, ref: card.ref },
    });
    const parentView = await detail(card.id);
    expect(parentView.subworkflows.children).toHaveLength(1);
    expect(parentView.subworkflows.children[0]).toMatchObject({
      stageId: 'ask',
      stageLabel: 'Ask',
      mode: 'wait',
      state: 'open',
      workflowKey: 'answering',
      child: { ref: child.ref, visible: true, column: 'answer' },
    });
    expect((await detail(child.id)).subworkflows).toMatchObject({
      children: [],
      startedBy: { ref: card.ref, stageLabel: 'Ask', visible: true },
    });

    await answerChild(child.id, 'forty-two');
    expect(await cardRow(child.id)).toMatchObject({ status: 'done' });
    await tick();
    expect(await cardRow(card.id)).toMatchObject({
      stage: 'finished',
      status: 'done',
      fields: { customer: 'Globex', reply: 'forty-two' },
    });
    expect((await runsOf(card.id))[0]).toMatchObject({ status: 'done', fields: { reply: 'forty-two' } });
    const resolved = (
      await q(`SELECT payload FROM events WHERE type='SubworkflowResolved' AND payload->>'cardId'=$1`, [
        card.id,
      ])
    )[0]!.payload;
    expect(resolved).toMatchObject({ result: 'done', fields: { reply: 'forty-two' }, stageId: 'ask' });
  });

  it('a cancelled child takes the failed outcome', async () => {
    const card = await newCard('wait-done');
    await tick();
    const [child] = await childrenOf(card.id);
    await ok(
      w.t.req('POST', `/api/cards/${child!.id}/cancel`, { cookie: w.owner.cookie, body: { reason: 'no' } }),
    );
    await tick();
    expect(await cardRow(card.id)).toMatchObject({
      stage: 'gave_up',
      status: 'done',
      fields: { customer: 'Acme' },
    });
    expect((await runsOf(card.id))[0]).toMatchObject({ status: 'cancelled' });
    const t = (
      await q(
        `SELECT payload FROM events WHERE type='StageCompleted' AND payload->>'cardId'=$1 ORDER BY seq DESC LIMIT 1`,
        [card.id],
      )
    )[0]!.payload;
    expect(t).toMatchObject({ fromStage: 'ask', toStage: 'gave_up', outcome: 'failed' });
  });

  it('onFailure continue: a cancelled child counts as done', async () => {
    await publish(parentFlow('wait-lenient', sub('answering', { onFailure: 'continue' })));
    await enable(w.projectId, 'wait-lenient');
    const card = await newCard('wait-lenient');
    await tick();
    const [child] = await childrenOf(card.id);
    await ok(
      w.t.req('POST', `/api/cards/${child!.id}/cancel`, { cookie: w.owner.cookie, body: { reason: 'no' } }),
    );
    await tick();
    expect(await cardRow(card.id)).toMatchObject({ stage: 'finished' });
  });

  it('start draft leaves the child a draft in its first stage', async () => {
    await publish(parentFlow('wait-draft', sub('answering', { start: 'draft' })));
    await enable(w.projectId, 'wait-draft');
    const card = await newCard('wait-draft');
    await tick();
    const [child] = await childrenOf(card.id);
    expect(child).toMatchObject({ status: 'draft', stage: 'intake' });
    expect(await cardRow(card.id)).toMatchObject({ status: 'waiting' });
  });

  it('a parent cancelled while it waits is left alone when the child ends', async () => {
    const card = await newCard('wait-done');
    await tick();
    const [child] = await childrenOf(card.id);
    await ok(
      w.t.req('POST', `/api/cards/${card.id}/cancel`, { cookie: w.owner.cookie, body: { reason: 'stop' } }),
    );
    await answerChild(child!.id, 'late');
    await tick();
    expect(await cardRow(card.id)).toMatchObject({ status: 'cancelled', stage: 'ask' });
    expect((await runsOf(card.id))[0]).toMatchObject({ status: 'done' });
  });

  it('rework: re-entering the step starts a new child (one open child per round)', async () => {
    await publish(
      base('rework-flow', [
        intake('ask'),
        {
          id: 'ask',
          label: 'Ask',
          column: 'Ask',
          kind: 'subworkflow',
          claimRole: null,
          doneCriteria: '',
          subworkflow: sub('answering'),
          outcomes: [outcome('done', 'check'), outcome('failed', 'check', 'failure')],
        },
        agentStage('check', 'finished', {
          outcomes: [outcome('fine', 'finished'), outcome('again', 'ask', 'failure', { rework: true })],
        }),
        terminal('finished'),
      ]),
    );
    await enable(w.projectId, 'rework-flow');
    const card = await newCard('rework-flow');
    await tick();
    const [first] = await childrenOf(card.id);
    await answerChild(first!.id, 'draft one');
    await tick();
    expect(await cardRow(card.id)).toMatchObject({
      stage: 'check',
      status: 'queued',
      fields: { reply: 'draft one' },
    });
    await p.run('Ann', { kind: 'outcome', outcomeId: 'again', note: 'ask again', data: {} });
    await tick();
    expect(await cardRow(card.id)).toMatchObject({ stage: 'ask', status: 'waiting', rework_round: 1 });
    const kids = await childrenOf(card.id);
    expect(kids).toHaveLength(2);
    const runs = await runsOf(card.id);
    expect(runs.map((x) => [x.status, x.rework_round])).toEqual([
      ['done', 0],
      ['open', 1],
    ]);
    // The same entry again (a replayed event) starts nothing.
    await sweepFromStart();
    expect(await childrenOf(card.id)).toHaveLength(2);
    // The second round ends the same way; the parent is done after the check.
    await answerChild(kids[1]!.id, 'draft two');
    await tick();
    expect(await cardRow(card.id)).toMatchObject({ stage: 'check', fields: { reply: 'draft two' } });
    await p.run('Ann', { kind: 'outcome', outcomeId: 'fine', note: 'fine', data: {} });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'finished', status: 'done' });
  });
});

describe('continue mode', () => {
  it('moves the parent on at once and leaves the child running', async () => {
    await publish(
      parentFlow('go-on', sub('answering', { mode: 'continue', ...noBack }), [outcome('done', 'finished')]),
    );
    await enable(w.projectId, 'go-on');
    const card = await newCard('go-on');
    await tick();
    expect(await cardRow(card.id)).toMatchObject({ stage: 'finished', status: 'done' });
    const [child] = await childrenOf(card.id);
    expect(child).toMatchObject({ origin: 'subworkflow', stage: 'answer', status: 'queued' });
    expect((await runsOf(card.id))[0]).toMatchObject({ status: 'continued', mode: 'continue' });
    expect(await count('SubworkflowResolved', card.id)).toBe(0);
    // The child ending later changes nothing on the parent.
    await answerChild(child!.id, 'whenever');
    await tick();
    expect(await cardRow(card.id)).toMatchObject({ stage: 'finished', status: 'done' });
    expect(await count('SubworkflowResolved', card.id)).toBe(0);
  });
});

describe('across projects', () => {
  it('starts the child in another project of the organisation', async () => {
    await publish(parentFlow('go-ans', sub('answering', { project: { projectId: ansProjectId } })));
    await enable(w.projectId, 'go-ans');
    const card = await newCard('go-ans');
    await tick();
    const [child] = await childrenOf(card.id);
    expect(child).toMatchObject({ project_id: ansProjectId, origin: 'subworkflow', parent_card_id: card.id });
    expect(child.ref.startsWith('ANS-')).toBe(true);
    expect(await cardRow(card.id)).toMatchObject({ status: 'waiting' });
    const tile = (await board()).find((c) => c.id === card.id);
    expect(tile.waitingOn).toMatchObject({ ref: child.ref, projectKey: 'ANS', projectName: 'Answers' });
    // The child lives on the other board and says who started it.
    expect((await board(ansProjectId)).find((c) => c.id === child.id)).toMatchObject({
      startedBy: { ref: card.ref },
    });

    await answerChild(child.id, 'from ANS');
    await tick();
    expect(await cardRow(card.id)).toMatchObject({ stage: 'finished', fields: { reply: 'from ANS' } });
  });

  it('the card owner must be a member of both projects', async () => {
    await publish(parentFlow('go-ans-member', sub('answering', { project: { projectId: ansProjectId } })));
    await enable(w.projectId, 'go-ans-member');
    const card = await newCard('go-ans-member', {}, member.cookie);
    await tick();
    expect(await cardRow(card.id)).toMatchObject({ status: 'blocked' });
    expect((await refusals(card.id)).map((x) => x.reason)).toEqual(['not_member']);
    expect(await childrenOf(card.id)).toEqual([]);
    expect(await count('SubworkflowStarted', card.id)).toBe(0);
    // Adding the member to the other project and acknowledging the alert tries again.
    await ok(
      w.t.req('POST', `/api/projects/${ansProjectId}/members`, {
        cookie: w.owner.cookie,
        body: { email: member.email },
      }),
      201,
    );
    await ok(w.t.req('POST', `/api/projects/${ansProjectId}/members/accept`, { cookie: member.cookie }));
    const alert = (
      await q(`SELECT id FROM desk_items WHERE card_id=$1 AND subkind='subworkflow_refused'`, [card.id])
    )[0]!;
    await ok(
      w.t.req('POST', `/api/desk/${alert.id}/resolve`, {
        cookie: member.cookie,
        body: { resolution: 'acknowledged' },
      }),
    );
    await tick();
    expect(await cardRow(card.id)).toMatchObject({ status: 'waiting' });
    expect(await childrenOf(card.id)).toHaveLength(1);
  });
});

describe('refusals while the stage runs', () => {
  it('a target that is not enabled in the card project blocks the parent with a desk alert, then retries', async () => {
    await publish(parentFlow('needs-enable', sub('plain-answers', noBack)));
    await enable(w.projectId, 'needs-enable');
    const card = await newCard('needs-enable');
    await tick();
    expect(await cardRow(card.id)).toMatchObject({ stage: 'ask', status: 'blocked' });
    expect((await refusals(card.id)).map((x) => x.reason)).toEqual(['not_enabled']);
    expect(await childrenOf(card.id)).toEqual([]);
    const alert = (
      await q(`SELECT * FROM desk_items WHERE card_id=$1 AND subkind='subworkflow_refused'`, [card.id])
    )[0]!;
    expect(alert).toMatchObject({ kind: 'alert', status: 'open' });
    const tile = (await board()).find((c) => c.id === card.id);
    expect(tile.blocked).toBe(true);
    expect(tile.blockedReason.title).toContain('could not start plain-answers');
    // Another pass does not raise a second alert.
    await settle(2);
    expect((await refusals(card.id)).length).toBe(1);

    await enable(w.projectId, 'needs-enable', 'plain-answers');
    await ok(
      w.t.req('POST', `/api/desk/${alert.id}/resolve`, {
        cookie: w.owner.cookie,
        body: { resolution: 'acknowledged' },
      }),
    );
    await tick();
    expect(await cardRow(card.id)).toMatchObject({ stage: 'ask', status: 'waiting' });
    expect(await childrenOf(card.id)).toHaveLength(1);
    expect((await refusals(card.id)).length).toBe(1);
  });

  it('a mapping the target no longer accepts is refused (invalid mapping)', async () => {
    await publish(
      childFlow('shrinking', {
        customFields: fields([{ key: 'extra', label: 'Extra', type: 'text', required: false }]),
      }),
    );
    await publish(
      parentFlow(
        'feeds-extra',
        sub('shrinking', { fieldsIn: [{ to: 'extra', from: { value: 'x' } }], ...noBack }),
      ),
    );
    await enable(w.projectId, 'shrinking', 'feeds-extra');
    // The target changes after the parent was approved: its new version has no 'extra' field any more.
    await publish(childFlow('shrinking'));
    const card = await newCard('feeds-extra');
    await tick();
    expect(await cardRow(card.id)).toMatchObject({ status: 'blocked' });
    const [refusal] = await refusals(card.id);
    expect(refusal).toMatchObject({ reason: 'invalid_mapping', stageId: 'ask' });
    expect(refusal.detail).toContain('extra');
  });

  it('a chain four deep is refused while running (each version is valid on its own)', async () => {
    await publish(leafFlow('chain-4'));
    await publish(parentFlow('chain-3', sub('chain-4', noBack)));
    await publish(parentFlow('chain-2', sub('chain-3', noBack)));
    await publish(parentFlow('chain-1', sub('chain-2', noBack)));
    // chain-4 later learns to start chain-5: its new version is one level deep on its own.
    await publish(leafFlow('chain-5'));
    await publish(
      base('chain-4', [
        intake('go'),
        {
          id: 'go',
          label: 'Go',
          column: 'Go',
          kind: 'subworkflow',
          claimRole: null,
          doneCriteria: '',
          subworkflow: sub('chain-5', noBack),
          outcomes: [outcome('done', 'fin'), outcome('failed', 'fin', 'failure')],
        },
        terminal('fin'),
      ]),
    );
    await enable(w.projectId, 'chain-1', 'chain-2', 'chain-3', 'chain-4', 'chain-5');
    const root = await newCard('chain-1');
    await settle(8);
    const c2 = (await childrenOf(root.id))[0]!;
    const c3 = (await childrenOf(c2.id))[0]!;
    const c4 = (await childrenOf(c3.id))[0]!;
    expect([c2, c3, c4].map((c) => c.origin)).toEqual(['subworkflow', 'subworkflow', 'subworkflow']);
    expect(await childrenOf(c4.id)).toEqual([]);
    expect(await cardRow(c4.id)).toMatchObject({ status: 'blocked', stage: 'go' });
    expect((await refusals(c4.id)).map((x) => x.reason)).toEqual(['depth']);
    for (const c of [root, c2, c3]) expect(await cardRow(c.id)).toMatchObject({ status: 'waiting' });
  });

  it('a cycle that got past the save-time check (versions registered behind its back) is refused while running', async () => {
    await publish(parentFlow('ring-b', sub('answering', noBack)));
    await publish(parentFlow('ring-a', sub('ring-b', noBack)));
    // A second version of ring-b that starts ring-a: the validator would refuse it, so it is registered directly.
    const orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]!.org_id as string;
    const def = { ...parentFlow('ring-b', sub('ring-a', noBack)), version: 2, builtIn: false };
    const id = '0190bbbb-0000-7000-8000-0000000000b2';
    await ctx().store.append([
      {
        streamId: `workflow:${orgId}:ring-b`,
        event: {
          type: 'WorkflowVersionRegistered',
          payload: {
            workflowVersionId: id,
            orgId,
            key: 'ring-b',
            version: 2,
            name: 'ring-b',
            department: 'support',
            definition: def as never,
            status: 'active',
          },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId, projectId: null, audience: 'org' },
      },
    ]);
    await enable(w.projectId, 'ring-a', 'ring-b');
    const card = await newCard('ring-a');
    await settle(6);
    const [kid] = await childrenOf(card.id);
    expect(kid).toBeTruthy();
    expect(await cardRow(kid!.id)).toMatchObject({ status: 'blocked' });
    expect((await refusals(kid!.id)).map((x) => x.reason)).toEqual(['cycle']);
  });
});

/** intake -> ask (sub-workflow, wait) -> check (agent) -> finished | gave_up. */
const attachFlow = (key: string) =>
  base(key, [
    intake('ask'),
    {
      id: 'ask',
      label: 'Ask',
      column: 'Ask',
      kind: 'subworkflow',
      claimRole: null,
      doneCriteria: '',
      subworkflow: sub('answering'),
      outcomes: [outcome('done', 'check'), outcome('failed', 'gave_up', 'failure')],
    },
    agentStage('check', 'finished', { outcomes: [outcome('fine', 'finished')] }),
    terminal('finished'),
    terminal('gave_up'),
  ]);
const move = (id: string, toStage: string) =>
  ok(
    w.t.req('POST', `/api/cards/${id}/move`, {
      cookie: w.owner.cookie,
      body: { toStage, reason: 'test' },
    }),
  );
const cancel = (id: string, body: Record<string, unknown>, cookie = w.owner.cookie) =>
  w.t.req('POST', `/api/cards/${id}/cancel`, { cookie, body });

describe('a manager moves a card back into a sub-workflow step whose child still runs', () => {
  it('the card waits on the open child again: no second child, a card note, and the child ends it as usual', async () => {
    await publish(attachFlow('attach-flow'));
    await enable(w.projectId, 'attach-flow');
    const card = await newCard('attach-flow');
    await tick();
    const [child] = await childrenOf(card.id);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'ask', status: 'waiting' });

    await move(card.id, 'check');
    await tick();
    expect(await cardRow(card.id)).toMatchObject({ stage: 'check', status: 'queued' });
    await move(card.id, 'ask');
    await settle();

    expect(await cardRow(card.id)).toMatchObject({ stage: 'ask', status: 'waiting' });
    expect(await childrenOf(card.id)).toHaveLength(1);
    expect(await runsOf(card.id)).toHaveLength(1);
    expect(await count('SubworkflowAttached', card.id)).toBe(1);
    const notes = await q(
      `SELECT payload->>'body' AS body FROM events WHERE type='ThreadMessagePosted' AND payload->>'threadId'=$1`,
      [card.id],
    );
    expect(notes.some((n) => /already has .* running from an earlier visit/.test(String(n.body)))).toBe(true);
    // Another pass (and a replay of the whole log) attaches nothing more.
    await sweepFromStart();
    expect(await count('SubworkflowAttached', card.id)).toBe(1);

    // The child ends: the parent leaves the step the usual way, with the fields copied back.
    await answerChild(child!.id, 'late answer');
    await settle();
    expect(await cardRow(card.id)).toMatchObject({
      stage: 'check',
      fields: { reply: 'late answer' },
    });
    expect((await runsOf(card.id))[0]).toMatchObject({ status: 'done' });
    // Tidy: nobody is to pick the queued check step up in the tests that follow.
    await ok(cancel(card.id, { reason: 'tidy' }));
    await settle();
  });
});

describe('cancelling a card that waits on a sub-workflow child', () => {
  const start = async (key: string, cfg: Record<string, unknown> = {}) => {
    await publish(parentFlow(key, sub('answering', cfg)));
    await enable(w.projectId, key);
    const card = await newCard(key);
    await tick();
    const [child] = await childrenOf(card.id);
    return { card, child: child! };
  };

  it('by default only the parent is cancelled; the child keeps running', async () => {
    const { card, child } = await start('cancel-flow');
    await ok(cancel(card.id, { reason: 'stop' }));
    await tick();
    expect(await cardRow(card.id)).toMatchObject({ status: 'cancelled' });
    expect(await cardRow(child.id)).toMatchObject({ status: 'queued' });
    // Tidy: the child is cancelled by hand so it does not take the next test's agent.
    await ok(cancel(child.id, { reason: 'tidy' }));
    await settle();
  });

  it('alsoCancelChildren cancels the open child through the normal path, with an audit reason', async () => {
    const { card, child } = await start('cancel-flow-2');
    await ok(cancel(card.id, { reason: 'customer left', alsoCancelChildren: true }));
    expect(await cardRow(card.id)).toMatchObject({ status: 'cancelled' });
    expect(await cardRow(child.id)).toMatchObject({ status: 'cancelled' });
    const ev = await q(`SELECT payload FROM events WHERE type='CardCancelled' AND payload->>'cardId'=$1`, [
      child.id,
    ]);
    expect(ev).toHaveLength(1);
    expect(String(ev[0]!.payload.reason)).toContain(`Cancelled together with ${card.ref}`);
    expect(String(ev[0]!.payload.reason)).toContain('customer left');
    await tick();
    // The run is recorded as cancelled and the cancelled parent is left alone.
    expect((await runsOf(card.id))[0]).toMatchObject({ status: 'cancelled' });
    expect(await cardRow(card.id)).toMatchObject({ status: 'cancelled', stage: 'ask' });
  });

  it('the flag changes nothing for a card that waits on no child', async () => {
    const card = await newCard('answering');
    await ok(cancel(card.id, { reason: 'plain', alsoCancelChildren: true }));
    expect(await cardRow(card.id)).toMatchObject({ status: 'cancelled' });
    await settle();
  });

  it('the panel offers the cancel only to a viewer who may cancel the child', async () => {
    const { card, child } = await start('cancel-flow-3', { project: { projectId: ansProjectId } });
    const mine = await detail(card.id);
    expect(mine.subworkflows.children[0]).toMatchObject({ state: 'open', child: { canCancel: true } });
    // Another manager of the card's project who is not in the child's project has nothing to tick.
    const outsider = await addMember(w, 'outsider');
    const theirs = await detail(card.id, outsider.cookie);
    expect(theirs.subworkflows.children[0].child).toMatchObject({ visible: false, canCancel: false });
    expect((await cancel(card.id, { reason: 'no' }, outsider.cookie)).status).toBe(403);
    await ok(cancel(card.id, { reason: 'done here', alsoCancelChildren: true }));
    expect(await cardRow(child.id)).toMatchObject({ status: 'cancelled', project_id: ansProjectId });
    const after = await detail(card.id);
    expect(after.subworkflows.children[0].child.canCancel).toBe(false);
    await settle();
  });

  it('the request body is validated (the flag must be a boolean)', async () => {
    const card = await newCard('answering');
    expect((await cancel(card.id, { reason: 'x', alsoCancelChildren: 'yes' })).status).toBe(400);
    await ok(cancel(card.id, { reason: 'x' }));
    await settle();
  });
});

describe('GET /api/subworkflow-targets', () => {
  it('lists approved workflows with their fields and the projects the caller belongs to, with what is enabled', async () => {
    await enable(w.projectId, 'answering');
    const res = await ok<any>(w.t.req('GET', '/api/subworkflow-targets', { cookie: w.owner.cookie }));
    const answering = res.workflows.find((x: any) => x.key === 'answering');
    expect(answering).toMatchObject({ name: 'answering', builtIn: false, cardTypes: ['support'] });
    expect(answering.fields).toEqual(
      expect.arrayContaining([
        { key: 'customer', label: 'Customer', kind: 'text', required: true },
        { key: 'answer', label: 'Answer', kind: 'text', required: false },
      ]),
    );
    // Built-ins are offered, the internal bug-fix flow is not.
    expect(res.workflows.some((x: any) => x.builtIn)).toBe(true);
    expect(res.workflows.some((x: any) => x.key === 'code-bugfix')).toBe(false);
    const ids = res.projects.map((x: any) => x.id);
    expect(ids).toEqual(expect.arrayContaining([w.projectId, ansProjectId]));
    expect(res.projects.find((x: any) => x.id === ansProjectId)).toMatchObject({
      key: 'ANS',
      enabledWorkflows: ['answering'],
    });
    expect(res.projects.find((x: any) => x.id === w.projectId).enabledWorkflows).toContain('answering');
  });

  it('lists only the projects the caller is a member of', async () => {
    const other = await addMember(w, 'targets-member');
    const res = await ok<any>(
      w.t.req('GET', `/api/subworkflow-targets?projectId=${w.projectId}`, { cookie: other.cookie }),
    );
    expect(res.projects.map((x: any) => x.id)).toEqual([w.projectId]);
    expect(res.workflows.length).toBeGreaterThan(0);
  });

  it('needs a signed-in user and an organisation the caller belongs to', async () => {
    expect((await w.t.req('GET', '/api/subworkflow-targets')).status).toBe(401);
    const stranger = await w.t.userSession(`stranger-${Date.now()}@example.test`);
    const res = await w.t.req('GET', '/api/subworkflow-targets', { cookie: stranger.cookie });
    // Either refused, or the stranger's own organisation: never ours.
    if (res.status === 200) expect(res.body.projects.map((x: any) => x.id)).not.toContain(w.projectId);
    else expect([403, 404]).toContain(res.status);
  });
});

describe('crash safety and replay', () => {
  it('replaying the whole event log (cursor back at 0) starts and resolves nothing twice', async () => {
    const before = {
      started: await count('SubworkflowStarted'),
      resolved: await count('SubworkflowResolved'),
      refused: await count('SubworkflowRefused'),
      cards: Number((await q('SELECT count(*)::int AS n FROM cards'))[0]!.n),
      runs: Number((await q('SELECT count(*)::int AS n FROM subworkflow_runs'))[0]!.n),
    };
    expect(before.started).toBeGreaterThan(5);
    await sweepFromStart();
    await sweepFromStart();
    expect({
      started: await count('SubworkflowStarted'),
      resolved: await count('SubworkflowResolved'),
      refused: await count('SubworkflowRefused'),
      cards: Number((await q('SELECT count(*)::int AS n FROM cards'))[0]!.n),
      runs: Number((await q('SELECT count(*)::int AS n FROM subworkflow_runs'))[0]!.n),
    }).toEqual(before);
  });

  it('concurrent passes start one child; a pass that dies before the cursor moves is repeated harmlessly', async () => {
    await publish(parentFlow('race', sub('answering')));
    await enable(w.projectId, 'race');
    const card = await newCard('race');
    const results = await Promise.all([
      enterSubworkflow(ctx(), card.id),
      enterSubworkflow(ctx(), card.id),
      sweepSubworkflows(ctx()),
      sweepSubworkflows(ctx()),
    ]);
    expect(results.slice(0, 2).filter(Boolean)).toHaveLength(1);
    expect(await childrenOf(card.id)).toHaveLength(1);
    expect(await count('SubworkflowStarted', card.id)).toBe(1);
    // The child ends; two resolutions race, the parent moves once.
    const [child] = await childrenOf(card.id);
    await answerChild(child!.id, 'r');
    const res = await Promise.all([
      resolveSubworkflow(ctx(), child!.id),
      resolveSubworkflow(ctx(), child!.id),
      sweepSubworkflows(ctx()),
    ]);
    expect(res.slice(0, 2).filter(Boolean)).toHaveLength(1);
    expect(await count('SubworkflowResolved', card.id)).toBe(1);
    expect(
      Number(
        (
          await q(
            `SELECT count(*)::int AS n FROM events WHERE type='StageCompleted' AND payload->>'cardId'=$1 AND payload->>'fromStage'='ask'`,
            [card.id],
          )
        )[0]!.n,
      ),
    ).toBe(1);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'finished', fields: { reply: 'r' } });
  });

  it('a pass that fails leaves the cursor in front of the event, and the next pass handles it', async () => {
    await publish(parentFlow('flaky', sub('answering')));
    await enable(w.projectId, 'flaky');
    const card = await newCard('flaky');
    // The event store fails once, as a database error in the middle of the start would.
    const store = ctx().store as any;
    const realAppend = store.append.bind(store);
    let broken = true;
    store.append = async (...args: unknown[]) => {
      if (broken) {
        broken = false;
        throw new Error('database went away');
      }
      return realAppend(...args);
    };
    try {
      await sweepSubworkflows(ctx());
    } finally {
      store.append = realAppend;
    }
    expect(await childrenOf(card.id)).toEqual([]);
    expect(await cardRow(card.id)).toMatchObject({ status: 'queued', stage: 'ask' });
    await sweepSubworkflows(ctx());
    expect(await childrenOf(card.id)).toHaveLength(1);
  });
});

describe('rebuild', () => {
  it('rebuilding the projections reproduces the sub-workflow runs and the cards they touched', {
    timeout: 180_000,
  }, async () => {
    const snapshot = async () => {
      const out: Record<string, string[]> = {};
      for (const table of PROJECTION_TABLES) {
        const drop = table === 'card_transitions' || table === 'card_activity' ? ` - 'id'` : '';
        const extra =
          table === 'cards'
            ? ` - 'lease_expires_at'`
            : table === 'workstations'
              ? ` - 'connected' - 'last_seen_at' - 'runtimes' - 'hostname' - 'platform' - 'runner_version'`
              : table === 'users'
                ? ` - 'last_login_at'`
                : table === 'shifts'
                  ? ` - 'progress_tail' - 'accepted_at'`
                  : '';
        const rs = await q(`SELECT (to_jsonb(t)${drop}${extra})::text AS j FROM "${table}" t`);
        out[table] = rs.map((x) => x.j as string).sort();
      }
      return out;
    };
    const before = await snapshot();
    expect(before.subworkflow_runs!.length).toBeGreaterThan(8);
    await rebuildProjections(ctx().pool, ctx().store);
    expect(await snapshot()).toEqual(before);
  });
});

/** Puts the cursor back to the start of the log and runs a pass: every event is looked at again. */
async function sweepFromStart() {
  await q('UPDATE workflow_reactor_cursor SET last_seq = 0 WHERE id = 1');
  await sweepSubworkflows(ctx());
}
