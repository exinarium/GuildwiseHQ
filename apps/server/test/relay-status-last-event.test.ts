import { RelayIntegrationStatusSchema } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { createIntegration, makeBusiness } from './helpers/relay.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** The status of an integration carries the newest request as metadata only. */
let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  await makeBusiness(w);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  await q('TRUNCATE relay_requests, relay_presence, relay_integrations CASCADE');
});

const statuses = async () =>
  (await ok<any>(w.t.req('GET', '/api/relay/integrations/status', { cookie: w.owner.cookie })))
    .statuses as any[];
const record = (integrationId: string, at: string, outcome: string, status: number, size: number) =>
  q(
    `INSERT INTO relay_requests(at, org_id, integration_id, kind, method, size_bytes, status, latency_ms, outcome)
     VALUES ($1,$2,$3,'generic','POST',$4,$5,3,$6)`,
    [at, w.owner.id, integrationId, size, status, outcome],
  );

describe('relay status lastEvent', () => {
  it('is null before any request', async () => {
    await createIntegration(w);
    const [s] = await statuses();
    expect(s.lastEvent).toBeNull();
    expect(() => RelayIntegrationStatusSchema.parse(s)).not.toThrow();
  });

  it('is the newest request: outcome, status and size only', async () => {
    const m = await createIntegration(w);
    await record(m.integration.id, '2026-10-30T10:00:00.000Z', 'forwarded', 200, 120);
    await record(m.integration.id, '2026-10-30T11:00:00.000Z', 'runner_offline', 503, 2048);
    const [s] = await statuses();
    expect(s.lastEvent).toEqual({
      at: '2026-10-30T11:00:00.000Z',
      outcome: 'runner_offline',
      status: 503,
      sizeBytes: 2048,
    });
    expect(Object.keys(s.lastEvent).sort()).toEqual(['at', 'outcome', 'sizeBytes', 'status']);
    expect(JSON.stringify(s)).not.toMatch(/body|headers|query/);
  });
});
