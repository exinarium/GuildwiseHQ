import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import { type DeliveryWorld, deliveryWorld } from './helpers/delivery.ts';
import { ok } from './helpers/world.ts';

// Merging two places re-points the unfinished phase follow-ups through an event (PhaseFollowupRetargeted), so the projection
// replays it. (Its own file: the rebuild forgets the places the other Environments tests insert straight into the tables.)

const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];
let d: DeliveryWorld;

beforeAll(async () => {
  d = await deliveryWorld();
});
afterAll(async () => {
  await d.w.t.close();
  await closeAdminPool();
});

const base = () => `/api/projects/${d.w.projectId}`;
const call = (method: string, url: string, body?: unknown, status = 200) =>
  ok<any>(
    d.w.t.req(method, url, {
      cookie: d.w.owner.cookie,
      headers: { 'x-aom-org': d.orgId },
      ...(body === undefined ? {} : { body }),
    }),
    status,
  );

describe('merging places', () => {
  it('re-points unfinished follow-ups with an event, and a rebuild of the projections gives the same rows', async () => {
    const mk = (name: string) =>
      call(
        'POST',
        `${base()}/deploy-targets`,
        { name, kind: 'remote_ssh', workstationId: d.w.workstationId, host: 'merge-box', notes: '' },
        201,
      );
    const keep = await mk('merge-keep');
    const dup = await mk('merge-dup');
    const phase = await call(
      'POST',
      `${base()}/phases`,
      { name: 'Merge phase', followups: [{ kind: 'deploy', targetId: dup.id }] },
      201,
    );
    const rows = () =>
      q('SELECT id, target_id, status FROM phase_followups WHERE phase_id=$1 ORDER BY position', [phase.id]);
    expect((await rows())[0].target_id).toBe(dup.id);

    const res = await call('POST', `${base()}/places/merge`, { fromId: dup.id, toId: keep.id });
    expect(res.followupsRepointed).toBe(1);
    expect((await rows())[0].target_id).toBe(keep.id);
    // an event says so (no write behind the event log's back)
    const ev = await q(`SELECT payload FROM events WHERE type='PhaseFollowupRetargeted'`);
    expect(ev.map((e) => e.payload)).toContainEqual({ fromTargetId: dup.id, toTargetId: keep.id });

    const before = await rows();
    await rebuildProjections(d.w.t.app.ctx.pool, d.w.t.app.ctx.store);
    expect(await rows()).toEqual(before);
  });
});
