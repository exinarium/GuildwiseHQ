import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepJourneys } from '../src/commands/journey-runtime.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** Deleting a project permanently also removes its journeys, records, instances and step runs. */
let w: World;
const asOwner = (method: string, url: string, body?: unknown, expected = 200) =>
  ok<any>(
    w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }),
    expected,
  );

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('deleting a project that uses journeys', () => {
  it('returns 200 and leaves no journey rows of the project', async () => {
    const wf = (
      await q('SELECT workflow_key FROM project_workflows WHERE project_id=$1 AND is_primary', [w.projectId])
    )[0]!.workflow_key as string;
    const journey = await asOwner(
      'POST',
      '/api/journeys',
      {
        projectId: w.projectId,
        definition: {
          name: 'Delete me',
          recordType: 'client',
          firstStepId: 'lead',
          steps: [{ kind: 'workflow', id: 'lead', label: 'Lead', workflowKey: wf }],
          handoffs: [],
        },
      },
      201,
    );
    const inst = await asOwner(
      'POST',
      '/api/journey-instances',
      { journeyId: journey.id, record: { type: 'client', displayName: 'Ann' } },
      201,
    );
    for (let i = 0; i < 3; i++) await sweepJourneys(w.t.app.ctx);
    const run = (await q('SELECT card_id FROM journey_step_runs WHERE instance_id=$1', [inst.id]))[0] as any;
    expect(run?.card_id).toBeTruthy();
    await asOwner('POST', `/api/journey-records/${inst.recordId}/references`, {
      kind: 'document',
      ref: 's3://firm-bucket/clients/ann/id.pdf',
      label: 'ID',
    });
    expect((await q('SELECT 1 FROM journey_record_refs WHERE record_id=$1', [inst.recordId])).length).toBe(1);

    const key = (await q('SELECT key FROM projects WHERE id=$1', [w.projectId]))[0]!.key as string;
    await asOwner('POST', `/api/projects/${w.projectId}/archive`);
    await asOwner('POST', `/api/projects/${w.projectId}/delete`, { confirmKey: key });

    expect((await q('SELECT 1 FROM projects WHERE id=$1', [w.projectId])).length).toBe(0);
    expect((await q('SELECT 1 FROM journeys WHERE project_id=$1', [w.projectId])).length).toBe(0);
    expect((await q('SELECT 1 FROM journey_versions WHERE journey_id=$1', [journey.id])).length).toBe(0);
    expect((await q('SELECT 1 FROM journey_records WHERE project_id=$1', [w.projectId])).length).toBe(0);
    expect((await q('SELECT 1 FROM journey_record_refs WHERE record_id=$1', [inst.recordId])).length).toBe(0);
    expect((await q('SELECT 1 FROM journey_instances WHERE project_id=$1', [w.projectId])).length).toBe(0);
    expect((await q('SELECT 1 FROM journey_step_runs WHERE instance_id=$1', [inst.id])).length).toBe(0);
    expect((await q('SELECT 1 FROM cards WHERE id=$1', [run.card_id])).length).toBe(0);
  });
});
