import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { phasePass } from '../src/dispatcher/phases.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

// Lean Team v3 (S1b), section 9 "Dispatch passes skip capacity check": the DevOps and BA task passes (and the question
// pass, which takes the same closure) respect the workstation's shift limit like the card passes do.

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const dispatcher = () => w.t.app.ctx.services.dispatcher;
const conn = () => w.t.app.ctx.services.runners.get(w.workstationId);
const startsOf = (kind: string, from: number) =>
  r.received.slice(from).filter((f: any) => f.type === 'shift.start' && f.kind === kind);

/** The workstation runs `n` shifts and may run `limit`. */
async function setLoad(n: number, limit: number | null) {
  await q(`DELETE FROM shifts WHERE card_id IS NULL AND kind='card'`);
  const agent = (await q(`SELECT id FROM agents WHERE org_id=$1 AND NOT is_devops LIMIT 1`, [w.owner.id]))[0];
  const aid = agent?.id ?? (await w.hire('Ivy', 'builder', 'junior')).id;
  for (let i = 0; i < n; i++)
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, stage, status, runtime, model, overflow, started_at)
       VALUES ($1,$2,$3,$4,'card','build','running','mock','mock',false,now())`,
      [randomUUID(), w.owner.id, aid, w.workstationId],
    );
  const c = conn();
  if (c) c.maxShifts = limit ?? 1_000_000;
  await q('UPDATE workstations SET last_seen_at=$1 WHERE id=$2', [w.t.clock.now(), w.workstationId]);
}

describe('a full workstation is offered no DevOps and no BA task shift', () => {
  it('DevOps: the request waits while the workstation is full and starts when there is room', async () => {
    await w.hire('Ivy', 'builder', 'junior');
    await setLoad(1, 1);
    const from = r.received.length;
    await ok(
      owner('POST', '/api/devops/requests', {
        workstationId: w.workstationId,
        summary: 'Install the toolchain',
      }),
      201,
    );
    await dispatcher().run();
    await r.barrier();
    expect(startsOf('devops', from)).toHaveLength(0);
    expect((await q(`SELECT status FROM devops_requests ORDER BY created_at DESC LIMIT 1`))[0]?.status).toBe(
      'queued',
    );
    await setLoad(0, 1);
    await dispatcher().run();
    await r.waitFor('shift.start', (f) => f.kind === 'devops', 5000, from);
    expect(startsOf('devops', from)).toHaveLength(1);
  });

  it('BA task: queued while the workstation is full, dispatched when there is room', async () => {
    await q(`UPDATE shifts SET status='ended', ended_at=now(), outcome='reported' WHERE status <> 'ended'`);
    await w.hire('Ben', 'ba', 'senior');
    const phase = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/phases`, { name: 'Full phase' }),
      201,
    );
    const card = await w.card({ title: 'Full phase card', specify: false });
    await ok(owner('PUT', `/api/cards/${card.id}/phase`, { phaseId: phase.id }));
    await seed(w, [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardFinalized',
          payload: {
            cardId: card.id,
            action: 'merge',
            resultRef: { mergeCommit: 'abc1234567' },
            toStage: 'done',
          },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' },
      },
    ]);
    await phasePass(w.t.app.ctx);
    await setLoad(1, 1);
    const from = r.received.length;
    await dispatcher().run();
    await r.barrier();
    expect(startsOf('ba_task', from)).toHaveLength(0);
    expect((await q(`SELECT status FROM ba_tasks WHERE phase_id=$1`, [phase.id]))[0]?.status).toBe('queued');
    await setLoad(0, 1);
    await dispatcher().run();
    await r.waitFor('shift.start', (f) => f.kind === 'ba_task', 5000, from);
  });
});
