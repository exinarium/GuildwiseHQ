import { BUSINESS_CARD_TYPES, BUSINESS_WORKFLOW_KEY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * Business card types: nothing is installed in a developer organization; switching to Business installs the six shipped
 * workflows and enables them on its projects; a card of each type is created with its fields and no repository; a
 * workflow that uses repositories is refused there.
 */
let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const orgId = () => w.owner.id;
const keys = () => Object.values(BUSINESS_WORKFLOW_KEY);
const installed = async () =>
  (
    await q(
      `SELECT key FROM workflow_versions WHERE org_id=$1 AND key = ANY($2::text[]) AND status='active'`,
      [orgId(), keys()],
    )
  ).map((r: any) => r.key);
const enabled = async () =>
  (await q(`SELECT workflow_key, default_card_types FROM project_workflows WHERE project_id=$1`, [
    w.projectId,
  ])) as any[];
const newCard = (body: Record<string, unknown>) =>
  w.t.req('POST', '/api/cards', { cookie: w.owner.cookie, body: { projectId: w.projectId, ...body } });

const SAMPLE: Record<string, Record<string, string>> = {
  enquiry: { whoAsked: 'Mia Jones', question: 'Do you open on Sundays?', dueBy: '2026-11-03' },
  follow_up: { person: 'Sam', about: 'The signed contract', dueDate: '2026-11-05' },
  document_request: { document: 'Tax certificate', fromWhom: 'Accountant', deadline: '2026-11-30' },
  reminder: { what: 'Renew the licence', remindOn: '2026-12-01', forWhom: 'Owner' },
  report: { subject: 'Monthly sales', period: 'October', audience: 'Owner' },
  quote: { customer: 'Acme', scope: '10 chairs', amount: '1200', validUntil: '2026-12-15' },
};

describe('a developer organization', () => {
  it('has no business workflow', async () => {
    expect(await installed()).toEqual([]);
    expect((await enabled()).map((e) => e.workflow_key)).not.toContain('business-quote');
  });
});

describe('a business organization', () => {
  it('installs the six workflows and enables them on its project when it switches', async () => {
    await ok(w.t.req('DELETE', `/api/projects/${w.projectId}/repos/${w.repoId}`, { cookie: w.owner.cookie }));
    await ok(w.t.req('PATCH', '/api/org', { cookie: w.owner.cookie, body: { mode: 'business' } }));
    expect((await installed()).sort()).toEqual([...keys()].sort());
    const on = await enabled();
    for (const t of BUSINESS_CARD_TYPES) {
      const row = on.find((e) => e.workflow_key === BUSINESS_WORKFLOW_KEY[t]);
      expect(row?.default_card_types).toEqual([t]);
    }
    expect(on.some((e) => e.workflow_key === 'code')).toBe(true);
  });

  it('creating a card of each type keeps its fields, with no repository', async () => {
    for (const t of BUSINESS_CARD_TYPES) {
      const res = await ok<any>(
        newCard({ title: `A ${t}`, cardType: t, fields: SAMPLE[t], specify: false }),
        201,
      );
      expect(res.card.cardType).toBe(t);
      expect(res.card.workflowKey).toBe(BUSINESS_WORKFLOW_KEY[t]);
      expect(res.card.repoId).toBeNull();
      expect(res.card.effectiveCompletionAction).toBeNull();
      for (const [k, v] of Object.entries(SAMPLE[t] ?? {})) expect(String(res.card.fields[k])).toBe(v);
    }
  });

  it('refuses a card whose workflow uses repositories', async () => {
    const r = await newCard({ title: 'Fix it', cardType: 'feature', specify: false });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('business_mode_code_workflow');
  });

  it('does not overwrite a workflow the organization already changed, and installing twice adds nothing', async () => {
    const before = (
      await q(`SELECT count(*)::int AS n FROM workflow_versions WHERE org_id=$1`, [orgId()])
    )[0] as any;
    await ok(w.t.req('PATCH', '/api/org', { cookie: w.owner.cookie, body: { mode: 'dev' } }));
    await ok(w.t.req('PATCH', '/api/org', { cookie: w.owner.cookie, body: { mode: 'business' } }));
    const after = (
      await q(`SELECT count(*)::int AS n FROM workflow_versions WHERE org_id=$1`, [orgId()])
    )[0] as any;
    expect(after.n).toBe(before.n);
  });
});
