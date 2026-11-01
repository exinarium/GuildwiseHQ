import { randomUUID } from 'node:crypto';
import { BUSINESS_WORKFLOW_KEY, BUSINESS_WORKFLOWS, streamId, type WorkflowDefinition } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureBusinessWorkflowsAtBoot } from '../src/catalogue/business-workflows.ts';
import { loadWorkflowById, resolveWorkflow } from '../src/catalogue/loader.ts';
import { BUSINESS_BUILTIN_MIGRATION, migrateBusinessBuiltin } from '../src/data-migrations/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * Release 1.4.0 installed the six business workflows as per-organization custom workflows; they are built-ins now.
 * `business-builtin-2026-11` retires the unedited copies (the built-in takes over, cards in flight keep their version)
 * and keeps an edited copy as a normal custom workflow under a free `<key>-custom` key.
 */
let w: World;
const orgId = () => w.owner.id;
const sys = { kind: 'system', id: null } as const;
const scope = () => ({ orgId: orgId(), projectId: null, audience: 'org' }) as never;
const shipped = (key: string) => BUSINESS_WORKFLOWS.find((d) => d.key === key) as WorkflowDefinition;

/** A 1.4.0 organization copy: the shipped definition, not built in. */
async function register(
  def: WorkflowDefinition,
  status: 'active' | 'superseded' = 'active',
  over: Partial<WorkflowDefinition> = {},
) {
  const definition = { ...def, builtIn: false, ...over } as WorkflowDefinition;
  const id = randomUUID();
  await w.t.app.ctx.store.append([
    {
      streamId: streamId.workflow(orgId(), definition.key),
      event: {
        type: 'WorkflowVersionRegistered',
        payload: {
          workflowVersionId: id,
          orgId: orgId(),
          key: definition.key,
          version: definition.version,
          name: definition.name,
          definition,
          status,
        },
      },
      actor: sys,
      scope: scope(),
    },
  ]);
  return id;
}
const orgRows = (key: string) =>
  q(
    `SELECT id, key, version, status, name, definition FROM workflow_versions WHERE org_id=$1 AND key=$2 ORDER BY version`,
    [orgId(), key],
  );
const wfKeys = async (projectId: string) =>
  (await q(
    `SELECT workflow_key, is_primary, default_card_types FROM project_workflows WHERE project_id=$1 ORDER BY workflow_key`,
    [projectId],
  )) as any[];
const migrate = () =>
  migrateBusinessBuiltin({
    pool: w.t.app.ctx.pool,
    store: w.t.app.ctx.store,
    clock: w.t.app.ctx.clock,
    log: () => {},
  } as never);

const ENQUIRY = BUSINESS_WORKFLOW_KEY.enquiry;
const QUOTE = BUSINESS_WORKFLOW_KEY.quote;
const REPORT = BUSINESS_WORKFLOW_KEY.report;
let enquiryCopy: string;
let enquiryCardId: string;
let quoteProject: string;
let snapshot: unknown;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });

  // unedited: the shipped enquiry, an org copy; a card in flight pins it
  enquiryCopy = await register(shipped(ENQUIRY));
  const card = await ok<any>(
    w.t.req('POST', '/api/cards', {
      cookie: w.owner.cookie,
      body: {
        projectId: w.projectId,
        title: 'In flight',
        cardType: 'enquiry',
        fields: { whoAsked: 'Mia', question: 'Open on Sundays?' },
        specify: true,
      },
    }),
    201,
  );
  enquiryCardId = card.card.id;
  expect(
    (await q('SELECT workflow_version_id FROM cards WHERE id=$1', [enquiryCardId]))[0]!.workflow_version_id,
  ).toBe(enquiryCopy);

  // edited: quote v1 (shipped, superseded) and v2 (the owner changed a step), a project whose primary it is
  const q1 = shipped(QUOTE);
  await register(q1, 'superseded');
  const edited = structuredClone(q1);
  edited.stages[1]!.doneCriteria =
    'The quote is written in our house style; the full text is in the handoff note.';
  await register(edited, 'active', { version: 2 });
  const proj = await ok<any>(
    w.t.req('POST', '/api/projects', {
      cookie: w.owner.cookie,
      body: { key: 'QUOT', name: 'Quotes', workflowKey: QUOTE },
    }),
    201,
  );
  quoteProject = proj.project.id;

  // collision: an edited report copy while the organization already made a workflow called business-report-custom
  await register({
    ...shipped(REPORT),
    key: 'business-report-custom',
    name: 'My own report',
  } as WorkflowDefinition);
  await register(shipped(REPORT), 'active', { name: 'Report for the board' });
  await q('DELETE FROM data_migrations WHERE name=$1', [BUSINESS_BUILTIN_MIGRATION]);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('business-builtin-2026-11', () => {
  it('retires an unedited copy, keeps an edited one under a free key, and records itself once', async () => {
    const report = await migrate();
    expect(report?.retired).toEqual([{ orgId: orgId(), key: ENQUIRY }]);
    expect(report?.converted.map((c) => [c.key, c.to]).sort()).toEqual([
      [QUOTE, `${QUOTE}-custom`],
      [REPORT, `${REPORT}-custom-2`],
    ]);
    expect(await migrate()).toBeNull(); // recorded in data_migrations
  });

  it('unedited: key lookups fall through to the built-in, the card in flight keeps its version', async () => {
    expect((await orgRows(ENQUIRY)).map((r: any) => r.status)).toEqual(['superseded']);
    const wf = await resolveWorkflow(w.t.app.ctx.pool, orgId(), ENQUIRY, w.projectId);
    expect(wf?.orgId).toBeNull();
    expect(wf?.definition.builtIn).toBe(true);
    // the retired version still loads, and the card still points at it
    expect((await loadWorkflowById(w.t.app.ctx.pool, enquiryCopy))?.key).toBe(ENQUIRY);
    expect(
      (await q('SELECT workflow_version_id FROM cards WHERE id=$1', [enquiryCardId]))[0]!.workflow_version_id,
    ).toBe(enquiryCopy);
    const detail = await ok<any>(w.t.req('GET', `/api/cards/${enquiryCardId}`, { cookie: w.owner.cookie }));
    expect(detail.card ?? detail).toBeTruthy();
    // a new card takes the built-in
    const fresh = await ok<any>(
      w.t.req('POST', '/api/cards', {
        cookie: w.owner.cookie,
        body: {
          projectId: w.projectId,
          title: 'After',
          cardType: 'enquiry',
          fields: { whoAsked: 'Sam', question: 'Parking?' },
          specify: true,
        },
      }),
      201,
    );
    const pinned = (
      await q(
        'SELECT w.org_id FROM cards c JOIN workflow_versions w ON w.id=c.workflow_version_id WHERE c.id=$1',
        [fresh.card.id],
      )
    )[0] as any;
    expect(pinned.org_id).toBeNull();
    // the retired copy is not listed next to the built-in in the designer catalogue
    const cat = await ok<any>(w.t.req('GET', '/api/org/catalogue', { cookie: w.owner.cookie }));
    expect(cat.workflows.filter((x: any) => x.key === ENQUIRY).map((x: any) => x.builtIn)).toEqual([true]);
  });

  it('edited: both versions stay, renamed, and the projects that used it follow', async () => {
    expect(await orgRows(QUOTE)).toEqual([]);
    const kept = await orgRows(`${QUOTE}-custom`);
    expect(kept.map((r: any) => [r.version, r.status])).toEqual([
      [1, 'superseded'],
      [2, 'active'],
    ]);
    expect(
      kept.every((r: any) => r.name === 'Quote (edited)' && r.definition.name === 'Quote (edited)'),
    ).toBe(true);
    expect(
      kept.every((r: any) => r.definition.key === `${QUOTE}-custom` && r.definition.builtIn === false),
    ).toBe(true);
    expect(kept[1]!.definition.stages[1].doneCriteria).toContain('house style');
    // the project that had it as its primary
    expect((await q('SELECT workflow_key FROM projects WHERE id=$1', [quoteProject]))[0]!.workflow_key).toBe(
      `${QUOTE}-custom`,
    );
    const mine = await wfKeys(quoteProject);
    expect(mine.find((e) => e.is_primary)?.workflow_key).toBe(`${QUOTE}-custom`);
    expect(mine.some((e) => e.workflow_key === QUOTE)).toBe(false);
    // the first project had it enabled for quote cards: still the owner's edited version
    const first = await wfKeys(w.projectId);
    expect(first.find((e) => e.workflow_key === `${QUOTE}-custom`)?.default_card_types).toEqual(['quote']);
    // a NON-primary entry was repointed: the project's primary is still code, the built-in quote is not re-enabled
    expect(first.find((e) => e.is_primary)?.workflow_key).toBe('code');
    expect(first.find((e) => e.workflow_key === `${QUOTE}-custom`)?.is_primary).toBe(false);
    expect(first.some((e) => e.workflow_key === QUOTE)).toBe(false);
    await ensureBusinessWorkflowsAtBoot(w.t.app.ctx);
    expect((await wfKeys(w.projectId)).some((e) => e.workflow_key === QUOTE)).toBe(false);
    expect((await wfKeys(quoteProject)).some((e) => e.workflow_key === QUOTE)).toBe(false);
    const wf = await resolveWorkflow(w.t.app.ctx.pool, orgId(), `${QUOTE}-custom`, w.projectId);
    expect(wf?.version).toBe(2);
  });

  it('collision: an organization workflow already called <key>-custom is not touched, the copy takes -custom-2', async () => {
    expect((await orgRows('business-report-custom')).map((r: any) => r.name)).toEqual(['My own report']);
    expect((await orgRows(`${REPORT}-custom-2`)).map((r: any) => r.name)).toEqual([
      'Report for the board (edited)',
    ]);
    expect(await orgRows(REPORT)).toEqual([]);
  });

  it('is idempotent and a projection rebuild reproduces the result', async () => {
    await q('DELETE FROM data_migrations WHERE name=$1', [BUSINESS_BUILTIN_MIGRATION]);
    const before = (await q('SELECT max(seq)::int AS s FROM events'))[0]!.s;
    const again = await migrate();
    expect(again).toMatchObject({ retired: [], converted: [] });
    expect((await q('SELECT max(seq)::int AS s FROM events'))[0]!.s).toBe(before);

    const state = async () => ({
      wf: await q(
        `SELECT org_id, key, version, status, name, definition, base_key FROM workflow_versions WHERE key LIKE 'business-%' ORDER BY org_id NULLS FIRST, key, version`,
      ),
      pw: await q(
        `SELECT project_id, workflow_key, is_primary, default_card_types FROM project_workflows ORDER BY project_id, workflow_key`,
      ),
      pk: await q(`SELECT id, workflow_key FROM projects ORDER BY id`),
    });
    snapshot = await state();
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await state()).toEqual(snapshot);
  });
});
