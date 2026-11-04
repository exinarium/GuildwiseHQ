import { RECORD_COLUMNS, RECORD_REF_COLUMNS } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** Owner decision 5: the shared record holds status, step, timestamps and references only, never content. */
let w: World;
let journeyId = '';
const post = (url: string, body: unknown) => w.t.req('POST', url, { cookie: w.owner.cookie, body });

beforeAll(async () => {
  w = await createWorld();
  const wf = (
    await q('SELECT workflow_key FROM project_workflows WHERE project_id=$1 AND is_primary', [w.projectId])
  )[0]!.workflow_key;
  const res = await ok<any>(
    post('/api/journeys', {
      projectId: w.projectId,
      definition: {
        name: 'J',
        recordType: 'client',
        firstStepId: 'a',
        steps: [{ kind: 'workflow', id: 'a', label: 'A', workflowKey: wf }],
        handoffs: [],
      },
    }),
    201,
  );
  journeyId = res.id;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const columns = async (table: string) =>
  ((await q(`SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [table])) as any[])
    .map((r) => r.column_name as string)
    .sort();

describe('the shared record holds no content', () => {
  it('has only the allow-listed columns', async () => {
    expect(await columns('journey_records')).toEqual([...RECORD_COLUMNS].sort());
    expect(await columns('journey_record_refs')).toEqual([...RECORD_REF_COLUMNS].sort());
  });

  it('refuses answers and document content when starting on a record', async () => {
    const base = { journeyId, record: { type: 'client', displayName: 'Ann' } };
    expect((await post('/api/journey-instances', { ...base, answers: { q: 'a' } })).status).toBe(400);
    expect(
      (await post('/api/journey-instances', { ...base, record: { ...base.record, answers: { q: 'a' } } }))
        .status,
    ).toBe(400);
    expect(
      (
        await post('/api/journey-instances', {
          ...base,
          record: { ...base.record, documents: [{ content: 'x' }] },
        })
      ).status,
    ).toBe(400);
  });

  it('accepts references and refuses content in them', async () => {
    const { recordId } = await ok<any>(
      post('/api/journey-instances', { journeyId, record: { type: 'client', displayName: 'Bo' } }),
      201,
    );
    const url = `/api/journey-records/${recordId}/references`;
    const good = await ok<any>(
      post(url, { kind: 'document', ref: 's3://firm-bucket/clients/bo/id.pdf', label: 'ID' }),
    );
    expect(good.references.some((r: any) => r.ref.startsWith('s3://'))).toBe(true);
    expect((await post(url, { kind: 'document', ref: 'x', content: 'secret text' })).status).toBe(400);
    expect((await post(url, { kind: 'document', ref: 'data:text/plain;base64,AAAA' })).status).toBe(400);
    expect((await post(url, { kind: 'form_submission', ref: 'free text answers with spaces' })).status).toBe(
      400,
    );
    const rec = await ok<any>(w.t.req('GET', `/api/journey-records/${recordId}`, { cookie: w.owner.cookie }));
    expect(Object.keys(rec).sort()).toEqual(
      [
        'createdAt',
        'currentInstanceId',
        'currentStepId',
        'displayName',
        'externalId',
        'id',
        'orgId',
        'projectId',
        'references',
        'status',
        'type',
        'updatedAt',
      ].sort(),
    );
  });

  it('a journey event never carries a form answer: the stored payloads only have ids, keys and labels', async () => {
    const rows = (await q(`SELECT payload FROM events WHERE type LIKE 'JourneyRecord%'`)) as any[];
    for (const r of rows)
      expect(
        Object.keys(r.payload).every((k) =>
          [
            'recordId',
            'orgId',
            'projectId',
            'recordType',
            'externalId',
            'displayName',
            'kind',
            'ref',
            'label',
          ].includes(k),
        ),
      ).toBe(true);
  });
});
