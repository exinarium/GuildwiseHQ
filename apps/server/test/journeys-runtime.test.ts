import type { JourneyDefinitionInput } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeStep, sweepJourneys } from '../src/commands/journey-runtime.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * Journey runtime (docs/investigations/GWP-66): a journey step starts a card; when the card ends the instance follows the
 * first matching handoff. Transitions are idempotent and kept in tables, so a restart continues where it stopped.
 * The cards stay drafts (the workflow's required fields are not filled in); a test ends one by setting its status.
 */
let w: World;
let wf = '';
const ctx = () => w.t.app.ctx;
const asOwner = (method: string, url: string, body?: unknown, expected = 200) =>
  ok<any>(
    w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }),
    expected,
  );

const def = (over: Partial<JourneyDefinitionInput> = {}): JourneyDefinitionInput => ({
  name: 'Rentals',
  recordType: 'client',
  firstStepId: 'lead',
  steps: [
    { kind: 'workflow', id: 'lead', label: 'Lead', workflowKey: wf },
    { kind: 'workflow', id: 'viewing', label: 'Viewing', workflowKey: wf },
    { kind: 'wait', id: 'wait_docs', label: 'Documents' },
    { kind: 'workflow', id: 'rent', label: 'Rent', workflowKey: wf },
  ],
  handoffs: [
    { id: 'h1', from: 'lead', on: 'cancelled', to: 'end' },
    { id: 'h2', from: 'lead', on: 'done', to: 'viewing' },
    { id: 'h3', from: 'viewing', on: 'any', to: 'wait_docs' },
    { id: 'h4', from: 'wait_docs', on: 'done', to: 'rent' },
    {
      id: 'h5',
      from: 'rent',
      on: 'done',
      to: 'rent',
      condition: { source: 'record', field: 'visits', op: 'lt', value: 2 },
    },
    { id: 'h6', from: 'rent', on: 'done', to: 'end' },
  ],
  ...over,
});

const createJourney = async (d: JourneyDefinitionInput = def()) =>
  (await asOwner('POST', '/api/journeys', { projectId: w.projectId, definition: d }, 201)).id as string;
const start = async (journeyId: string, name = 'Ann') =>
  (
    await asOwner(
      'POST',
      '/api/journey-instances',
      { journeyId, record: { type: 'client', displayName: name } },
      201,
    )
  ).id as string;
const instance = async (id: string) =>
  (await q('SELECT * FROM journey_instances WHERE id=$1', [id]))[0] as any;
const runs = async (id: string) =>
  (await q('SELECT * FROM journey_step_runs WHERE instance_id=$1 ORDER BY visit', [id])) as any[];
const endCard = (cardId: string, status: 'done' | 'cancelled') =>
  q('UPDATE cards SET status=$2 WHERE id=$1', [cardId, status]);
const settle = async () => {
  for (let i = 0; i < 6; i++) await sweepJourneys(ctx());
};

beforeAll(async () => {
  w = await createWorld();
  wf = (
    await q('SELECT workflow_key FROM project_workflows WHERE project_id=$1 AND is_primary', [w.projectId])
  )[0]!.workflow_key as string;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('designer round trip', () => {
  it('saves a new version with a condition and a loop and reopens it unchanged', async () => {
    const id = await createJourney();
    const v1 = await asOwner('GET', `/api/journeys/${id}`);
    expect(v1.definition.handoffs.find((h: any) => h.id === 'h5').condition).toMatchObject({
      op: 'lt',
      value: 2,
    });
    const edited = { ...v1.definition, name: 'Rentals 2' };
    await asOwner('PUT', `/api/journeys/${id}`, { definition: edited, baseVersion: 1 });
    expect((await asOwner('GET', `/api/journeys/${id}`)).definition).toEqual(edited);
    // a stale base version is refused
    await asOwner('PUT', `/api/journeys/${id}`, { definition: edited, baseVersion: 1 }, 409);
  });
  it('creates the rentals template and lists the templates', async () => {
    const t = (await asOwner('GET', '/api/journey-templates')).items;
    expect(t.map((x: any) => x.id)).toContain('rentals');
    const { id } = await asOwner(
      'POST',
      '/api/journeys',
      { projectId: w.projectId, templateId: 'rentals' },
      201,
    );
    const got = await asOwner('GET', `/api/journeys/${id}`);
    expect(got.definition.steps).toHaveLength(10);
  });
  it('refuses to start a journey that has errors', async () => {
    const id = await createJourney(
      def({ steps: [{ kind: 'workflow', id: 'lead', label: 'Lead', workflowKey: null }], handoffs: [] }),
    );
    await asOwner(
      'POST',
      '/api/journey-instances',
      { journeyId: id, record: { type: 'client', displayName: 'X' } },
      400,
    );
  });
});

describe('runtime', () => {
  it('starts at the first workflow, follows the handoffs, loops and ends, with a history', async () => {
    const j = await createJourney();
    const id = await start(j);
    expect(await instance(id)).toMatchObject({
      status: 'running',
      current_step_id: 'lead',
      current_visit: 1,
    });
    await settle();
    let r = await runs(id);
    expect(r[0]).toMatchObject({ status: 'open', step_id: 'lead' });
    const card = (await q('SELECT * FROM cards WHERE id=$1', [r[0].card_id]))[0] as any;
    expect(card.origin).toBe('journey');

    await endCard(r[0].card_id, 'done');
    await settle();
    r = await runs(id);
    expect(r.map((x) => [x.step_id, x.status])).toEqual([
      ['lead', 'done'],
      ['viewing', 'open'],
    ]);
    await endCard(r[1].card_id, 'cancelled');
    await settle();
    expect(await instance(id)).toMatchObject({ status: 'waiting', current_step_id: 'wait_docs' });
    await asOwner('POST', `/api/journey-instances/${id}/continue`, { visit: 3 });
    await settle();
    r = await runs(id);
    expect(r[3]).toMatchObject({ step_id: 'rent', status: 'open' });
    await endCard(r[3].card_id, 'done'); // visits of rent = 1 < 2: loop
    await settle();
    r = await runs(id);
    expect(r[4]).toMatchObject({
      step_id: 'rent',
      visit: 5,
      status: 'open',
      from_visit: 4,
      handoff_id: 'h5',
    });
    await endCard(r[4].card_id, 'done'); // visits = 2: end
    await settle();
    expect(await instance(id)).toMatchObject({ status: 'completed' });
    const view = await asOwner('GET', `/api/journey-instances/${id}`);
    expect(view.history).toHaveLength(5);
    expect(view.history.every((h: any) => h.enteredAt)).toBe(true);
  });

  it('a cancelled card takes the cancelled handoff and ends the journey', async () => {
    const id = await start(await createJourney(), 'Bob');
    await settle();
    await endCard((await runs(id))[0].card_id, 'cancelled');
    await settle();
    expect(await instance(id)).toMatchObject({ status: 'completed' });
  });

  it('is idempotent: repeated and concurrent passes make one transition', async () => {
    const id = await start(await createJourney(), 'Cy');
    await Promise.all([sweepJourneys(ctx()), sweepJourneys(ctx())]);
    await sweepJourneys(ctx());
    expect((await runs(id)).filter((x) => x.card_id)).toHaveLength(1);
    const cardId = (await runs(id))[0].card_id;
    await endCard(cardId, 'done');
    const results = await Promise.all([
      completeStep(ctx(), id, 1),
      completeStep(ctx(), id, 1),
      sweepJourneys(ctx()),
    ]);
    expect(results.slice(0, 2).filter(Boolean).length).toBeLessThanOrEqual(1);
    expect(await completeStep(ctx(), id, 1)).toBe(false);
    expect((await runs(id)).map((x) => x.step_id)).toEqual(['lead', 'viewing']);
  });

  it('continues after a restart: state is in the tables and a rebuild gives the same rows', async () => {
    const id = await start(await createJourney(), 'Di');
    await settle();
    const cardId = (await runs(id))[0].card_id;
    await endCard(cardId, 'done'); // ended while "the server was down"
    const before = await runs(id);
    expect(before[0].card_id).toBe(cardId);
    await rebuildProjections(ctx().pool, ctx().store);
    expect(await runs(id)).toEqual(before);
    await endCard(cardId, 'done');
    await settle(); // a fresh sweep, nothing held in memory
    expect((await runs(id))[1]).toMatchObject({ step_id: 'viewing' });
  });

  it('a handoff set with no match leaves the instance stuck with a desk notice', async () => {
    const d = def({ handoffs: [{ id: 'h1', from: 'lead', on: 'cancelled', to: 'viewing' }] });
    const id = await start(await createJourney(d), 'Ed');
    await settle();
    await endCard((await runs(id))[0].card_id, 'done');
    await settle();
    expect((await instance(id)).status).toBe('stuck');
    expect((await q(`SELECT 1 FROM desk_items WHERE subkind='journey_step_refused'`)).length).toBeGreaterThan(
      0,
    );
  });

  it('a step whose workflow is not enabled is refused with a desk notice', async () => {
    const d = def({
      steps: [{ kind: 'workflow', id: 'lead', label: 'Lead', workflowKey: wf }],
      handoffs: [],
    });
    const j = await createJourney(d);
    const id = await start(j, 'Flo');
    await q(
      `UPDATE journey_versions SET definition = jsonb_set(definition, '{steps,0,workflowKey}', '"not-enabled-wf"') WHERE journey_id=$1`,
      [j],
    );
    await settle();
    expect(await instance(id)).toMatchObject({ status: 'stuck' });
    expect((await runs(id))[0].status).toBe('refused');
  });

  it('cancelling stops the instance', async () => {
    const id = await start(await createJourney(), 'Gus');
    await settle();
    await asOwner('POST', `/api/journey-instances/${id}/cancel`);
    expect((await instance(id)).status).toBe('cancelled');
    await endCard((await runs(id))[0].card_id, 'done');
    await settle();
    expect(await runs(id)).toHaveLength(1);
  });

  it('lists instances with filters by step and status', async () => {
    const all = (await asOwner('GET', `/api/journey-instances?projectId=${w.projectId}`)).items;
    expect(all.length).toBeGreaterThan(2);
    const stuck = (await asOwner('GET', `/api/journey-instances?projectId=${w.projectId}&status=stuck`))
      .items;
    expect(stuck.every((i: any) => i.status === 'stuck')).toBe(true);
    const lead = (await asOwner('GET', `/api/journey-instances?projectId=${w.projectId}&stepId=lead`)).items;
    expect(lead.every((i: any) => i.stepId === 'lead')).toBe(true);
  });
});
