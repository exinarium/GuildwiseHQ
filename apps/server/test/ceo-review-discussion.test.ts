import { randomUUID } from 'node:crypto';
import { CEO_REVIEW_REPLY_TIMEOUT_MS, splitFixPlan, streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addMemory } from '../src/ceo/memory.ts';
import { baTaskPass } from '../src/dispatcher/ba-tasks.ts';
import {
  act,
  appoint,
  blockingQuestion,
  ceo,
  graduate,
  keepOnline,
  ledgerEntry,
  startCeoShift,
  wakeNow,
} from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

const send = vi.hoisted(() => vi.fn());
vi.mock('web-push', () => ({ default: { sendNotification: send, generateVAPIDKeys: () => ({}) } }));

/**
 * The CEO-BA discussion after the owner corrected a CEO decision: BA analysis (consequences, proposed fix cards), the CEO's
 * reply (a lesson in its own words), the BA's final turn (it creates the fix cards). Exactly three turns.
 */

let w: World;
let r: FakeRunner;
let ceoAgentId: string;
let baId: string;
let betaId: string;
let memoryId: string;
const decisionOf: Record<string, string> = {};

beforeAll(async () => {
  w = await createWorld({
    env: {
      AOM_FIRST_RUN_HIRE_CAP: 'false',
      AOM_MOCK_UI: 'true',
      AOM_VAPID_PUBLIC_KEY: 'BPublicKeyForTests',
      AOM_VAPID_PRIVATE_KEY: 'privateKeyForTests',
      AOM_VAPID_SUBJECT: 'mailto:ops@example.com',
      AOM_PUSH_OFFLINE_GRACE_SECONDS: '0',
    },
  });
  send.mockResolvedValue({ statusCode: 201 });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  ceoAgentId = await appoint(w);
  await graduate(w);
  await w.hire('Ben', 'ba', 'senior');
  baId = (await q(`SELECT id FROM agents WHERE name='Ben'`))[0]!.id as string;
  // a second project, so fix work can span projects
  betaId = (
    await ok<any>(
      w.t.req('POST', '/api/projects', { cookie: w.owner.cookie, body: { key: 'BET', name: 'Beta' } }),
      201,
    )
  ).project.id;
  await ok(
    w.t.req('POST', '/api/push/subscriptions', {
      cookie: w.owner.cookie,
      body: {
        endpoint: `https://push.example.com/send/${randomUUID()}`,
        keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
      },
    }),
    201,
  );
  memoryId = await addMemory(w.t.app.ctx, {
    orgId: w.owner.id,
    kind: 'decision_pattern',
    scope: 'desk:desk.answer_question',
    source: 'owner_training',
    confidence: 0.7,
    status: 'active',
    text: 'Questions about the working branch are answered with the intake default',
  });
  // the CEO takes a handful of decisions, in one shift
  await wakeNow(w);
  const shiftId = (await startCeoShift(w, r)).shiftId;
  const entry = await ledgerEntry(w, 'Use the intake default');
  for (const name of ['card', 'agree', 'disagree', 'nofix', 'timeout', 'nobafinal', 'paused', 'memory']) {
    if (name === 'card') {
      const { id } = await blockingQuestion(w, { title: 'Which cache should we use?' });
      await act(
        r,
        shiftId,
        'answer',
        { item: id, option: 'o1' },
        { key: `d-${name}`, evidence: [`ledger:${entry}`, `memory:${memoryId}`] },
      );
      decisionOf[name] = await decisionFor(id);
    } else {
      const id = await branchQuestion(`Which branch for ${name}?`);
      await act(r, shiftId, 'answer', { item: id, option: 'branch:dev' }, { key: `d-${name}` });
      decisionOf[name] = await decisionFor(id);
    }
  }
  await finishCeo(shiftId);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const ctx = () => w.t.app.ctx;

async function decisionFor(questionId: string): Promise<string> {
  const rowsFound = await q(
    `SELECT id FROM desk_items WHERE subkind='ceo_decision' AND data->'ceoDecision'->>'questionItemId'=$1`,
    [questionId],
  );
  return rowsFound[0]!.id as string;
}

async function branchQuestion(title: string) {
  await q(`UPDATE project_repos SET working_branch='main' WHERE id=$1`, [w.repoId]);
  const id = randomUUID();
  await seed(w, [
    {
      streamId: streamId.desk(id),
      event: {
        type: 'QuestionRaised',
        payload: {
          deskItemId: id,
          projectId: w.projectId,
          askedBy: { kind: 'system' },
          doing: 'Confirming the working branch',
          question: title,
          options: [
            { id: 'keep', label: 'Keep main' },
            { id: 'branch:dev', label: 'dev' },
          ],
          recommendation: 'keep',
          blocking: false,
          routedTo: 'manager',
          pinned: false,
          affectedCardIds: [],
          subkind: 'working_branch',
          data: { repoId: w.repoId, reason: 'intake', current: 'main' },
        },
      },
      actor: { kind: 'system', id: null },
      scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' },
    },
  ]);
  return id;
}

/** The wakes the setup raised (questions, desk items) are not what these tests are about: only the review wakes stay. */
const quietOtherWakes = () =>
  q(`UPDATE ceo_wakes SET status='done' WHERE reason <> 'decision_review' AND status = 'pending'`);

/** The terminal report and the end of a CEO shift, as the runner does it. */
async function finishCeo(shiftId: string) {
  const { reportId } = r.report(shiftId, {
    kind: 'outcome',
    outcomeId: 'ceo_done',
    note: 'done',
    data: { summary: 'handled' },
  });
  await r.waitFor('shift.report.result', (f) => f.reportId === reportId);
  r.ended(shiftId, 'reported');
  await r.barrier();
  await quietOtherWakes();
}

const correct = (id: string, correction: string) =>
  ok<any>(owner('POST', `/api/desk/${id}/ceo-decision/correct`, { correction }));
const itemRow = async (id: string) => (await q(`SELECT * FROM desk_items WHERE id=$1`, [id]))[0]!;
const corrOf = async (id: string) => (await itemRow(id)).data.correction;
const events = (type: string, id: string) =>
  q(`SELECT * FROM events WHERE type=$1 AND payload->>'deskItemId'=$2 ORDER BY seq`, [type, id]);

/** The BA takes the queued task, reads its brief and reports; returns the `shift.start` frame it got. */
async function baTurn(report: string): Promise<any> {
  await keepOnline(w);
  await quietOtherWakes();
  await q(`UPDATE agents SET last_shift_ended_at = NULL WHERE role_key='ba'`);
  const from = r.received.length;
  await ctx().services.dispatcher.run();
  const start = (await r.waitFor('shift.start', (f) => f.kind === 'ba_task', 8000, from)) as any;
  r.accepted(start.shiftId);
  r.started(start.shiftId);
  await until(
    async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='running'`, [start.shiftId]))[0],
    3000,
    'ba running',
  );
  const { reportId } = r.report(start.shiftId, {
    kind: 'outcome',
    outcomeId: 'scheduled_brief',
    note: 'review',
    data: { report },
  });
  await r.waitFor('shift.report.result', (f) => f.reportId === reportId);
  r.ended(start.shiftId, 'reported');
  await r.barrier();
  return start;
}

/** The CEO is woken for its turn; returns the `shift.start` frame (its brief) and the shift id. */
async function ceoTurn(): Promise<{ brief: string; shiftId: string }> {
  await q(`UPDATE ceo_wakes SET urgency='urgent' WHERE reason='decision_review' AND status='pending'`);
  const from = r.received.length;
  const start = await startCeoShift(w, r, from);
  return { brief: start.ceo.brief as string, shiftId: start.shiftId as string };
}

const plan = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    consequences: 'Two cards were built on the personal branch and one was merged.',
    fixCards: [
      {
        title: 'Re-point the intake default to develop',
        project: 'TOY',
        cardType: 'bug',
        change: 'Stop using the intake default as the working branch.',
        acceptanceCriteria: ['The working branch is develop'],
      },
      {
        title: 'Move the merged work onto develop',
        project: 'BET',
        cardType: 'bug',
        change: 'Cherry-pick the merged commits onto develop.',
        acceptanceCriteria: ['develop contains the commits', 'the personal branch is not used'],
        dependsOn: ['Re-point the intake default to develop'],
      },
    ],
    ...extra,
  });
const analysisReport = (p: string = plan()) =>
  [
    'The CEO treated the intake default as the working branch.',
    'It missed that the branch is personal.',
    'Rule: never keep a personal branch as the working branch.',
    '',
    '```json',
    p,
    '```',
  ].join('\n');

const REPLY = {
  stance: 'agree' as const,
  reflection: 'I trusted the intake default without checking who owns the branch.',
  lesson: 'Check whether a branch is personal before keeping it as the working branch.',
};

describe('the plan block of a BA report', () => {
  it('is split from the prose and validated', () => {
    const { prose, plan: p } = splitFixPlan(analysisReport());
    expect(prose).toContain('Rule: never keep');
    expect(prose).not.toContain('```');
    expect(p?.fixCards).toHaveLength(2);
    expect(p?.fixCards[0]).toMatchObject({ project: 'TOY', cardType: 'bug' });
    expect(splitFixPlan('no block here').plan).toBeUndefined();
    expect(splitFixPlan('```json\n{"fixCards":[{"title":""}]}\n```').error).toBeTruthy();
  });
});

describe('BA -> CEO -> BA after a correction', () => {
  it('the whole discussion: analysis with proposed cards, the CEO lesson in its own words, the BA creates the fix cards', async () => {
    const id = decisionOf.card!;
    const item0 = await itemRow(id);
    const originalCard = item0.card_id as string;
    const cardsBefore = Number((await q(`SELECT count(*)::int AS n FROM cards`))[0]!.n);
    await ctx().services.push?.flush();
    const pushesBefore = send.mock.calls.length;
    await correct(id, 'Use Redis: the team already runs it.');

    // 1. the BA's analysis task: asks for the consequences and a proposal, and carries the facts
    const task = (await q(`SELECT * FROM ba_tasks WHERE schedule_name='CEO decision review'`))[0]!;
    expect(task.instructions).toContain('CONSEQUENCES');
    expect(task.instructions).toContain('FIX WORK');
    expect(task.instructions).toContain('Do NOT create the cards');
    expect(task.instructions.length).toBeLessThanOrEqual(2000);
    const start1 = await baTurn(analysisReport());
    const brief1 = start1.baTask.reporter.brief.instructions as string;
    expect(brief1).toContain('## Facts');
    expect(brief1).toContain('Use Redis');
    expect(brief1).toContain('What the CEO decided and did since');
    expect(start1.baTask.reporter.brief.scheduleName).toBe('CEO decision review');

    // the proposal is stored, nothing is created yet, and the lesson waits for the CEO
    let c = await corrOf(id);
    expect(c.review).toBe('analysed');
    expect(c.proposedCards).toHaveLength(2);
    expect(c.consequences).toContain('personal branch');
    expect(c.analysis).not.toContain('```');
    expect(c.lesson).toBeUndefined();
    expect(Number((await q(`SELECT count(*)::int AS n FROM cards`))[0]!.n)).toBe(cardsBefore);
    expect((await events('CeoLessonRecorded', id)).length).toBe(0);

    // 2. the CEO is woken, with the whole picture in its brief
    await until(
      async () =>
        (await q(`SELECT 1 FROM ceo_wakes WHERE reason='decision_review' AND subject_id=$1`, [id]))[0],
      5000,
      'ceo woken',
    );
    const { brief, shiftId } = await ceoTurn();
    expect(brief).toContain(`## Decision review ${id}`);
    expect(brief).toContain('Which cache should we use?');
    expect(brief).toContain('Your decision:');
    expect(brief).toContain('Your reason:');
    expect(brief).toContain(`memory:${memoryId}`);
    expect(brief).toContain('intake default');
    expect(brief).toContain('Use Redis: the team already runs it.');
    expect(brief).toContain('personal branch');
    expect(brief).toContain('Re-point the intake default to develop');
    expect(brief).toContain('aom ceo review-reply');

    // review-reply records the lesson from the CEO's words
    const reply = (await ceo(r, shiftId, {
      op: 'review_reply',
      item: id,
      ...REPLY,
      cardChanges: 'Make the second card depend on the first and keep it in BET.',
    })) as any;
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    expect(reply.result.status).toBe('executed');
    const lesson = (
      await q(
        `SELECT m.*, t.text FROM ceo_memories m JOIN ceo_memory_text t ON t.memory_id = m.id
          WHERE m.source_ref=$1 AND m.kind='rule'`,
        [`desk:${id}`],
      )
    )[0]!;
    expect(lesson.text).toContain('Check whether a branch is personal');
    expect(lesson.text).toContain('discussed with the BA');
    expect(lesson).toMatchObject({ status: 'active', source: 'owner_override' });
    const ev = (await events('CeoLessonRecorded', id))[0]!;
    expect(ev).toMatchObject({ actor_kind: 'agent', actor_id: ceoAgentId });
    expect(ev.payload).toMatchObject({
      recordedBy: 'ceo',
      stance: 'agree',
      reflection: REPLY.reflection,
      finalTurn: true,
    });
    // the memory the decision leaned on is replaced; the owner's correction memory stays
    expect((await q(`SELECT status FROM ceo_memories WHERE id=$1`, [memoryId]))[0]!.status).toBe('retired');
    expect(
      (
        await q(`SELECT status FROM ceo_memories WHERE source_ref=$1 AND kind='correction'`, [`desk:${id}`])
      )[0]!.status,
    ).toBe('active');
    c = await corrOf(id);
    expect(c.review).toBe('lesson');
    // exactly one round: a second reply is refused
    const again = (await ceo(r, shiftId, { op: 'review_reply', item: id, ...REPLY })) as any;
    expect(again.result.status).toBe('refused');
    await finishCeo(shiftId);

    // 3. the BA's final turn: gets the CEO reply and adjusts; the server creates the cards it lists
    expect(
      (
        await q(`SELECT count(*)::int AS n FROM ba_tasks WHERE schedule_name='CEO decision review (final)'`)
      )[0]!.n,
    ).toBe(1);
    const final = JSON.stringify({
      fixCards: [
        {
          title: 'Re-point the intake default to develop',
          project: 'TOY',
          cardType: 'bug',
          change: 'Stop using the intake default as the working branch.',
          acceptanceCriteria: ['The working branch is develop'],
        },
        {
          title: 'Move the merged work onto develop',
          project: 'BET',
          cardType: 'bug',
          change: 'Cherry-pick the merged commits onto develop.',
          acceptanceCriteria: ['develop contains the commits'],
          dependsOn: ['Re-point the intake default to develop'],
        },
      ],
    });
    const start2 = await baTurn(
      `Kept both cards; the second now depends on the first.\n\n\`\`\`json\n${final}\n\`\`\``,
    );
    const brief2 = start2.baTask.reporter.brief.instructions as string;
    expect(start2.baTask.reporter.brief.scheduleName).toBe('CEO decision review (final)');
    expect(brief2).toContain("The CEO's reply");
    expect(brief2).toContain(REPLY.reflection);
    expect(brief2).toContain('Make the second card depend on the first');
    expect(brief2).toContain('Your earlier proposal');

    c = await corrOf(id);
    expect(c.review).toBe('done');
    expect(c.final.cards).toHaveLength(2);
    const [first, second] = c.final.cards;
    expect(first.ref).toMatch(/^TOY-/);
    expect(second.ref).toMatch(/^BET-/);
    // the cards: created by the BA agent, specified, thread notes, the dependency
    for (const fc of c.final.cards) {
      const created = (
        await q(`SELECT * FROM events WHERE type='CardCreated' AND payload->>'cardId'=$1`, [fc.cardId])
      )[0]!;
      expect(created).toMatchObject({ actor_kind: 'agent', actor_id: baId });
      expect(created.payload.origin).toBe('intake');
      // complete cards are specified; the Beta project has no repository, so its card stays a draft and says so
      const status = (await q(`SELECT status FROM cards WHERE id=$1`, [fc.cardId]))[0]!.status;
      if (fc.projectKey === 'TOY') expect(status).not.toBe('draft');
      else expect(status).toBe('draft');
      const note = (
        await q(
          `SELECT body, data FROM thread_messages WHERE thread_id=$1 AND body LIKE 'Drafted by Ben (BA) to fix CEO decision%'`,
          [fc.cardId],
        )
      )[0]!;
      expect(note.body).toContain(String(id).slice(0, 8));
      if (fc.projectKey !== 'TOY') expect(note.body).toContain('Still missing before it can be specified');
      expect(note.data).toMatchObject({ deskItemId: id, ceoReviewFix: true });
    }
    // a dependency across projects is not possible, so the second card (in BET) stands alone
    expect((await q(`SELECT 1 FROM card_dependencies WHERE card_id=$1`, [second.cardId])).length).toBe(0);
    // linked to the original card's thread and to the decision item
    const origin = (
      await q(
        `SELECT body, data FROM thread_messages WHERE thread_id=$1 AND body LIKE 'Fix cards for the corrected CEO decision%'`,
        [originalCard],
      )
    )[0]!;
    expect(origin.body).toContain(first.ref);
    expect(origin.body).toContain(second.ref);
    const concluded = (await events('CeoReviewConcluded', id))[0]!;
    expect(concluded.payload.cards.map((x: any) => x.ref)).toEqual([first.ref, second.ref]);
    // the thread of the original card tells the discussion
    const bodies = (
      await q(`SELECT body FROM thread_messages WHERE thread_id=$1 ORDER BY created_at`, [originalCard])
    ).map((m) => String(m.body));
    expect(bodies.some((b) => b.startsWith('BA review of the CEO decision'))).toBe(true);
    expect(bodies.some((b) => b.includes('agrees and records the lesson'))).toBe(true);

    // visible on the item
    const dto = (await ok<any>(owner('GET', '/api/desk?status=closed'))).items.find((i: any) => i.id === id);
    expect(dto.ceoDecision.correction).toMatchObject({
      review: 'done',
      ceoReply: { stance: 'agree', withoutCeo: false },
    });
    expect(dto.ceoDecision.correction.proposedCards).toHaveLength(2);
    expect(dto.ceoDecision.correction.final.cards).toHaveLength(2);
    expect(dto.ceoDecision.correction.lesson).toContain('Check whether a branch is personal');

    // bounded: exactly two BA tasks and one CEO wake for the item; nothing is queued any more
    expect(
      (await q(`SELECT count(*)::int AS n FROM ba_tasks WHERE desk_item_ids=$1::uuid[]`, [[id]]))[0]!.n,
    ).toBe(2);
    expect(
      (
        await q(`SELECT count(*)::int AS n FROM ceo_wakes WHERE reason='decision_review' AND subject_id=$1`, [
          id,
        ])
      )[0]!.n,
    ).toBe(1);
    await ctx().services.dispatcher.run();
    expect((await q(`SELECT count(*)::int AS n FROM ba_tasks WHERE status='queued'`))[0]!.n).toBe(0);
    // no desk notice for the BA's reports, and no push at any step
    expect(
      (await q(`SELECT 1 FROM desk_items WHERE subkind='ba_report' AND title LIKE 'CEO decision review%'`))
        .length,
    ).toBe(0);
    await ctx().services.push?.flush();
    expect(send.mock.calls.slice(pushesBefore)).toEqual([]);
  });

  it('the CEO may disagree: its view is recorded, the lesson is still its own, the correction stands; no cards, no final turn', async () => {
    const id = decisionOf.disagree!;
    await correct(id, 'Use develop.');
    await baTurn(
      analysisReport(JSON.stringify({ noFixNeeded: 'Nothing was built on the branch yet.', fixCards: [] })),
    );
    expect((await corrOf(id)).noFixReason).toContain('Nothing was built');
    const { shiftId, brief } = await ceoTurn();
    expect(brief).toContain('The BA proposes no fix cards');
    const res = (await ceo(r, shiftId, {
      op: 'review_reply',
      item: id,
      stance: 'disagree',
      reflection: 'The ledger entry I cited said main; I would decide the same again.',
      lesson: 'When the ledger and the owner disagree, ask the owner first.',
    })) as any;
    expect(res.result.status).toBe('executed');
    await finishCeo(shiftId);
    const c = await corrOf(id);
    expect(c.review).toBe('done');
    expect(c.ceoReply).toMatchObject({ stance: 'disagree', withoutCeo: false });
    expect(c.lesson).toContain('ask the owner first');
    expect(c.final.cards).toEqual([]);
    expect(c.final.summary).toContain('No fix work needed');
    // the owner's correction stands: its memory is untouched and no undo happened
    expect(
      (
        await q(`SELECT status FROM ceo_memories WHERE source_ref=$1 AND kind='correction'`, [`desk:${id}`])
      )[0]!.status,
    ).toBe('active');
    expect((await itemRow(id)).status).toBe('answered');
    // no BA final turn was needed
    expect(
      (await q(`SELECT count(*)::int AS n FROM ba_tasks WHERE desk_item_ids=$1::uuid[]`, [[id]]))[0]!.n,
    ).toBe(1);
  });

  it('"no fix work needed" and no objection from the CEO: no cards', async () => {
    const id = decisionOf.nofix!;
    const cardsBefore = Number((await q(`SELECT count(*)::int AS n FROM cards`))[0]!.n);
    await correct(id, 'Use develop.');
    await baTurn(analysisReport(JSON.stringify({ noFixNeeded: 'No work was started on the decision.' })));
    const { shiftId } = await ceoTurn();
    await ceo(r, shiftId, { op: 'review_reply', item: id, ...REPLY });
    await finishCeo(shiftId);
    const c = await corrOf(id);
    expect(c.review).toBe('done');
    expect(c.final.cards).toEqual([]);
    expect(Number((await q(`SELECT count(*)::int AS n FROM cards`))[0]!.n)).toBe(cardsBefore);
  });

  it('a CEO that does not reply: after the timeout the lesson is recorded without it and the BA still creates the cards', async () => {
    const id = decisionOf.timeout!;
    await correct(id, 'Use develop.');
    await baTurn(analysisReport(plan({ fixCards: [JSON.parse(plan()).fixCards[0]] })));
    expect((await corrOf(id)).review).toBe('analysed');
    // nothing happens before the timeout
    await ctx().services.dispatcher.run();
    expect((await corrOf(id)).lesson).toBeUndefined();
    w.t.clock.advance(CEO_REVIEW_REPLY_TIMEOUT_MS + 60_000);
    await ctx().services.dispatcher.run();
    await until(async () => (await corrOf(id)).lesson, 5000, 'lesson recorded without the CEO');
    w.t.clock.setOffset(0);
    let c = await corrOf(id);
    expect(c.lesson).toContain('recorded without the CEO');
    expect(c.ceoReply).toMatchObject({ withoutCeo: true });
    expect((await events('CeoLessonRecorded', id))[0]!.payload).toMatchObject({
      recordedBy: 'server',
      withoutCeo: true,
    });
    expect(
      (await q(`SELECT status FROM ceo_wakes WHERE reason='decision_review' AND subject_id=$1`, [id]))[0]!
        .status,
    ).toBe('dropped');
    // the BA's final turn goes on without the CEO's reply
    const start = await baTurn(
      `Nothing to change.\n\n\`\`\`json\n${JSON.stringify({ fixCards: [JSON.parse(plan()).fixCards[0]] })}\n\`\`\``,
    );
    expect(start.baTask.reporter.brief.instructions).toContain('did not reply in time');
    c = await corrOf(id);
    expect(c.review).toBe('done');
    expect(c.final.cards).toHaveLength(1);
    // a late reply is refused: no second round
    const { shiftId } = await (async () => {
      await wakeNow(w);
      return startCeoShift(w, r, r.received.length);
    })();
    const late = (await ceo(r, shiftId, { op: 'review_reply', item: id, ...REPLY })) as any;
    expect(late.result.status).toBe('refused');
    await finishCeo(shiftId);
  });

  it('when no BA takes the final turn the cards it proposed are created as they were (the CEO had no comments)', async () => {
    const id = decisionOf.nobafinal!;
    await correct(id, 'Use develop.');
    await baTurn(analysisReport(plan({ fixCards: [JSON.parse(plan()).fixCards[0]] })));
    const { shiftId } = await ceoTurn();
    await ceo(r, shiftId, { op: 'review_reply', item: id, ...REPLY });
    await finishCeo(shiftId);
    expect((await corrOf(id)).review).toBe('lesson');
    await q(`UPDATE agents SET status='retired' WHERE id=$1`, [baId]);
    await baTaskPass(ctx());
    await until(async () => (await corrOf(id)).final, 5000, 'concluded by the server');
    const c = await corrOf(id);
    expect(c.review).toBe('done');
    expect(c.final.fallback).toBe(true);
    expect(c.final.cards).toHaveLength(1);
    expect(c.final.cards[0].ref).toMatch(/^TOY-/);
    await q(`UPDATE agents SET status='active' WHERE id=$1`, [baId]);
  });

  it('fix cards on a paused project are created but do not start', async () => {
    const id = decisionOf.paused!;
    await ok(w.t.req('POST', `/api/projects/${betaId}/pause`, { cookie: w.owner.cookie, body: {} }));
    await correct(id, 'Use develop.');
    await baTurn(
      analysisReport(
        JSON.stringify({
          fixCards: [
            {
              title: 'Fix the Beta branch default',
              project: 'BET',
              change: 'Use develop in Beta.',
              acceptanceCriteria: ['develop is the default'],
            },
          ],
        }),
      ),
    );
    const { shiftId } = await ceoTurn();
    await ceo(r, shiftId, { op: 'review_reply', item: id, ...REPLY, cardChanges: 'Fine as it is.' });
    await finishCeo(shiftId);
    await baTurn(
      `Unchanged.\n\n\`\`\`json\n${JSON.stringify({
        fixCards: [
          {
            title: 'Fix the Beta branch default',
            project: 'BET',
            change: 'Use develop in Beta.',
            acceptanceCriteria: ['develop is the default'],
          },
        ],
      })}\n\`\`\``,
    );
    const c = await corrOf(id);
    expect(c.final.cards).toHaveLength(1);
    const cardId = c.final.cards[0].cardId;
    const from = r.received.length;
    await ctx().services.dispatcher.run();
    await r.barrier();
    expect(
      r.received.slice(from).filter((f: any) => f.type === 'shift.start' && f.brief?.card?.id === cardId),
    ).toHaveLength(0);
    expect((await q(`SELECT claim_id, status FROM cards WHERE id=$1`, [cardId]))[0]).toMatchObject({
      claim_id: null,
    });
    await ok(w.t.req('POST', `/api/projects/${betaId}/resume`, { cookie: w.owner.cookie, body: {} }));
  });

  it('an unknown project in the plan is skipped, not fatal; the other cards are created', async () => {
    const id = decisionOf.memory!;
    await correct(id, 'Use develop.');
    const cards = [
      { title: 'Nowhere', project: 'ZZZ', change: 'x', acceptanceCriteria: ['y'] },
      { title: 'Somewhere', project: 'TOY', change: 'z', acceptanceCriteria: ['w'] },
    ];
    await baTurn(analysisReport(JSON.stringify({ fixCards: cards })));
    const { shiftId } = await ceoTurn();
    await ceo(r, shiftId, { op: 'review_reply', item: id, ...REPLY, cardChanges: 'ok' });
    await finishCeo(shiftId);
    await baTurn(`Same.\n\n\`\`\`json\n${JSON.stringify({ fixCards: cards })}\n\`\`\``);
    const c = await corrOf(id);
    expect(c.final.cards.map((x: any) => x.title)).toEqual(['Somewhere']);
    expect(c.final.skipped.join(' ')).toContain('ZZZ');
  });
});

describe('who may do what', () => {
  it('the CEO can reply only to a decision under review, and only once', async () => {
    const id = decisionOf.card!;
    await wakeNow(w);
    const { shiftId } = await startCeoShift(w, r, r.received.length);
    const noItem = (await ceo(r, shiftId, { op: 'review_reply', item: randomUUID(), ...REPLY })) as any;
    expect(noItem.result.status).toBe('refused');
    const notCorrected = (await ceo(r, shiftId, {
      op: 'review_reply',
      item: decisionOf.card!,
      ...REPLY,
    })) as any;
    expect(notCorrected.result.status).toBe('refused');
    // the discussion of this one is over: there is no second round
    const over = (await ceo(r, shiftId, { op: 'review_reply', item: id, ...REPLY })) as any;
    expect(over.result.status).toBe('refused');
    await finishCeo(shiftId);
  });
});
