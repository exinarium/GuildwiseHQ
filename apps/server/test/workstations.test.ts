import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, pairWorkstation, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ listen: false });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('workstations', () => {
  it('lists own workstations with runtimes, presence and matched repos', async () => {
    const list = await ok<any>(w.t.req('GET', '/api/workstations', { cookie: w.owner.cookie }));
    expect(list.workstations).toHaveLength(1);
    expect(list.workstations[0]).toMatchObject({
      id: w.workstationId,
      name: 'Desk',
      status: 'active',
      connected: false,
      platform: 'linux',
      repos: [],
      runtimes: [],
    });
    expect(list.workstations[0]).not.toHaveProperty('tokenHash');
    expect(JSON.stringify(list)).not.toContain(w.runnerToken);
  });

  it('renames (owner only) and unlinks (owner or admin, once)', async () => {
    const r = await w.t.req('PATCH', `/api/workstations/${w.workstationId}`, {
      cookie: w.owner.cookie,
      body: { name: 'Studio' },
    });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Studio');
    const other = await w.t.userSession(uniqueEmail('x'));
    expect(
      (
        await w.t.req('PATCH', `/api/workstations/${w.workstationId}`, {
          cookie: other.cookie,
          body: { name: 'hax' },
        })
      ).status,
    ).toBe(404);

    const extra = await pairWorkstation(w.t, w.owner, 'Extra');
    expect(
      (await w.t.req('POST', `/api/workstations/${extra.workstationId}/unlink`, { cookie: w.owner.cookie }))
        .status,
    ).toBe(200);
    expect(
      (await w.t.req('POST', `/api/workstations/${extra.workstationId}/unlink`, { cookie: w.owner.cookie }))
        .status,
    ).toBe(409);
  });

  it('unpairing fails the DevOps requests that were queued for the workstation, with the reason', async () => {
    const box = await pairWorkstation(w.t, w.owner, 'Doomed box');
    const req = await ok<any>(
      w.t.req('POST', '/api/devops/requests', {
        cookie: w.owner.cookie,
        body: { workstationId: box.workstationId, summary: 'Install the toolchain' },
      }),
      201,
    );
    expect(req.request.status).toBe('queued');
    await q(
      `INSERT INTO runner_token_rotations (workstation_id, token_hash, issued_at) VALUES ($1,$2,now())`,
      [box.workstationId, 'pending-rotation-hash'],
    );
    await ok(w.t.req('POST', `/api/workstations/${box.workstationId}/unlink`, { cookie: w.owner.cookie }));
    const after = await ok<any>(
      w.t.req('GET', `/api/devops/requests/${req.request.id}`, { cookie: w.owner.cookie }),
    );
    expect(after.request.status).toBe('failed');
    expect(after.request.resultSummary).toContain('was unpaired');
    expect(after.messages.map((m: any) => m.body).join('\n')).toContain('Pair the machine again');
    expect(
      (await q('SELECT 1 FROM runner_token_rotations WHERE workstation_id=$1', [box.workstationId])).length,
    ).toBe(0);
    expect((await q('SELECT status FROM workstations WHERE id=$1', [box.workstationId]))[0]?.status).toBe(
      'unlinked',
    );
  });
});
