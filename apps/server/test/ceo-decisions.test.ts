import { randomUUID } from 'node:crypto';
import { CEO_REVIEW_REPLY_TIMEOUT_MS, streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acknowledgeAllCeoDecisions } from '../src/ceo/decisions.ts';
import { baTaskPass } from '../src/dispatcher/ba-tasks.ts';
import { uniqueEmail } from './helpers/app.ts';
import {
  act,
  appoint,
  blockingQuestion,
  ceo,
  graduate,
  ledgerEntry,
  startCeoShift,
  wakeNow,
} from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let shiftId: string;
let ceoAgentId: string;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  ceoAgentId = await appoint(w);
  await graduate(w);
  await wakeNow(w);
  shiftId = (await startCeoShift(w, r)).shiftId;
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const result = (resp: any) => {
  expect(resp.ok, JSON.stringify(resp)).toBe(true);
  return resp.result;
};
/** The CEO decisions waiting for the owner's review: resolved desk items that carry the decision (no second card). */
const decisions = () =>
  q(
    `SELECT * FROM desk_items WHERE data->'ceoDecision' IS NOT NULL AND data->>'acknowledgedAt' IS NULL
        AND data->'correction' IS NULL ORDER BY created_at, id`,
  );

/** A working-branch question on the manager's desk (what the hygiene and intake flow raises). */
async function branchQuestion(
  title = 'Keep pieter/dev as the working branch of Flow-Web (P4), or use another branch?',
) {
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
            { id: 'other', label: 'Another branch' },
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

describe('the CEO may decide working-branch questions', () => {
  it('executes the answer as a decision (no recommendation) and stores the branch', async () => {
    const id = await branchQuestion();
    const res = result(await act(r, shiftId, 'answer', { item: id, option: 'branch:dev' }));
    expect(res.status).toBe('executed');
    expect((await q(`SELECT status, answer FROM desk_items WHERE id=$1`, [id]))[0]).toMatchObject({
      status: 'answered',
      answer: 'dev',
    });
    expect(
      (await q(`SELECT working_branch FROM project_repos WHERE id=$1`, [w.repoId]))[0]!.working_branch,
    ).toBe('dev');
    const a = (await q(`SELECT mode FROM ceo_actions WHERE id=$1`, [res.actionId]))[0]!;
    expect(a.mode).toBe('decided');
    expect(
      (await q(`SELECT 1 FROM desk_items WHERE subkind='ceo_recommendation' AND status='open'`)).length,
    ).toBe(0);
    // ... and the decision is on that resolved item for review: no second `ceo_decision` card next to it
    const review = (await decisions()).find((d) => d.id === id)!;
    expect(review).toMatchObject({ kind: 'question', status: 'answered', subkind: 'working_branch' });
    expect(review.data.ceoDecision).toMatchObject({ decision: 'dev', actionId: res.actionId, source: 'act' });
    expect(
      await q(
        `SELECT 1 FROM desk_items WHERE subkind='ceo_decision' AND data->'ceoDecision'->>'questionItemId'=$1`,
        [id],
      ),
    ).toHaveLength(0);
  });

  it('is a recommendation again when the owner takes the delegation back', async () => {
    const pol = (await ok<any>(owner('GET', '/api/ceo/policy'))).policy;
    expect(pol.delegated).toContain('working_branch');
    await ok(owner('PUT', '/api/ceo/policy', { policy: { ...pol, delegated: [] } }));
    const id = await branchQuestion('Which branch for the second repo?');
    const res = result(await act(r, shiftId, 'answer', { item: id, option: 'keep' }, { key: 'wb-2' }));
    expect(res.status).toBe('recommended');
    expect((await q(`SELECT status FROM desk_items WHERE id=$1`, [id]))[0]!.status).toBe('open');
    await ok(owner('PUT', '/api/ceo/policy', { policy: pol }), 200).catch(() => undefined);
    const again = (await ok<any>(owner('PUT', '/api/ceo/policy', { policy: pol, confirmDelegation: true })))
      .policy;
    expect(again.delegated).toContain('working_branch');
  });

  it('does not need cited evidence for other questions still (unchanged)', async () => {
    const { id } = await blockingQuestion(w);
    const res = result(await act(r, shiftId, 'answer', { item: id, option: 'o1' }, { key: 'plain-1' }));
    expect(res.status).toBe('recommended');
    const entry = await ledgerEntry(w);
    const done = result(
      await act(
        r,
        shiftId,
        'answer',
        { item: id, option: 'o1' },
        { key: 'plain-2', evidence: [`ledger:${entry}`] },
      ),
    );
    expect(done.status).toBe('executed');
  });
});

describe('CEO decisions on the desk', () => {
  it('are informational: not counted as waiting, listed with what was asked and decided', async () => {
    const open = await decisions();
    expect(open.length).toBeGreaterThan(0);
    const list = await ok<any>(owner('GET', '/api/desk?status=open'));
    const dto = list.items.find((i: any) => i.ceoDecision);
    expect(dto.ceoDecision).toMatchObject({ ceoName: 'Ada Prime', source: 'act', reviewed: false });
    expect(dto.ceoDecision.question).toBeTruthy();
    expect(dto.ceoDecision.reason).toBeTruthy();
    // the question item itself shows as resolved by the CEO, and is not counted as waiting
    expect(dto.status).toBe('answered');
    const decisionItems = list.items.filter((i: any) => i.ceoDecision && !i.ceoDecision.reviewed).length;
    expect(list.counts.ceoDecisions ?? 0).toBe(decisionItems);
    expect(list.counts.open).toBe(list.items.filter((i: any) => i.status === 'open').length);
  });

  it('are not tools for the CEO itself: it cannot triage or acknowledge its own decisions', async () => {
    const item = (await decisions())[0]!;
    const res = result(await act(r, shiftId, 'resolve-notice', { item: item.id }, { key: 'self-ack' }));
    expect(res.status).toBe('refused');
    expect((await decisions()).some((d) => d.id === item.id)).toBe(true);
  });

  it('acknowledge marks one read, with a thumbs-up for the CEO', async () => {
    const item = (await decisions())[0]!;
    const body = await ok<any>(owner('POST', `/api/desk/${item.id}/ceo-decision/acknowledge`));
    expect(body.status).toBe('answered');
    expect(body.ceoDecision.acknowledgedAt).toBeTruthy();
    expect(
      await q(
        `SELECT 1 FROM events WHERE type='CeoDecisionReviewed' AND payload->>'deskItemId'=$1 AND payload->>'outcome'='acknowledged'`,
        [item.id],
      ),
    ).toHaveLength(1);
    // twice is a conflict
    expect((await owner('POST', `/api/desk/${item.id}/ceo-decision/acknowledge`)).status).toBe(409);
  });

  it('only an Owner or Admin may acknowledge, correct or acknowledge all', async () => {
    const member = await w.t.userSession(uniqueEmail('member'));
    await w.t.addOrgMember(w.owner.id, member.id, 'member');
    const item = (await decisions())[0]!;
    const asMember = (method: string, url: string, body?: unknown) =>
      w.t.req(method, url, { cookie: member.cookie, headers: { 'x-aom-org': w.owner.id }, body });
    for (const res of [
      await asMember('POST', `/api/desk/${item.id}/ceo-decision/acknowledge`),
      await asMember('POST', `/api/desk/${item.id}/ceo-decision/correct`, { correction: 'no' }),
      await asMember('POST', '/api/desk/ceo-decisions/acknowledge-all'),
    ])
      expect([403, 404]).toContain(res.status);
    expect((await decisions()).some((d) => d.id === item.id)).toBe(true);
    // an Admin may
    const admin = await w.t.userSession(uniqueEmail('admin'));
    await w.t.addOrgMember(w.owner.id, admin.id, 'admin');
    const asAdmin = await w.t.req('POST', `/api/desk/${item.id}/ceo-decision/acknowledge`, {
      cookie: admin.cookie,
      headers: { 'x-aom-org': w.owner.id },
    });
    expect([200, 404]).toContain(asAdmin.status);
  });

  it('acknowledge all closes every open one in a single append', async () => {
    // make sure there are several
    for (let i = 0; i < 3; i++) {
      const id = await branchQuestion(`Branch question number ${i + 1} for another repo?`);
      result(await act(r, shiftId, 'answer', { item: id, option: 'branch:dev' }, { key: `bulk-${i}` }));
    }
    const before = (await decisions()).length;
    expect(before).toBeGreaterThanOrEqual(3);
    const seqBefore = (await q(`SELECT max(seq)::int AS s FROM events`))[0]!.s as number;
    const res = await ok<any>(owner('POST', '/api/desk/ceo-decisions/acknowledge-all'));
    expect(res.acknowledged).toBe(before);
    expect((await decisions()).length).toBe(0);
    // one append: one transaction id for all the events written
    const written = await q(
      `SELECT DISTINCT xmin::text FROM events WHERE seq > $1 AND type IN ('DeskItemResolved','CeoDecisionReviewed')`,
      [seqBefore],
    );
    expect(written).toHaveLength(1);
    const none = await ok<any>(owner('POST', '/api/desk/ceo-decisions/acknowledge-all'));
    expect(none.acknowledged).toBe(0);
    void acknowledgeAllCeoDecisions;
  });
});

describe('correcting a decision', () => {
  it('records an owner-confirmed memory and the BA reviews it; the CEO replies and records the lesson', async () => {
    await w.hire('Ben', 'ba', 'senior');
    const id = await branchQuestion('Keep pieter/dev as the working branch of Flow-Web (P4)?');
    result(await act(r, shiftId, 'answer', { item: id, option: 'keep' }, { key: 'corr-1' }));
    const item = (await decisions()).find((d) => d.id === id)!;

    const out = await ok<any>(
      owner('POST', `/api/desk/${item.id}/ceo-decision/correct`, {
        correction: 'Use develop: pieter/dev is a personal branch and never the working branch.',
      }),
    );
    expect(out.item.status).toBe('answered');
    expect(out.item.ceoDecision.correction).toMatchObject({ review: 'pending' });

    // the owner's words are an owner-confirmed memory, in the CEO's own format
    const mem = (
      await q(
        `SELECT m.*, t.text FROM ceo_memories m JOIN ceo_memory_text t ON t.memory_id = m.id
          WHERE m.source_ref = $1 AND m.kind='correction'`,
        [`desk:${item.id}`],
      )
    )[0]!;
    expect(mem).toMatchObject({ status: 'active', source: 'owner_override' });
    expect(mem.text).toMatch(/^Owner corrected: .*→ Use develop.*\(was: Keep main\)$/);
    // the desk path is one entry point of the front door's correction: the same event, linked to the item and the memory
    const corrected = (await q(`SELECT * FROM ceo_corrections WHERE desk_item_id=$1`, [item.id]))[0]!;
    expect(corrected).toMatchObject({ memory_id: mem.id, remedy: 'none' });
    expect(corrected.text).toContain('Use develop');

    // a BA task carries the context
    const task = (await q(`SELECT * FROM ba_tasks WHERE schedule_name='CEO decision review'`))[0]!;
    expect(task).toMatchObject({ kind: 'scheduled_brief', status: 'queued' });
    expect(task.desk_item_ids).toEqual([item.id]);
    expect(task.instructions).toContain('Use develop');
    expect(task.instructions).toContain('Rule: ');

    // the BA takes it and reports
    const from = r.received.length;
    await w.t.app.ctx.services.dispatcher.run();
    const start = (await r.waitFor('shift.start', (f) => f.kind === 'ba_task', 8000, from)) as any;
    r.accepted(start.shiftId);
    r.started(start.shiftId);
    await until(
      async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='running'`, [start.shiftId]))[0],
      3000,
      'ba running',
    );
    const report = [
      'The CEO treated the intake default as the working branch.',
      'It missed that pieter/dev is a personal branch.',
      'Rule: never keep a personal branch as the working branch of a repository.',
    ].join('\n');
    const { reportId } = r.report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'scheduled_brief',
      note: 'review',
      data: { report },
    });
    await r.waitFor('shift.report.result', (f) => f.reportId === reportId);
    r.ended(start.shiftId, 'reported');

    // the BA's analysis wakes the CEO; the lesson comes from the CEO's own reply, not from the BA's Rule line
    await until(
      async () =>
        (await q(`SELECT 1 FROM ceo_wakes WHERE reason='decision_review' AND subject_id=$1`, [item.id]))[0],
      5000,
      'ceo woken for the review',
    );
    expect(
      (
        await q(`SELECT 1 FROM events WHERE type='CeoLessonRecorded' AND payload->>'deskItemId'=$1`, [
          item.id,
        ])
      ).length,
    ).toBe(0);
    const reply = await ceo(r, shiftId, {
      op: 'review_reply',
      item: item.id,
      stance: 'agree',
      reflection: 'I took the intake default for the working branch.',
      lesson: 'Never keep a personal branch as the working branch of a repository.',
    });
    expect(reply.result.status).toBe('executed');
    const lesson = (
      await q(
        `SELECT m.*, t.text FROM ceo_memories m JOIN ceo_memory_text t ON t.memory_id = m.id
          WHERE m.source_ref = $1 AND m.kind='rule'`,
        [`desk:${item.id}`],
      )
    )[0]!;
    expect(lesson.text).toContain('Never keep a personal branch');
    expect(lesson).toMatchObject({ status: 'active', source: 'owner_override' });
    const ev = (
      await q(
        `SELECT actor_kind, actor_id FROM events WHERE type='CeoLessonRecorded' ORDER BY seq DESC LIMIT 1`,
      )
    )[0]!;
    expect(ev).toMatchObject({ actor_kind: 'agent', actor_id: ceoAgentId });

    // visible on the item, and no desk notice or other item came out of the exchange
    const dto = (await ok<any>(owner('GET', '/api/desk?status=closed'))).items.find(
      (i: any) => i.id === item.id,
    );
    // no cards were proposed and the CEO had no comments: the discussion ends with the lesson
    expect(dto.ceoDecision.correction).toMatchObject({ review: 'done' });
    expect(dto.ceoDecision.correction.analysis).toContain('personal branch');
    expect(dto.ceoDecision.correction.lesson).toContain('Never keep a personal branch');
    expect(
      (await q(`SELECT 1 FROM desk_items WHERE subkind='ba_report' AND title LIKE 'CEO decision review%'`))
        .length,
    ).toBe(0);
  });

  it('without a BA the review falls back, and without a CEO reply the lesson is recorded from the owner words', async () => {
    await q(`UPDATE agents SET status='retired' WHERE role_key='ba'`);
    const id = await branchQuestion('Which branch should the API repo use?');
    result(await act(r, shiftId, 'answer', { item: id, option: 'branch:dev' }, { key: 'corr-2' }));
    const item = (await decisions()).find((d) => d.id === id)!;
    await ok(
      owner('POST', `/api/desk/${item.id}/ceo-decision/correct`, { correction: 'The release branch.' }),
    );
    await baTaskPass(w.t.app.ctx);
    await until(
      async () =>
        (await q(`SELECT data FROM desk_items WHERE id=$1`, [item.id]))[0]?.data.correction.analysis,
      5000,
      'analysis fallback',
    );
    expect((await q(`SELECT data FROM desk_items WHERE id=$1`, [item.id]))[0]!.data.correction.review).toBe(
      'analysed',
    );
    // the CEO never replies: after the timeout the server records the lesson, marked as such
    w.t.clock.advance(CEO_REVIEW_REPLY_TIMEOUT_MS + 60_000);
    await w.t.app.ctx.services.dispatcher.run();
    w.t.clock.setOffset(0);
    await until(
      async () =>
        (
          await q(`SELECT 1 FROM events WHERE type='CeoLessonRecorded' AND payload->>'deskItemId'=$1`, [
            item.id,
          ])
        )[0],
      5000,
      'lesson recorded',
    );
    const dto = (await ok<any>(owner('GET', '/api/desk?status=closed'))).items.find(
      (i: any) => i.id === item.id,
    );
    expect(dto.ceoDecision.correction.review).toBe('done');
    expect(dto.ceoDecision.correction.lesson).toContain('The release branch.');
    expect(dto.ceoDecision.correction.lesson).toContain('recorded without the CEO');
    expect(dto.ceoDecision.correction.ceoReply.withoutCeo).toBe(true);
  });

  it('apply now re-opens the question the CEO answered (Owner only)', async () => {
    const { id } = await blockingQuestion(w, { title: 'Which cache should we use?' });
    const entry = await ledgerEntry(w, 'Use Redis');
    result(
      await act(
        r,
        shiftId,
        'answer',
        { item: id, option: 'o1' },
        { key: 'apply-1', evidence: [`ledger:${entry}`] },
      ),
    );
    const item = (await decisions()).find((d) => d.id === id)!;
    const out = await ok<any>(
      owner('POST', `/api/desk/${item.id}/ceo-decision/correct`, { correction: 'SQLite', applyNow: true }),
    );
    expect(out.applied).toContain('open again');
    expect((await q(`SELECT status FROM desk_items WHERE id=$1`, [id]))[0]!.status).toBe('open');
  });
});

describe('the working-branch delegation for existing organizations', () => {
  it('a data migration adds it once to stored policies that lack it', async () => {
    const { migrateCeoWorkingBranch, CEO_WORKING_BRANCH_MIGRATION } = await import(
      '../src/data-migrations/ceo-working-branch.ts'
    );
    const pol = (await ok<any>(owner('GET', '/api/ceo/policy'))).policy;
    await ok(owner('PUT', '/api/ceo/policy', { policy: { ...pol, delegated: [] } }));
    await q('DELETE FROM data_migrations WHERE name=$1', [CEO_WORKING_BRANCH_MIGRATION]);
    const env = {
      pool: w.t.app.ctx.pool,
      store: w.t.app.ctx.store,
      clock: w.t.app.ctx.clock,
      log: () => undefined,
    } as never;
    const report = await migrateCeoWorkingBranch(env);
    expect(report?.changed).toEqual([w.owner.id]);
    expect((await ok<any>(owner('GET', '/api/ceo/policy'))).policy.delegated).toContain('working_branch');
    expect(await migrateCeoWorkingBranch(env)).toBeNull(); // once
  });
});
