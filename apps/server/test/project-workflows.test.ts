import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { designer, responderRole, roleInput, triagerRole, workflowInput } from './helpers/designer.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, type Member } from './helpers/members.ts';
import { approve, cardRow, DIFF_SMALL, handoff, pipeline, testPass } from './helpers/pipeline.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

// More than one workflow per project (#10): the enabled set and defaults by card type, card workflow resolution, and
// project variants (stages inserted into a base workflow, owner approval, version pinning, rebase).
let w: World;
let d: ReturnType<typeof designer>;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
let member: Member;

const wfUrl = (projectId = w.projectId) => `/api/projects/${projectId}/workflows`;
const variantUrl = (id = '') => `/api/projects/${w.projectId}/workflow-variants${id ? `/${id}` : ''}`;
const owner = () => ({ cookie: w.owner.cookie });
const getView = () => ok<any>(w.t.req('GET', wfUrl(), owner()));
const put = (enabled: unknown[], cookie = w.owner.cookie) =>
  w.t.req('PUT', wfUrl(), { cookie, body: { enabled } });
const cardWorkflowKey = async (cardId: string) =>
  (
    await q(
      'SELECT v.key, v.version FROM cards c JOIN workflow_versions v ON v.id = c.workflow_version_id WHERE c.id=$1',
      [cardId],
    )
  )[0]!;
const supportCard = async (title: string, over: Record<string, unknown> = {}) => {
  const res = await w.t.req('POST', '/api/cards', {
    cookie: w.owner.cookie,
    body: {
      projectId: w.projectId,
      title,
      cardType: 'support',
      fields: { customer: 'Acme' },
      specify: false,
      ...over,
    },
  });
  return res;
};
const codes = (res: { body: any }) =>
  (res.body.error?.details?.issues ?? res.body.issues ?? []).map((i: any) => i.code);

const variantSpec = (over: Record<string, unknown> = {}): any => ({
  key: 'code-toy',
  name: 'Code (Toy)',
  base: { key: 'code', version: 1 },
  insertions: [
    {
      after: 'build',
      stage: {
        id: 'security_check',
        label: 'Security check',
        claimRole: 'securer',
        doneCriteria: 'The change was checked for security problems.',
      },
    },
  ],
  ...over,
});

beforeAll(async () => {
  w = await createWorld();
  d = designer(w);
  await ok(w.t.req('POST', '/api/departments', { cookie: w.owner.cookie, body: { name: 'support' } }), 201);
  await d.publish('roles', triagerRole());
  await d.publish('roles', responderRole());
  await d.publish('roles', roleInput('securer', [['code-toy', '*']]));
  await d.publish('workflows', workflowInput('support'));
  member = await addMember(w, 'wf-member');
  r = await w.connectRunner();
  p = pipeline(w, r);
  await w.hire('Bea', 'builder', 'junior');
  await w.hire('Sam', 'securer', 'junior');
  await w.hire('Rex', 'reviewer', 'senior');
});
afterAll(async () => {
  r?.close();
  await w.t.close();
  await closeAdminPool();
});

describe('migration and projection', () => {
  it('every project has exactly one primary row, equal to its workflow key', async () => {
    const bad = await q(
      `SELECT p.id FROM projects p
        WHERE (SELECT count(*) FROM project_workflows pw WHERE pw.project_id = p.id AND pw.is_primary) <> 1
           OR NOT EXISTS (SELECT 1 FROM project_workflows pw WHERE pw.project_id = p.id AND pw.is_primary
                            AND pw.workflow_key = p.workflow_key)`,
    );
    expect(bad).toEqual([]);
    expect(
      await q('SELECT workflow_key, is_primary FROM project_workflows WHERE project_id=$1', [w.projectId]),
    ).toEqual([{ workflow_key: 'code', is_primary: true }]);
  });
});

describe('enabling workflows', () => {
  it('lists the primary as enabled and the approved workflows as available (not the internal ones)', async () => {
    const v = await getView();
    expect(v.canEdit).toBe(true);
    expect(v.enabled.map((x: any) => [x.workflowKey, x.isPrimary])).toEqual([['code', true]]);
    const keys = v.available.map((x: any) => x.workflowKey);
    expect(keys).toContain('support');
    for (const hidden of ['code-bugfix', 'feed', 'research']) expect(keys).not.toContain(hidden);
    expect(v.enabled[0].stages.map((s: any) => s.id)).toContain('build');
  });

  it('only Owners and Admins change the set; members read it', async () => {
    const read = await ok<any>(w.t.req('GET', wfUrl(), { cookie: member.cookie }));
    expect(read.canEdit).toBe(false);
    const res = await put([{ workflowKey: 'support', defaultCardTypes: [] }], member.cookie);
    expect(res.status).toBe(403);
    const draft = await w.t.req('POST', variantUrl(), { cookie: member.cookie, body: variantSpec() });
    expect(draft.status).toBe(403);
    expect((await getView()).enabled.map((x: any) => x.workflowKey)).toEqual(['code']);
  });

  it('a card type that the primary runs resolves to it until another workflow is made the default', async () => {
    const res = await supportCard('Before enabling');
    expect(res.status).toBe(201);
    expect((await cardWorkflowKey(res.body.card.id)).key).toBe('code');
  });

  it('refuses unknown workflows, unknown default types and two defaults for one type', async () => {
    expect((await put([{ workflowKey: 'nope', defaultCardTypes: [] }])).body.error.code).toBe(
      'unknown_workflow',
    );
    expect((await put([{ workflowKey: 'research', defaultCardTypes: [] }])).body.error.code).toBe(
      'workflow_not_available',
    );
    expect((await put([{ workflowKey: 'support', defaultCardTypes: ['feature'] }])).body.error.code).toBe(
      'invalid_default_card_type',
    );
    const dup = await put([
      { workflowKey: 'code', defaultCardTypes: ['support'] },
      { workflowKey: 'support', defaultCardTypes: ['support'] },
    ]);
    expect(dup.status).toBe(400);
    expect(dup.body.error.code).toBe('duplicate_default');
    expect((await getView()).enabled.map((x: any) => x.workflowKey)).toEqual(['code']);
  });

  it('enabling support as the default for support cards routes them there; others stay on code', async () => {
    const res = await put([{ workflowKey: 'support', defaultCardTypes: ['support'] }]);
    expect(res.status).toBe(200);
    expect(res.body.enabled.map((x: any) => [x.workflowKey, x.isPrimary, x.defaultCardTypes])).toEqual([
      ['code', true, []],
      ['support', false, ['support']],
    ]);
    expect(
      await q(
        'SELECT workflow_key, is_primary FROM project_workflows WHERE project_id=$1 ORDER BY is_primary DESC',
        [w.projectId],
      ),
    ).toEqual([
      { workflow_key: 'code', is_primary: true },
      { workflow_key: 'support', is_primary: false },
    ]);
    const sup = await supportCard('Default routing', { specify: true });
    expect(sup.status).toBe(201);
    expect(await cardWorkflowKey(sup.body.card.id)).toMatchObject({ key: 'support' });
    expect(sup.body.card.stage).toBe('triage');
    const feat = await w.card({ title: 'Plain feature' });
    expect((await cardWorkflowKey(feat.id)).key).toBe('code');
  });

  it('an explicit workflow wins; it must be enabled and run the card type', async () => {
    const onCode = await supportCard('Explicit code', { workflowKey: 'code' });
    expect(onCode.status).toBe(201);
    expect((await cardWorkflowKey(onCode.body.card.id)).key).toBe('code');
    const wrongType = await w.t.req('POST', '/api/cards', {
      cookie: w.owner.cookie,
      body: { projectId: w.projectId, title: 'x', cardType: 'feature', workflowKey: 'support', fields: {} },
    });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error.code).toBe('invalid_card_type');
    const notEnabled = await w.t.req('POST', '/api/cards', {
      cookie: w.owner.cookie,
      body: { projectId: w.projectId, title: 'x', cardType: 'feature', workflowKey: 'research', fields: {} },
    });
    expect(notEnabled.status).toBe(400);
    expect(notEnabled.body.error.code).toBe('workflow_not_enabled');
  });

  it('the board shows the columns of enabled workflows before any card uses them', async () => {
    const board = await ok<any>(w.t.req('GET', `/api/board?projectId=${w.projectId}`, owner()));
    const names = board.columns.map((c: any) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Triage', 'Resolve']));
    expect(names[names.length - 1]).toBe('Done');
  });

  it('the primary cannot be removed; disabling a workflow leaves its open cards on their version', async () => {
    const open = (
      await q(
        `SELECT c.id FROM cards c JOIN workflow_versions v ON v.id=c.workflow_version_id WHERE v.key='support' AND c.project_id=$1`,
        [w.projectId],
      )
    )[0]!;
    const res = await put([]);
    expect(res.status).toBe(200);
    expect(res.body.enabled.map((x: any) => x.workflowKey)).toEqual(['code']);
    expect((await cardWorkflowKey(open.id)).key).toBe('support');
    const after = await supportCard('After disabling');
    expect((await cardWorkflowKey(after.body.card.id)).key).toBe('code');
    expect(
      (
        await w.t.req('POST', '/api/cards', {
          cookie: w.owner.cookie,
          body: {
            projectId: w.projectId,
            title: 'x',
            cardType: 'support',
            workflowKey: 'support',
            fields: {},
          },
        })
      ).body.error.code,
    ).toBe('workflow_not_enabled');
  });
});

describe('project variants', () => {
  let v1: string;
  let v1Card: string;

  beforeAll(async () => {
    // Earlier tests left cards in build: the builder would pick them first.
    for (const c of await q(`SELECT id FROM cards WHERE project_id=$1 AND status IN ('queued','draft')`, [
      w.projectId,
    ]))
      await ok(
        w.t.req('POST', `/api/cards/${c.id}/cancel`, { cookie: w.owner.cookie, body: { reason: 'tidy' } }),
      );
  });

  it('drafts a variant: the inserted step comes after build and base steps are untouched', async () => {
    const res = await w.t.req('POST', variantUrl(), { cookie: w.owner.cookie, body: variantSpec() });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ key: 'code-toy', version: 1, status: 'draft', issues: [] });
    expect(res.body.stages.map((s: any) => [s.id, s.inherited])).toEqual([
      ['spec', true],
      ['build', true],
      ['security_check', false],
      ['review', true],
      ['test', true],
      ['docs', true],
      ['finalize', true],
      ['done', true],
    ]);
    v1 = res.body.id;
    const row = (await q('SELECT * FROM workflow_versions WHERE id=$1', [v1]))[0]!;
    expect(row).toMatchObject({
      project_id: w.projectId,
      base_key: 'code',
      base_version: 1,
      status: 'draft',
    });
    expect(row.definition.extends).toEqual({ key: 'code', version: 1 });
    expect(row.definition.stages.find((s: any) => s.id === 'build').outcomes[0].to).toBe('security_check');
    expect((await q('SELECT stage_id FROM workflow_stages WHERE workflow_version_id=$1', [v1])).length).toBe(
      8,
    );
  });

  it('is invisible to the organization designer and to the generic workflow routes', async () => {
    const cat = await ok<any>(w.t.req('GET', '/api/org/catalogue', owner()));
    expect(cat.workflows.map((x: any) => x.key)).not.toContain('code-toy');
    const list = await ok<any>(w.t.req('GET', '/api/workflows', owner()));
    expect(list.workflows.map((x: any) => x.definition.key)).not.toContain('code-toy');
    const generic = await d.req('PUT', `/api/workflows/${v1}`, workflowInput('code-toy'));
    expect(generic.status).toBe(409);
    expect((await d.req('POST', '/api/workflows', workflowInput('code-toy'))).status).toBe(409);
  });

  it('refuses insertions that cannot be placed and keys that are taken', async () => {
    const bad = await w.t.req('POST', `/api/projects/${w.projectId}/workflow-variants`, {
      cookie: w.owner.cookie,
      body: variantSpec({
        key: 'code-other',
        insertions: [{ ...variantSpec().insertions[0], after: 'ghost' }],
      }),
    });
    expect(bad.status).toBe(422);
    expect(codes(bad)).toContain('variant_invalid_insertion');
    const builtin = await w.t.req('POST', variantUrl(), {
      cookie: w.owner.cookie,
      body: variantSpec({ key: 'code' }),
    });
    expect(builtin.status).toBe(409);
    const taken = await w.t.req('POST', variantUrl(), {
      cookie: w.owner.cookie,
      body: variantSpec({ key: 'support' }),
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('key_taken');
    const dup = await w.t.req('POST', variantUrl(), { cookie: w.owner.cookie, body: variantSpec() });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('draft_exists');
  });

  it('a step with a role that cannot claim it is saved with its issue and cannot be submitted', async () => {
    const draft = await w.t.req('PUT', variantUrl(v1), {
      cookie: w.owner.cookie,
      body: variantSpec({
        insertions: [
          {
            ...variantSpec().insertions[0],
            stage: { ...variantSpec().insertions[0].stage, claimRole: 'writer' },
          },
        ],
      }),
    });
    expect(draft.status).toBe(200);
    expect(draft.body.issues.map((i: any) => i.code)).toContain('role_cannot_claim_stage');
    const sub = await w.t.req('POST', variantUrl(`${v1}/submit`), owner());
    expect(sub.status).toBe(422);
    // Back to a valid draft.
    expect(
      (await w.t.req('PUT', variantUrl(v1), { cookie: w.owner.cookie, body: variantSpec() })).body.issues,
    ).toEqual([]);
  });

  it('cannot be enabled before the owner approves it on the desk', async () => {
    const sub = await ok<any>(w.t.req('POST', variantUrl(`${v1}/submit`), owner()));
    expect(sub.status).toBe('pending_approval');
    const view = await getView();
    const listed = view.available.find((x: any) => x.workflowKey === 'code-toy');
    expect(listed).toMatchObject({
      variantOf: { key: 'code', version: 1 },
      pendingVersion: { id: v1, status: 'pending_approval' },
    });
    expect((await put([{ workflowKey: 'code-toy', defaultCardTypes: [] }])).body.error.code).toBe(
      'unknown_workflow',
    );
    const desk = await ok<any>(w.t.req('GET', '/api/desk', owner()));
    expect(desk.items.find((i: any) => i.id === sub.deskItemId)).toMatchObject({
      subkind: 'definition',
      status: 'open',
    });
    expect((await d.resolve(sub.deskItemId, 'approved')).status).toBe(200);
    expect((await q('SELECT status FROM workflow_versions WHERE id=$1', [v1]))[0]!.status).toBe('active');
  });

  it('once approved it is enabled, becomes the default for feature cards and runs its inserted step', async () => {
    const res = await put([{ workflowKey: 'code-toy', defaultCardTypes: ['feature'] }]);
    expect(res.status).toBe(200);
    const enabled = res.body.enabled.find((x: any) => x.workflowKey === 'code-toy');
    expect(enabled).toMatchObject({
      enabled: true,
      defaultCardTypes: ['feature'],
      variantOf: { key: 'code', version: 1 },
    });
    const card = await w.card({ title: 'Through the variant' });
    v1Card = card.id;
    expect(await cardWorkflowKey(card.id)).toMatchObject({ key: 'code-toy', version: 1 });
    // Base stages keep their base roles: the builder builds, then the inserted step goes to the securer.
    await p.run('Bea', handoff(), DIFF_SMALL);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'security_check', status: 'queued' });
    const { start } = await p.run('Sam', { kind: 'outcome', outcomeId: 'done', note: 'checked', data: {} });
    expect(start.brief.shift.stage).toBe('security_check');
    expect(start.brief.role.key).toBe('securer');
    expect(await cardRow(card.id)).toMatchObject({ stage: 'review', status: 'queued' });
    const second = await p.run('Rex', approve());
    expect(second.start.brief.shift.stage).toBe('review');
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test' });
  });

  it('the board shows the inserted step as a column in its place', async () => {
    const board = await ok<any>(w.t.req('GET', `/api/board?projectId=${w.projectId}`, owner()));
    const names = board.columns.map((c: any) => c.name);
    expect(names).toContain('Security check');
    expect(names.indexOf('Security check')).toBeGreaterThan(names.indexOf('In progress'));
    expect(names.indexOf('Security check')).toBeLessThan(names.indexOf('Review'));
  });

  it('a new version affects new cards only; running cards finish on the version they started with', async () => {
    const running = await w.card({ title: 'Started on v1' });
    expect((await cardWorkflowKey(running.id)).version).toBe(1);
    const v2spec = variantSpec({
      insertions: [
        variantSpec().insertions[0],
        {
          after: 'review',
          stage: { id: 'compliance', label: 'Compliance', claimRole: 'securer', doneCriteria: 'Compliant.' },
        },
      ],
    });
    const d2 = await w.t.req('POST', variantUrl(), { cookie: w.owner.cookie, body: v2spec });
    expect(d2.status).toBe(201);
    expect(d2.body.version).toBe(2);
    const sub = await ok<any>(w.t.req('POST', variantUrl(`${d2.body.id}/submit`), owner()));
    // Until approved, new cards still start on v1.
    expect((await cardWorkflowKey((await w.card({ title: 'Between' })).id)).version).toBe(1);
    expect((await d.resolve(sub.deskItemId, 'approved')).status).toBe(200);
    expect(
      await q(`SELECT version, status FROM workflow_versions WHERE key='code-toy' ORDER BY version`),
    ).toEqual([
      { version: 1, status: 'superseded' },
      { version: 2, status: 'active' },
    ]);
    const fresh = await w.card({ title: 'Starts on v2' });
    expect(await cardWorkflowKey(fresh.id)).toMatchObject({ key: 'code-toy', version: 2 });
    expect((await cardWorkflowKey(running.id)).version).toBe(1);
    expect((await cardWorkflowKey(v1Card)).version).toBe(1);
    const defV2 = (await q('SELECT definition FROM workflow_versions WHERE id=$1', [d2.body.id]))[0]!
      .definition;
    expect(defV2.stages.map((s: any) => s.id)).toContain('compliance');
    // The v1 card still moves through its own definition.
    await p.run('Bea', handoff(), DIFF_SMALL);
    const rows = await q(`SELECT id, stage FROM cards WHERE id = ANY($1::uuid[])`, [[running.id, fresh.id]]);
    expect(rows.find((x) => x.id === running.id)!.stage).toBe('security_check');
  });

  it('survives a projection rebuild', async () => {
    const snap = async () => {
      const out: Record<string, string[]> = {};
      for (const t of ['project_workflows', 'workflow_versions', 'workflow_stages']) {
        out[t] = (await q(`SELECT to_jsonb(t)::text AS j FROM "${t}" t`)).map((x) => x.j as string).sort();
      }
      return out;
    };
    expect(PROJECTION_TABLES).toContain('project_workflows');
    const before = await snap();
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snap()).toEqual(before);
  });
});

describe('rebasing a variant on a newer base', () => {
  let variantV1: string;
  const supportVariant = (over: Record<string, unknown> = {}) => ({
    key: 'support-toy',
    name: 'Support (Toy)',
    base: { key: 'support', version: 1 },
    insertions: [
      {
        after: 'triage',
        stage: { id: 'vet', label: 'Vet', claimRole: 'securer2', doneCriteria: 'The ticket was vetted.' },
      },
    ],
    ...over,
  });

  beforeAll(async () => {
    await d.publish('roles', roleInput('securer2', [['support-toy', 'vet']]));
    const draft = await ok<any>(
      w.t.req('POST', variantUrl(), { cookie: w.owner.cookie, body: supportVariant() }),
      201,
    );
    const sub = await ok<any>(w.t.req('POST', variantUrl(`${draft.id}/submit`), owner()));
    await d.resolve(sub.deskItemId, 'approved');
    variantV1 = draft.id;
  });

  it('shows that a newer base exists and re-materialises the insertions as a new draft', async () => {
    expect(
      (await getView()).available.find((x: any) => x.workflowKey === 'support-toy').baseUpdate,
    ).toBeNull();
    // Base v2: the same workflow, one more word.
    await d.publish('workflows', workflowInput('support', { name: 'Support triage v2' }));
    const view = await getView();
    expect(view.available.find((x: any) => x.workflowKey === 'support-toy')).toMatchObject({
      variantOf: { key: 'support', version: 1 },
      baseUpdate: { version: 2 },
    });
    const rebased = await w.t.req('POST', variantUrl(`${variantV1}/rebase`), owner());
    expect(rebased.status).toBe(201);
    expect(rebased.body).toMatchObject({ key: 'support-toy', version: 2, status: 'draft' });
    expect(rebased.body.issues.filter((i: any) => i.severity === 'error')).toEqual([]);
    const def = (await q('SELECT definition FROM workflow_versions WHERE id=$1', [rebased.body.id]))[0]!
      .definition;
    expect(def.extends).toEqual({ key: 'support', version: 2 });
    expect(def.name).toBe('Support (Toy)');
    expect(def.stages.map((s: any) => s.id)).toContain('vet');
    // v1 is untouched and stays the active version until v2 is approved.
    expect((await q('SELECT status FROM workflow_versions WHERE id=$1', [variantV1]))[0]!.status).toBe(
      'active',
    );
    // An open draft blocks a second rebase.
    expect((await w.t.req('POST', variantUrl(`${variantV1}/rebase`), owner())).body.error.code).toBe(
      'draft_exists',
    );
    await ok(w.t.req('DELETE', variantUrl(rebased.body.id), owner()));
  });

  it('reports insertions whose stage no longer exists as validation errors', async () => {
    const noTriage = workflowInput('support') as any;
    noTriage.stages = noTriage.stages.filter((s: any) => s.id !== 'triage');
    noTriage.stages[0].outcomes[0].to = 'resolve';
    noTriage.stages[1].outcomes[1].to = 'resolve';
    await d.publish('workflows', noTriage);
    const res = await w.t.req('POST', variantUrl(`${variantV1}/rebase`), owner());
    expect(res.status).toBe(422);
    expect(codes(res)).toContain('variant_invalid_insertion');
    expect((await q(`SELECT count(*)::int AS n FROM workflow_versions WHERE key='support-toy'`))[0]!.n).toBe(
      1,
    );
  });
});

describe('steps inserted after review and after test', () => {
  const done = { kind: 'outcome', outcomeId: 'done', note: 'ok', data: {} };

  it('the card passes through both; the base events keep their meaning', async () => {
    for (const c of await q(
      `SELECT id FROM cards WHERE project_id=$1 AND status NOT IN ('done','cancelled')`,
      [w.projectId],
    ))
      await ok(
        w.t.req('POST', `/api/cards/${c.id}/cancel`, { cookie: w.owner.cookie, body: { reason: 'tidy' } }),
      );
    await d.publish('roles', roleInput('securer3', [['code-toy2', '*']]));
    await w.hire('Sue', 'securer3', 'junior');
    await w.hire('Tess', 'tester', 'junior');
    const draft = await ok<any>(
      w.t.req('POST', variantUrl(), {
        cookie: w.owner.cookie,
        body: variantSpec({
          key: 'code-toy2',
          name: 'Code (Toy 2)',
          insertions: [
            {
              after: 'review',
              stage: { id: 'after_review', label: 'After review', claimRole: 'securer3', doneCriteria: 'x' },
            },
            {
              after: 'test',
              stage: { id: 'after_test', label: 'After test', claimRole: 'securer3', doneCriteria: 'x' },
            },
          ],
        }),
      }),
      201,
    );
    expect(draft.issues.filter((i: any) => i.severity === 'error')).toEqual([]);
    const sub = await ok<any>(w.t.req('POST', variantUrl(`${draft.id}/submit`), owner()));
    await d.resolve(sub.deskItemId, 'approved');
    await ok(put([{ workflowKey: 'code-toy2', defaultCardTypes: [] }]));
    const card = await w.card({ title: 'Two inserted steps', workflowKey: 'code-toy2' });
    expect((await cardWorkflowKey(card.id)).key).toBe('code-toy2');
    await p.run('Bea', handoff(), DIFF_SMALL);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'review' });
    await p.run('Rex', approve());
    expect(await cardRow(card.id)).toMatchObject({ stage: 'after_review', status: 'queued' });
    await p.run('Sue', done);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', status: 'queued' });
    await p.run('Tess', testPass());
    expect(await cardRow(card.id)).toMatchObject({ stage: 'after_test', status: 'queued' });
    await p.run('Sue', done);
    // docs are not needed: the card goes on to finalize.
    expect(await cardRow(card.id)).toMatchObject({ stage: 'finalize' });
    const events = await q(`SELECT type FROM events WHERE stream_id=$1 ORDER BY seq`, [`card-${card.id}`]);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['ReviewApproved', 'TestPassed', 'StageCompleted']),
    );
  });
});
