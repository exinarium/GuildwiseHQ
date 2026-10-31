import { briefWorkflowKey } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember } from './helpers/members.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** Install, edit and remove of the Brief playbooks. Needs the test database. */
let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_WEBHOOK_ALLOW_PRIVATE: 'true' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const hook = { kind: 'webhook', url: 'https://example.com/brief', format: 'generic' };
const mail = { kind: 'email', to: ['owner@example.com'], subject: '' };
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const schedule = async (id: string) => (await q('SELECT * FROM schedules WHERE id=$1', [id]))[0] as any;

describe('a developer organization', () => {
  it('refuses the playbooks and creates nothing', async () => {
    const res = await owner('POST', '/api/brief-playbooks/morning_plan/install', { destinations: [mail] });
    expect(res.status).toBe(409);
    expect(res.body.error?.code ?? res.body.code).toBe('business_only');
    expect(await q(`SELECT 1 FROM workflow_versions WHERE key LIKE 'business-brief-%'`)).toEqual([]);
  });
});

describe('a business organization', () => {
  let scheduleId = '';
  it('a manager installs Morning plan in one action', async () => {
    await ok(w.t.req('DELETE', `/api/projects/${w.projectId}/repos/${w.repoId}`, { cookie: w.owner.cookie }));
    await ok(owner('PATCH', '/api/org', { mode: 'business' }));
    const r = await ok<any>(
      owner('POST', '/api/brief-playbooks/morning_plan/install', {
        destinations: [mail, hook],
        timezone: 'Africa/Johannesburg',
      }),
      201,
    );
    scheduleId = r.scheduleId;
    const s = await schedule(scheduleId);
    expect(s.trigger).toMatchObject({ kind: 'cron', cron: '0 7 * * 1-5', timezone: 'Africa/Johannesburg' });
    expect(s.action.playbook.key).toBe('morning_plan');
    expect(s.action.template.workflowKey).toBe(briefWorkflowKey('personal_assistant'));
    expect(s.action.deliverOutput.destinations).toHaveLength(2);
    expect(s.action.deliverOutput.secretEnc).toBeTruthy();
    const on = await q(
      `SELECT default_card_types FROM project_workflows WHERE project_id=$1 AND workflow_key=$2`,
      [w.projectId, briefWorkflowKey('personal_assistant')],
    );
    expect(on[0]?.default_card_types).toEqual([]);
  });
  it('a second install is refused with the schedule to edit', async () => {
    const res = await owner('POST', '/api/brief-playbooks/morning_plan/install', { destinations: [mail] });
    expect(res.status).toBe(409);
  });
  it('a member cannot install', async () => {
    const m = await addMember(w, 'member');
    const res = await w.t.req('POST', '/api/brief-playbooks/weekly_owner_brief/install', {
      cookie: m.cookie,
      body: { destinations: [mail] },
    });
    expect(res.status).toBe(403);
  });
  it('editing the time, owner role, cap and destinations changes the next run', async () => {
    await ok(
      owner('PATCH', `/api/brief-playbooks/schedules/${scheduleId}`, {
        time: '08:30',
        ownerRole: 'operations_analyst',
        maxWords: 90,
        destinations: [mail],
      }),
    );
    const s = await schedule(scheduleId);
    expect(s.trigger.cron).toBe('30 8 * * 1-5');
    expect(s.action.template.workflowKey).toBe(briefWorkflowKey('operations_analyst'));
    expect(s.action.template.fields.maxWords).toBe(90);
    expect(s.action.deliverOutput.destinations).toEqual([expect.objectContaining({ kind: 'email' })]);
  });
  it('removing the playbook deletes its schedule', async () => {
    await ok(owner('DELETE', `/api/schedules/${scheduleId}`));
    expect(await q('SELECT 1 FROM schedules WHERE id=$1', [scheduleId])).toEqual([]);
  });
});
