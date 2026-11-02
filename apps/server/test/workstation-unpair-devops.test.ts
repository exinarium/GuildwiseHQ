import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrateOrphanedDevops, ORPHANED_DEVOPS_MIGRATION } from '../src/data-migrations/index.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import { createWorld, ok, pairWorkstation, type World } from './helpers/world.ts';

/**
 * Unpairing a workstation retires its DevOps engineers in the same append (history kept, audit event per agent), releases
 * their work, flags the other agents, and the one-time migration retires engineers that were orphaned earlier.
 */
const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];
let w: World;
beforeAll(async () => {
  w = await createWorld({ listen: false });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const devopsOf = (ws: string) =>
  q(`SELECT id, name, status FROM agents WHERE workstation_id=$1 AND is_devops ORDER BY hired_at, id`, [ws]);
const env = () => ({
  pool: w.t.app.ctx.pool,
  store: w.t.app.ctx.store,
  clock: w.t.app.ctx.clock,
  log: () => {},
});

describe('unpairing retires the DevOps engineers of the workstation', () => {
  it('retires them, keeps history, writes an audit event and releases their open work', async () => {
    const box = await pairWorkstation(w.t, w.owner, 'Doomed box');
    const before = await devopsOf(box.workstationId);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((a) => a.status === 'active')).toBe(true);
    const agent = before[0];
    const org = (await q('SELECT org_id FROM agents WHERE id=$1', [agent.id]))[0].org_id;
    const shiftId = randomUUID();
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at)
       VALUES ($1,$2,$3,$4,'devops','running','mock','mock',now())`,
      [shiftId, org, agent.id, box.workstationId],
    );
    const req = await ok<any>(
      w.t.req('POST', '/api/devops/requests', {
        cookie: w.owner.cookie,
        body: { workstationId: box.workstationId, summary: 'Install the toolchain' },
      }),
      201,
    );

    await ok(w.t.req('POST', `/api/workstations/${box.workstationId}/unlink`, { cookie: w.owner.cookie }));

    const after = await devopsOf(box.workstationId);
    expect(after.map((a) => a.id)).toEqual(before.map((a) => a.id));
    expect(after.every((a) => a.status === 'retired')).toBe(true); // soft retire: rows are kept
    expect((await q('SELECT status FROM shifts WHERE id=$1', [shiftId]))[0].status).toBe('ended');
    const request = await ok<any>(
      w.t.req('GET', `/api/devops/requests/${req.request.id}`, { cookie: w.owner.cookie }),
    );
    expect(request.request.status).toBe('failed');
    for (const a of before) {
      const ev = await q(
        `SELECT payload, actor FROM events WHERE type='AgentRetired' AND payload->>'agentId'=$1`,
        [a.id],
      );
      expect(ev).toHaveLength(1);
      expect(ev[0].payload).toMatchObject({
        reason: 'workstation_unpaired',
        workstationId: box.workstationId,
        by: w.owner.id,
      });
      expect(ev[0].actor).toMatchObject({ kind: 'user', id: w.owner.id });
    }
    const board = await ok<any>(w.t.req('GET', '/api/agents', { cookie: w.owner.cookie }));
    const list = board.agents;
    expect(
      list.filter((a: any) => a.workstationId === box.workstationId && a.status === 'active'),
    ).toHaveLength(0);
  });

  it('is atomic: a failure while retiring leaves the workstation paired and the agents active', async () => {
    const box = await pairWorkstation(w.t, w.owner, 'Atomic box');
    const spy = vi.spyOn(w.t.app.ctx.store, 'append').mockRejectedValueOnce(new Error('boom'));
    const r = await w.t.req('POST', `/api/workstations/${box.workstationId}/unlink`, {
      cookie: w.owner.cookie,
    });
    spy.mockRestore();
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect((await q('SELECT status FROM workstations WHERE id=$1', [box.workstationId]))[0].status).toBe(
      'active',
    );
    expect((await devopsOf(box.workstationId)).every((a) => a.status === 'active')).toBe(true);
  });

  it('keeps refusing to fire a DevOps engineer of a paired workstation', async () => {
    const box = await pairWorkstation(w.t, w.owner, 'Paired box');
    const [a] = await devopsOf(box.workstationId);
    const r = await w.t.req('POST', `/api/agents/${a.id}/fire`, { cookie: w.owner.cookie });
    expect(r.status).toBe(409);
    expect((await devopsOf(box.workstationId))[0].status).toBe('active');
  });

  it('releases a card claimed by the DevOps engineer exactly once', async () => {
    const box = await pairWorkstation(w.t, w.owner, 'Claim box');
    const [agent] = await devopsOf(box.workstationId);
    const card = await w.card();
    const claimId = randomUUID();
    await q(
      `UPDATE cards SET claim_id=$2, claimed_by_agent_id=$3, claim_workstation_id=$4, claim_shift_id=gen_random_uuid(),
              claimed_at=now(), lease_expires_at=now() + interval '1 hour', status='claimed' WHERE id=$1`,
      [card.id, claimId, agent.id, box.workstationId],
    );
    await ok(w.t.req('POST', `/api/workstations/${box.workstationId}/unlink`, { cookie: w.owner.cookie }));
    const ev = await q(
      `SELECT payload FROM events WHERE type='ClaimReleased' AND payload->>'cardId'=$1 AND payload->>'claimId'=$2`,
      [card.id, claimId],
    );
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.reason).toBe('agent_retired');
    const row = (await q('SELECT claim_id, claimed_by_agent_id FROM cards WHERE id=$1', [card.id]))[0];
    expect(row.claim_id).toBeNull();
    expect(row.claimed_by_agent_id).toBeNull();
  });

  it('keeps a non-DevOps agent active and flags it as needing a new workstation', async () => {
    const box = await pairWorkstation(w.t, w.owner, 'Flag box');
    const hired = await w.hire('Flagged', 'builder', 'junior', { workstationId: box.workstationId });
    const id = hired.agent?.id ?? hired.id;
    const flag = async () =>
      (await ok<any>(w.t.req('GET', '/api/agents', { cookie: w.owner.cookie }))).agents.find(
        (a: any) => a.id === id,
      );
    expect((await flag()).workstationRemoved).toBe(false);
    await ok(w.t.req('POST', `/api/workstations/${box.workstationId}/unlink`, { cookie: w.owner.cookie }));
    const after = await flag();
    expect(after.status).not.toBe('retired');
    expect(after.workstationRemoved).toBe(true);
    expect((await q('SELECT status FROM agents WHERE id=$1', [id]))[0].status).not.toBe('retired');
  });

  it('re-pairing creates new DevOps engineers and leaves the retired ones retired', async () => {
    const first = await pairWorkstation(w.t, w.owner, 'Again');
    const old = await devopsOf(first.workstationId);
    await ok(w.t.req('POST', `/api/workstations/${first.workstationId}/unlink`, { cookie: w.owner.cookie }));
    const second = await pairWorkstation(w.t, w.owner, 'Again');
    const fresh = await devopsOf(second.workstationId);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((a) => a.status === 'active')).toBe(true);
    expect(fresh.some((a) => old.some((o) => o.id === a.id))).toBe(false);
    expect((await devopsOf(first.workstationId)).every((a) => a.status === 'retired')).toBe(true);
  });
});

describe('orphaned DevOps engineers migration', () => {
  it('retires engineers of an unlinked workstation, ignores a paired but offline one, and is idempotent', async () => {
    const gone = await pairWorkstation(w.t, w.owner, 'Gone');
    const offline = await pairWorkstation(w.t, w.owner, 'Offline');
    // the unpair of the old release: only the status changed
    await q(`UPDATE workstations SET status='unlinked', connected=false WHERE id=$1`, [gone.workstationId]);
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [offline.workstationId]);
    await q('DELETE FROM data_migrations WHERE name=$1', [ORPHANED_DEVOPS_MIGRATION]);

    const report = await migrateOrphanedDevops(env());
    expect(report?.retired).toBeGreaterThan(0);
    expect((await devopsOf(gone.workstationId)).every((a) => a.status === 'retired')).toBe(true);
    expect((await devopsOf(offline.workstationId)).every((a) => a.status === 'active')).toBe(true);
    const ev = await q(
      `SELECT payload FROM events WHERE type='AgentRetired' AND payload->>'workstationId'=$1`,
      [gone.workstationId],
    );
    expect(ev.length).toBeGreaterThan(0);
    expect(ev[0].payload.reason).toBe('orphaned_migration');

    expect(await migrateOrphanedDevops(env())).toBeNull(); // recorded once
    await q('DELETE FROM data_migrations WHERE name=$1', [ORPHANED_DEVOPS_MIGRATION]);
    expect(await migrateOrphanedDevops(env())).toMatchObject({ retired: 0 }); // nothing left to do
  });
});
