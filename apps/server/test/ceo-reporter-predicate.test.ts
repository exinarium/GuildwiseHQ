import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appoint, keepOnline } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, type World } from './helpers/world.ts';

/**
 * The BA reporter and routing ask the same question (docs/design/ceo-front-door.md 2.4): the CEO owns the reporter's job
 * while it is active AND reachable. A CEO that cannot run (offline, no workstation yet) leaves the BA's alerts to the BA.
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

/** A card that keeps failing: the loop detector raises an urgent signal on the next sweep. */
const urgentSignal = async () => {
  await q(`DELETE FROM ba_tasks WHERE kind='floor_alert'`);
  await q(`DELETE FROM ba_signals`);
  const card = await w.card({ title: `Burning tokens ${randomUUID().slice(0, 4)}` });
  const scope = { orgId: w.owner.id, projectId: w.projectId, audience: 'project' as const };
  const SYSTEM = { kind: 'system' as const, id: null };
  const alertId = randomUUID();
  await seed(w, [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'CardRetryDeferred',
        payload: {
          cardId: card.id,
          until: new Date(w.t.clock.now().getTime() + 60_000).toISOString(),
          failures: 3,
          episodeId: randomUUID(),
          newEpisode: true,
        },
      },
      actor: SYSTEM,
      scope,
    },
    {
      streamId: streamId.desk(alertId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId: alertId,
          kind: 'alert',
          subkind: 'loop_backoff',
          title: `${card.ref} keeps failing`,
          cardId: card.id,
          projectId: w.projectId,
          askedBy: { kind: 'system' },
        },
      },
      actor: SYSTEM,
      scope,
    },
  ]);
};
const alerts = () => q(`SELECT * FROM ba_tasks WHERE kind='floor_alert'`);
const runReporter = () => w.t.app.ctx.services.reporter.run();

describe('who takes the urgent alerts', () => {
  it('a reachable CEO takes them: the BA gets no floor alert', async () => {
    await keepOnline(w);
    await urgentSignal();
    await runReporter();
    expect(await q(`SELECT 1 FROM ba_signals WHERE urgency='urgent' AND status='open'`)).toHaveLength(1);
    expect(await alerts()).toHaveLength(0);
  });

  it('a CEO that is offline leaves them to the BA, as routing does', async () => {
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    await urgentSignal();
    await runReporter();
    expect(await alerts()).toHaveLength(1);
  });

  it('a CEO with no workstation yet leaves them to the BA', async () => {
    await keepOnline(w);
    await q(`UPDATE agents SET workstation_id=NULL WHERE role_key='ceo'`);
    await urgentSignal();
    await runReporter();
    expect(await alerts()).toHaveLength(1);
  });
});
