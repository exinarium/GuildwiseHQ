import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appoint, keepOnline } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * docs/design/ceo-front-door.md step 3: desk routing has one reader, the CEO. A non-urgent item is held for the CEO's
 * triage while the CEO is active and reachable, and released unchanged at the deadline; with the CEO paused or its
 * workstation offline nothing is held. No BA task is queued, whatever the old `routeViaBa` setting says.
 */
let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  await w.hire('Ben', 'ba', 'senior');
  await appoint(w);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const SYSTEM = { kind: 'system' as const, id: null };
const scope = () => ({ orgId: w.owner.id, projectId: w.projectId, audience: 'project' as const });
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const deskIds = async () => ((await ok<any>(owner('GET', '/api/desk'))).items as any[]).map((i) => i.id);
const row = async (id: string) => (await q('SELECT * FROM desk_items WHERE id=$1', [id]))[0]!;

async function alert(title: string, over: Record<string, unknown> = {}) {
  const id = randomUUID();
  await seed(w, [
    {
      streamId: streamId.desk(id),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId: id,
          kind: 'alert',
          subkind: 'bug_reported',
          title,
          body: `${title} body`,
          projectId: w.projectId,
          askedBy: { kind: 'system' },
          ...over,
        },
      },
      actor: SYSTEM,
      scope: scope(),
    },
  ]);
  return id;
}

describe('held items go to the CEO', () => {
  it('a non-urgent alert is held and hidden, the CEO is woken, and no BA task exists', async () => {
    await keepOnline(w);
    const id = await alert('Flaky lint step');
    expect(await row(id)).toMatchObject({ triage: 'pending' });
    expect((await row(id)).triage_deadline).toBeTruthy();
    expect(await deskIds()).not.toContain(id);
    await until(
      async () => (await q(`SELECT 1 FROM ceo_wakes WHERE subject_id=$1`, [id])).length === 1,
      5000,
      'the CEO wake',
    );
    expect(await q(`SELECT 1 FROM ba_tasks`)).toHaveLength(0);
  });

  it('urgent items (pinned alerts, blocking ones, approvals, the loop breaker) are never held', async () => {
    await keepOnline(w);
    const pinned = await alert('Pinned thing', { pinned: true });
    const loop = await alert('Card keeps failing', { subkind: 'loop_backoff' });
    const approval = await alert('Approve a deploy', { kind: 'approval', subkind: 'devops' });
    for (const id of [pinned, loop, approval]) {
      expect((await row(id)).triage).toBe('none');
      expect(await deskIds()).toContain(id);
    }
    expect(await q(`SELECT 1 FROM ba_tasks`)).toHaveLength(0);
  });

  it('a hold the CEO does not resolve ends at the deadline: the sweep releases the item unchanged', async () => {
    await keepOnline(w);
    const id = await alert('Slow burn');
    expect(await deskIds()).not.toContain(id);
    w.t.clock.setOffset(11 * 60_000);
    await w.t.app.ctx.services.signals.run();
    expect(await deskIds()).toContain(id);
    expect(await row(id)).toMatchObject({ triage: 'released' });
    w.t.clock.setOffset(0);
  });

  it('with the CEO offline or paused nothing is held: the owner sees everything at once', async () => {
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    const offline = await alert('Raised while the CEO is offline');
    expect((await row(offline)).triage).toBe('none');
    expect(await deskIds()).toContain(offline);

    await keepOnline(w);
    await q(`UPDATE ceo_settings SET paused=true`);
    const paused = await alert('Raised while the CEO is paused');
    expect((await row(paused)).triage).toBe('none');
    expect(await deskIds()).toContain(paused);
    await q(`UPDATE ceo_settings SET paused=false`);
    expect(await q(`SELECT 1 FROM ba_tasks`)).toHaveLength(0);
  });

  it('the old routeViaBa setting does not matter: on or off, the CEO decides', async () => {
    await keepOnline(w);
    await seed(w, [
      {
        streamId: streamId.user(w.owner.id),
        event: { type: 'ReportingPrefsChanged', payload: { userId: w.owner.id, routeViaBa: false } },
        actor: SYSTEM,
        scope: scope(),
      },
    ]);
    const id = await alert('Held although routing was switched off long ago');
    expect(await row(id)).toMatchObject({ triage: 'pending' });
  });
});
