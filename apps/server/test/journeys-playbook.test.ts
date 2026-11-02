import { PACKS_CAPABILITY, SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepJourneys } from '../src/commands/journey-runtime.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** A step can name a playbook; the route starts it through the unchanged playbook feature and keeps a reference. */
let w: World;
let r: FakeRunner;
let wf = '';
const asOwner = (method: string, url: string, body?: unknown, expected = 200) =>
  ok<any>(w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }), expected);

beforeAll(async () => {
  w = await createWorld();
  r = await w.connectRunner({ capabilities: [SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY, PACKS_CAPABILITY] });
  wf = (await q('SELECT workflow_key FROM project_workflows WHERE project_id=$1 AND is_primary', [w.projectId]))[0]!.workflow_key;
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const startWith = async (playbookKey: string) => {
  const j = await asOwner('POST', '/api/journeys', {
    projectId: w.projectId,
    definition: {
      name: 'P', recordType: 'deal', firstStepId: 'a',
      steps: [{ kind: 'workflow', id: 'a', label: 'Intake', workflowKey: wf, playbook: { key: playbookKey, name: playbookKey } }],
      handoffs: [],
    },
  }, 201);
  const inst = await asOwner('POST', '/api/journey-instances', { journeyId: j.id, record: { type: 'deal', displayName: 'Deal 1' } }, 201);
  await sweepJourneys(w.t.app.ctx);
  return inst as { id: string; recordId: string };
};

describe('a playbook in a step', () => {
  it('starts a guided session and keeps it as a reference on the step and the record', async () => {
    const inst = await startWith('prd');
    const out = await asOwner('POST', `/api/journey-instances/${inst.id}/playbook`, { visit: 1 }, 201);
    expect(out.path).toBe(`/discovery/${out.threadId}`);
    const run = (await q('SELECT playbook_thread_id FROM journey_step_runs WHERE instance_id=$1', [inst.id]))[0] as any;
    expect(run.playbook_thread_id).toBe(out.threadId);
    const refs = (await q(`SELECT ref FROM journey_record_refs WHERE record_id=$1 AND kind='playbook_session'`, [inst.recordId])) as any[];
    expect(refs.map((x) => x.ref)).toEqual([out.threadId]);
    // the step is unaffected: its card still runs
    expect((await q('SELECT status FROM journey_step_runs WHERE instance_id=$1', [inst.id]))[0]).toMatchObject({ status: 'open' });
  });
  it('an unknown playbook is refused by the playbook feature itself', async () => {
    const inst = await startWith('no-such-playbook');
    const res = await w.t.req('POST', `/api/journey-instances/${inst.id}/playbook`, { cookie: w.owner.cookie, body: { visit: 1 } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('unknown_playbook');
  });
  it('a step without a playbook says so', async () => {
    const j = await asOwner('POST', '/api/journeys', {
      projectId: w.projectId,
      definition: { name: 'Q', recordType: 'deal', firstStepId: 'a', steps: [{ kind: 'workflow', id: 'a', label: 'A', workflowKey: wf }], handoffs: [] },
    }, 201);
    const inst = await asOwner('POST', '/api/journey-instances', { journeyId: j.id, record: { type: 'deal', displayName: 'D2' } }, 201);
    const res = await w.t.req('POST', `/api/journey-instances/${inst.id}/playbook`, { cookie: w.owner.cookie, body: { visit: 1 } });
    expect(res.status).toBe(400);
  });
});
