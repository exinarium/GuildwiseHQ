import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postFallbackReview } from '../src/ceo/report.ts';
import { appoint } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** The daily report carries "Things you keep asking me" and the order turns of the last day (docs sections 4.3 and 7.1). */
let w: World;
let orgId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  await appoint(w);
  orgId = (await q(`SELECT id FROM organizations WHERE owner_user_id=$1 LIMIT 1`, [w.owner.id]))[0]!.id;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('the report sections', () => {
  it('lists a repeat found by the report itself, with its jobs, and falls back to text without a CEO', async () => {
    const ctx = w.t.app.ctx;
    // four jobs of one kind in a week, logged without the repeat rule having run (the report re-checks every kind)
    for (let i = 0; i < 4; i++)
      await ctx.store.append([
        {
          streamId: streamId.ceo(orgId),
          event: {
            type: 'CeoOffboardJobLogged',
            payload: {
              jobId: randomUUID(),
              orgId,
              kind: 'send-invoices',
              title: `Send the invoices ${i}`,
              summary: '',
              costMicros: 0,
              durationMs: 1000,
              auto: false,
            },
          },
          actor: { kind: 'system', id: null },
          scope: { orgId, projectId: null, audience: 'org' },
        },
      ]);
    expect(await q(`SELECT 1 FROM ceo_repeats WHERE org_id=$1`, [orgId])).toHaveLength(0);
    await postFallbackReview(ctx, orgId, '2026-10-19', []);
    const rep = (await q(`SELECT * FROM ceo_repeats WHERE org_id=$1`, [orgId]))[0]!;
    expect(rep).toMatchObject({ key: 'send-invoices', status: 'open', suggestion: 'skill', count7: 4 });
    const item = (
      await q(
        `SELECT id, body, data FROM desk_items WHERE subkind='ceo_report' ORDER BY created_at DESC LIMIT 1`,
      )
    )[0]!;
    expect(item.body).toContain('Things you keep asking me');
    expect(item.body).toContain('send-invoices');
    expect(item.data.ceo.repeats[0]).toMatchObject({ key: 'send-invoices', suggestion: 'skill', count7: 4 });
    expect(item.data.ceo.orderTurns).toEqual([]);
    // the desk API hands the web page the same sections
    const desk = await ok<any>(w.t.req('GET', '/api/desk?limit=100', { cookie: w.owner.cookie }));
    const dto = (desk.items as any[]).find((x) => x.id === item.id);
    expect(dto.ceoReport.repeats[0]).toMatchObject({ key: 'send-invoices', jobs: expect.any(Array) });
    expect(dto.ceoReport.repeats[0].jobs).toHaveLength(4);
    expect(dto.ceoReport.orderTurns).toEqual([]);
    // the status counts the open repeat for the Overview
    expect((await ok<any>(w.t.req('GET', '/api/ceo/status', { cookie: w.owner.cookie }))).openRepeats).toBe(
      1,
    );
  });
});
