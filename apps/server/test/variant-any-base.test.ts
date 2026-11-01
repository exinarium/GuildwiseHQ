import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { designer } from './helpers/designer.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { pipeline } from './helpers/pipeline.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * Any workflow can be the base of a project variant: the six business workflows, research, feed and code-bugfix are
 * drafted, approved and stored like a variant of `code`, and a card runs through one (business quote and research here).
 */
let w: World;
let d: ReturnType<typeof designer>;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;

const owner = () => ({ cookie: w.owner.cookie });
const variantUrl = (id = '') => `/api/projects/${w.projectId}/workflow-variants${id ? `/${id}` : ''}`;
const frontDesk = (id: string, after: string) => ({
  after,
  stage: {
    id,
    label: 'Extra check',
    claimRole: 'front_desk',
    doneCriteria: 'The extra check is done.',
    maxShiftMinutes: 30,
  },
});
const BASES: Array<{ key: string; after: string; insertion: (id: string) => unknown }> = [
  ...[
    'business-enquiry',
    'business-follow-up',
    'business-document-request',
    'business-reminder',
    'business-report',
    'business-quote',
  ].map((key) => ({ key, after: 'prepare', insertion: (id: string) => frontDesk(id, 'prepare') })),
  { key: 'research', after: 'research', insertion: (id) => frontDesk(id, 'research') },
  { key: 'feed', after: 'scan', insertion: (id) => frontDesk(id, 'scan') },
  {
    key: 'code-bugfix',
    after: 'build',
    insertion: () => ({
      after: 'build',
      stage: {
        id: 'investigate_after_build',
        label: 'Investigate & design',
        claimRole: 'architect',
        seniorOnly: true,
        doneCriteria: 'The findings are in the report.',
        data: 'investigation',
        maxShiftMinutes: 90,
      },
    }),
  },
];

async function approveVariant(baseKey: string, key: string, insertion: unknown) {
  const base = (
    await q(
      `SELECT version FROM workflow_versions WHERE org_id IS NULL AND key=$1 AND status='active' ORDER BY version DESC LIMIT 1`,
      [baseKey],
    )
  )[0]!;
  const draft = await ok<any>(
    w.t.req('POST', variantUrl(), {
      cookie: w.owner.cookie,
      body: { key, name: key, base: { key: baseKey, version: base.version }, insertions: [insertion] },
    }),
    201,
  );
  expect(draft.issues.filter((i: any) => i.severity === 'error')).toEqual([]);
  const sub = await ok<any>(w.t.req('POST', variantUrl(`${draft.id}/submit`), owner()));
  expect((await d.resolve(sub.deskItemId, 'approved')).status).toBe(200);
  return { id: draft.id as string, baseVersion: base.version as number };
}
const enable = async (key: string) => {
  const current = (await q(
    `SELECT workflow_key, default_card_types FROM project_workflows WHERE project_id=$1`,
    [w.projectId],
  )) as any[];
  await ok(
    w.t.req('PUT', `/api/projects/${w.projectId}/workflows`, {
      cookie: w.owner.cookie,
      body: {
        enabled: [
          ...current.map((e) => ({
            workflowKey: e.workflow_key,
            defaultCardTypes: e.default_card_types ?? [],
          })),
          { workflowKey: key, defaultCardTypes: [] },
        ],
      },
    }),
  );
};

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  d = designer(w);
  r = await w.connectRunner();
  p = pipeline(w, r);
  await w.hire('Fran', 'front_desk', 'senior');
});
afterAll(async () => {
  r?.close();
  await w.t.close();
  await closeAdminPool();
});

describe('every built-in workflow is a variant base', () => {
  it.each(BASES.map((b) => [b.key, b] as const))(
    '%s: a variant with an inserted step is approved and stored',
    async (_k, b) => {
      const key = `${b.key}-toy`;
      const v = await approveVariant(b.key, key, b.insertion('extra_check'));
      const row = (
        await q(`SELECT status, project_id, definition FROM workflow_versions WHERE id=$1`, [v.id])
      )[0]!;
      expect(row).toMatchObject({ status: 'active', project_id: w.projectId });
      expect(row.definition.extends).toEqual({ key: b.key, version: v.baseVersion });
      expect(row.definition.builtIn).toBe(false);
      const stage = b.key === 'code-bugfix' ? 'investigate_after_build' : 'extra_check';
      expect(row.definition.stages.map((s: any) => s.id)).toContain(stage);
    },
  );

  it('a variant of a variant is refused', async () => {
    const res = await w.t.req('POST', variantUrl(), {
      cookie: w.owner.cookie,
      body: {
        key: 'quote-again',
        name: 'again',
        base: { key: 'business-quote-toy', version: 1 },
        insertions: [frontDesk('more', 'prepare')],
      },
    });
    // a variant is not a base the catalogue offers: refused before any draft exists
    expect(res.status).toBe(400);
  });
});

describe('a card runs through a variant of a business workflow', () => {
  it('quote: prepare, the inserted step, approval, done', async () => {
    await enable('business-quote-toy');
    const res = await ok<any>(
      w.t.req('POST', '/api/cards', {
        cookie: w.owner.cookie,
        body: {
          projectId: w.projectId,
          title: 'Quote with an extra check',
          cardType: 'quote',
          workflowKey: 'business-quote-toy',
          fields: { customer: 'Acme', scope: '10 chairs', amount: '1200' },
          specify: true,
        },
      }),
      201,
    );
    const id = res.card.id as string;
    const row = async () =>
      (await q('SELECT stage, status, workflow_version_id FROM cards WHERE id=$1', [id]))[0] as any;
    expect(await row()).toMatchObject({ stage: 'prepare' });
    const step = (note: string) => p.run('Fran', { kind: 'outcome', outcomeId: 'done', note, data: {} });
    await step('Draft quote');
    await w.t.app.ctx.services.scheduler.run();
    expect(await row()).toMatchObject({ stage: 'extra_check', status: 'queued' });
    await step('Checked');
    await w.t.app.ctx.services.scheduler.run();
    expect(await row()).toMatchObject({ stage: 'approve', status: 'waiting' });
    await ok(w.t.req('POST', `/api/cards/${id}/approval/approve`, { cookie: w.owner.cookie, body: {} }));
    expect(await row()).toMatchObject({ stage: 'done', status: 'done' });
    const pinned = (
      await q('SELECT key, project_id FROM workflow_versions WHERE id=$1', [
        (await row()).workflow_version_id,
      ])
    )[0] as any;
    expect(pinned).toMatchObject({ key: 'business-quote-toy', project_id: w.projectId });
  });
});

describe('a card runs through a variant of research (special publish event kept)', () => {
  it('research: question, research, the inserted step, fact-check publishes the note', async () => {
    await w.hire('Rhea', 'researcher', 'junior');
    await w.hire('Chuck', 'checker', 'junior');
    await enable('research-toy');
    const res = await ok<any>(
      w.t.req('POST', '/api/cards', {
        cookie: w.owner.cookie,
        body: {
          projectId: w.projectId,
          title: 'Is it so?',
          cardType: 'research',
          workflowKey: 'research-toy',
          fields: { question: 'Is it so at 300 yards?', scope: 'Factory loads', depth: 'standard' },
          specify: true,
        },
      }),
      201,
    );
    const id = res.card.id as string;
    const row = async () => (await q('SELECT stage, status FROM cards WHERE id=$1', [id]))[0] as any;
    expect(await row()).toMatchObject({ stage: 'research', status: 'queued' });
    await p.run('Rhea', { kind: 'outcome', outcomeId: 'handoff', note: 'draft [1]', data: {} });
    expect(await row()).toMatchObject({ stage: 'extra_check', status: 'queued' });
    await p.run('Fran', { kind: 'outcome', outcomeId: 'done', note: 'checked', data: {} });
    expect(await row()).toMatchObject({ stage: 'factcheck', status: 'queued' });
    const cite = {
      url: 'https://source.example.test/1',
      title: 'Source 1',
      accessedAt: '2026-10-03T08:00:00.000Z',
    };
    const pub = await p.run('Chuck', {
      kind: 'outcome',
      outcomeId: 'published',
      note: 'verified',
      data: { vaultPath: 'projects/toy/so.md', title: 'Is it so?', citations: [cite], excerpt: 'Yes.' },
    });
    expect(pub.res).toMatchObject({ accepted: true });
    await until(async () => ((await row()).status === 'done' ? true : undefined), 3000, 'card done');
    expect(await row()).toMatchObject({ stage: 'done', status: 'done' });
    expect(
      await q(`SELECT 1 FROM events WHERE payload->>'cardId'=$1 AND type='ResearchPublished'`, [id]),
    ).toHaveLength(1);
  }, 120_000);
});
