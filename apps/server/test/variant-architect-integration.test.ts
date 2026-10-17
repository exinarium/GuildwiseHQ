import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { designer } from './helpers/designer.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import {
  approve,
  cardRow,
  DIFF_SMALL,
  eventsOfType,
  handoff,
  pipeline,
  testPass,
} from './helpers/pipeline.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

// #10 (project variants) and #9 (architect role, investigate stage) were built in parallel: a variant of `code` v2 that
// inserts the "Investigate & design" template (a step claimed by the built-in architect that reports InvestigationData).
let w: World;
let d: ReturnType<typeof designer>;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;

const owner = () => ({ cookie: w.owner.cookie });
const variantUrl = (id = '') => `/api/projects/${w.projectId}/workflow-variants${id ? `/${id}` : ''}`;
const INSERTED = 'investigate_after_test';
const ALL_STAGES = ['spec', 'investigate', 'build', 'review', 'test', INSERTED, 'docs', 'finalize', 'done'];
const REPORT = 'docs/investigations/TOY-9-after-test.md';
const report = (over: Record<string, unknown> = {}, outcomeId = 'done') => ({
  kind: 'outcome',
  outcomeId,
  note: 'investigated',
  data: { reportPath: REPORT, summary: 'Findings after test.', location: 'repo', commit: 'def5678', ...over },
});

// The "Investigate & design" template (investigateInsertion in packages/shared/src/workflows/variant.ts).
const investigateTemplate = (after = 'test') => ({
  after,
  stage: {
    id: `investigate_after_${after}`,
    label: 'Investigate & design',
    claimRole: 'architect',
    seniorOnly: true,
    doneCriteria: 'The findings and a design are in the report.',
    data: 'investigation',
    maxShiftMinutes: 90,
  },
});
const spec = (key: string, baseVersion: number, insertions: unknown[] = [investigateTemplate()]) => ({
  key,
  name: key,
  base: { key: 'code', version: baseVersion },
  insertions,
});

async function approveVariant(body: unknown) {
  const draft = await ok<any>(w.t.req('POST', variantUrl(), { cookie: w.owner.cookie, body }), 201);
  expect(draft.issues.filter((i: any) => i.severity === 'error')).toEqual([]);
  const sub = await ok<any>(w.t.req('POST', variantUrl(`${draft.id}/submit`), owner()));
  expect((await d.resolve(sub.deskItemId, 'approved')).status).toBe(200);
  return draft;
}
const enable = (keys: string[]) =>
  ok(
    w.t.req('PUT', `/api/projects/${w.projectId}/workflows`, {
      cookie: w.owner.cookie,
      body: { enabled: keys.map((workflowKey) => ({ workflowKey, defaultCardTypes: [] })) },
    }),
  );
const tidy = async () => {
  for (const c of await q(`SELECT id FROM cards WHERE project_id=$1 AND status NOT IN ('done','cancelled')`, [
    w.projectId,
  ]))
    await ok(
      w.t.req('POST', `/api/cards/${c.id}/cancel`, { cookie: w.owner.cookie, body: { reason: 'tidy' } }),
    );
};
const toInserted = async () => {
  await p.run('Bea', handoff(), DIFF_SMALL);
  await p.run('Rex', approve());
  await p.run('Tess', testPass());
};

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  d = designer(w);
  r = await w.connectRunner();
  p = pipeline(w, r);
  await w.hire('Bea', 'builder', 'junior');
  await w.hire('Rex', 'reviewer', 'senior');
  await w.hire('Tess', 'tester', 'junior');
  await w.hire('Aria', 'architect', 'senior');
});
afterAll(async () => {
  r?.close();
  await w.t.close();
  await closeAdminPool();
});

describe('Investigate & design inserted after test in a variant of code v2', () => {
  it('the roles the variant editor offers include the built-in architect, which claims the template step', async () => {
    const res = await ok<any>(w.t.req('GET', `/api/roles?projectId=${w.projectId}`, owner()));
    const arch = res.roles.find((x: any) => x.definition.key === 'architect');
    expect(arch).toBeTruthy();
    expect(arch.definition.claimableStages).toEqual([
      { workflowKey: '*', stageId: 'investigate*' },
      { workflowKey: 'code-v6', stageId: 'planning' },
    ]);
  });

  it('validates with the built-in architect, and the owner approves it', async () => {
    const v = await approveVariant(spec('code-inv', 2));
    const def = (await q('SELECT definition FROM workflow_versions WHERE id=$1', [v.id]))[0]!.definition;
    expect(def.extends).toEqual({ key: 'code', version: 2 });
    expect(def.stages.map((s: any) => s.id)).toEqual(ALL_STAGES);
    const st = def.stages.find((s: any) => s.id === INSERTED);
    expect(st).toMatchObject({ claimRole: 'architect', worktree: 'reuse' });
    expect(st.outcomes[0]).toMatchObject({
      id: 'done',
      event: 'StageCompleted',
      data: 'investigation',
      to: 'docs',
    });
    expect(def.stages.find((s: any) => s.id === 'test').outcomes.find((o: any) => o.id === 'pass').to).toBe(
      INSERTED,
    );
    await enable(['code-inv']);
  });

  it('a card with the built-in design step runs through both: the architect claims each and each report is recorded', async () => {
    const card = await w.card({
      title: 'Both investigate steps',
      workflowKey: 'code-inv',
      designNeeded: true,
    });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'investigate', status: 'queued' });
    const first = await p.run(
      'Aria',
      report({ reportPath: 'docs/investigations/TOY-9-design.md' }, 'handoff'),
    );
    expect(first.start.brief.shift.stage).toBe('investigate');
    expect(await cardRow(card.id)).toMatchObject({ stage: 'build' });
    await toInserted();
    expect(await cardRow(card.id)).toMatchObject({ stage: INSERTED, status: 'queued' });

    const second = await p.run('Aria', report());
    expect(second.start.brief.shift.stage).toBe(INSERTED);
    expect(second.start.brief.role.key).toBe('architect');
    expect(second.start.brief.investigation).toBeTruthy();
    expect(second.res).toMatchObject({ accepted: true });
    // the card proceeds to the next stage of the variant (docs are skipped for a small change)
    expect(['docs', 'finalize']).toContain((await cardRow(card.id)).stage);

    const reported = (await eventsOfType('InvestigationReported')).filter((e) => e.cardId === card.id);
    expect(reported.map((e) => e.reportPath)).toEqual(['docs/investigations/TOY-9-design.md', REPORT]);
    expect(reported[1]).toMatchObject({ location: 'repo', commit: 'def5678', investigationOnly: false });
    const completed = (
      await q(`SELECT payload FROM events WHERE type='StageCompleted' AND stream_id=$1 ORDER BY seq`, [
        `card-${card.id}`,
      ])
    ).map((e) => e.payload);
    expect(completed.find((c: any) => c.fromStage === INSERTED)).toMatchObject({ outcome: 'done' });
    // the projection holds the latest report
    expect((await cardRow(card.id)).investigation).toMatchObject({
      reportPath: REPORT,
      summary: 'Findings after test.',
    });
  });

  it('rejects an invalid report for the inserted step like the built-in one', async () => {
    await tidy();
    const card = await w.card({ title: 'Bad report', workflowKey: 'code-inv', designNeeded: false });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'build' });
    await toInserted();
    const bad = await p.run('Aria', report({ reportPath: '../escape.md' }));
    expect(bad.res).toMatchObject({ accepted: false });
    expect(await cardRow(card.id)).toMatchObject({ stage: INSERTED });
    const noData = await p.run('Aria', { kind: 'outcome', outcomeId: 'done', note: 'x', data: {} });
    expect(noData.res).toMatchObject({ accepted: false });
    expect(await cardRow(card.id)).toMatchObject({ stage: INSERTED });
    expect((await cardRow(card.id)).investigation).toBeNull();
  });

  it('designNeeded=false skips the built-in investigate stage and the inserted step still runs', async () => {
    await tidy();
    const card = await w.card({ title: 'Skip built-in', workflowKey: 'code-inv', designNeeded: false });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'build', design_needed: false });
    await toInserted();
    expect(await cardRow(card.id)).toMatchObject({ stage: INSERTED, status: 'queued' });
    const run = await p.run('Aria', report());
    expect(run.start.brief.shift.stage).toBe(INSERTED);
    expect(['docs', 'finalize']).toContain((await cardRow(card.id)).stage);
    const reported = (await eventsOfType('InvestigationReported')).filter((e) => e.cardId === card.id);
    expect(reported).toHaveLength(1);
  });
});

describe('a variant created on code v1 and rebased onto v2', () => {
  it('can be drafted on v1 (no built-in investigate stage), runs, and rebases onto v2', async () => {
    await tidy();
    const v1 = await approveVariant(spec('code-inv-v1', 1));
    const def1 = (await q('SELECT definition FROM workflow_versions WHERE id=$1', [v1.id]))[0]!.definition;
    expect(def1.stages.map((s: any) => s.id)).not.toContain('investigate');
    expect(def1.stages.map((s: any) => s.id)).toContain(INSERTED);
    await enable(['code-inv', 'code-inv-v1']);
    const card = await w.card({ title: 'On v1', workflowKey: 'code-inv-v1', designNeeded: false });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'build' });

    const rebased = await w.t.req('POST', variantUrl(`${v1.id}/rebase`), owner());
    expect(rebased.status).toBe(201);
    expect(rebased.body).toMatchObject({ key: 'code-inv-v1', version: 2, status: 'draft' });
    expect(rebased.body.issues.filter((i: any) => i.severity === 'error')).toEqual([]);
    expect(rebased.body.stages.map((s: any) => s.id)).toEqual([
      ...ALL_STAGES.slice(0, -1),
      'qa_steps',
      'manual_qa',
      'done',
    ]);
    const def2 = (await q('SELECT definition FROM workflow_versions WHERE id=$1', [rebased.body.id]))[0]!
      .definition;
    expect(def2.extends).toEqual({ key: 'code', version: 5 });
    const sub = await ok<any>(w.t.req('POST', variantUrl(`${rebased.body.id}/submit`), owner()));
    expect((await d.resolve(sub.deskItemId, 'approved')).status).toBe(200);

    // the running card keeps its version and still finishes through the architect step
    const pinned = await q(
      'SELECT v.version FROM cards c JOIN workflow_versions v ON v.id=c.workflow_version_id WHERE c.id=$1',
      [card.id],
    );
    expect(pinned[0]!.version).toBe(1);
    await toInserted();
    expect(await cardRow(card.id)).toMatchObject({ stage: INSERTED });
    await p.run('Aria', report());
    expect(['docs', 'finalize']).toContain((await cardRow(card.id)).stage);

    // a new card uses v2 and has the built-in investigate stage available
    const fresh = await w.card({ title: 'On v2', workflowKey: 'code-inv-v1', designNeeded: true });
    expect(await cardRow(fresh.id)).toMatchObject({ stage: 'investigate' });
  });
});

describe('what the architect may claim', () => {
  const insertAfterBuild = (id: string, over: Record<string, unknown> = {}) =>
    spec('code-arch-bad', 2, [
      { after: 'build', stage: { id, label: 'X', claimRole: 'architect', doneCriteria: 'x', ...over } },
    ]);
  const issueCodes = (res: { body: any }) => res.body.issues.map((i: any) => i.code);
  const draft = (body: unknown) => w.t.req('POST', variantUrl(), { cookie: w.owner.cookie, body });
  const discard = (res: { body: any }) => ok(w.t.req('DELETE', variantUrl(res.body.id), owner()));

  it('an architect step that is not an investigate step is saved with its issue and cannot be submitted', async () => {
    const res = await draft(insertAfterBuild('build_extra'));
    expect(res.status).toBe(201);
    expect(issueCodes(res)).toContain('role_cannot_claim_stage');
    expect((await w.t.req('POST', variantUrl(`${res.body.id}/submit`), owner())).status).toBe(422);
    await discard(res);
  });

  it('a step named investigate* may be claimed by the architect; investigation data needs both', async () => {
    const good = await draft(insertAfterBuild('investigate_more'));
    expect(good.status).toBe(201);
    expect(good.body.issues.filter((i: any) => i.severity === 'error')).toEqual([]);
    await discard(good);
    const notInvestigate = await draft(insertAfterBuild('build_report', { data: 'investigation' }));
    expect(issueCodes(notInvestigate)).toEqual(expect.arrayContaining(['variant_invalid_insertion']));
    await discard(notInvestigate);
    const wrongRole = await draft(
      insertAfterBuild('investigate_x', { claimRole: 'tester', data: 'investigation' }),
    );
    expect(issueCodes(wrongRole)).toContain('role_cannot_claim_stage');
    await discard(wrongRole);
  });

  it('an architect is never dispatched to a build stage', async () => {
    await tidy();
    const card = await w.card({ title: 'Build waits', workflowKey: 'code-inv', designNeeded: false });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'build', status: 'queued' });
    const before = r.of('shift.start').length;
    await p.dispatcher().run();
    await new Promise((res) => setTimeout(res, 300));
    const started = r.of('shift.start').slice(before);
    expect(started.filter((s: any) => s.agent.name === 'Aria' && s.brief.card.id === card.id)).toEqual([]);
    const run = await p.run('Bea', handoff(), DIFF_SMALL);
    expect(run.start.brief.shift.stage).toBe('build');
  });
});
