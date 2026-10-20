import { afterEach, describe, expect, it } from 'vitest';
import { ceoOwnerChangeEvents } from '../src/ceo/provision.ts';
import { uniqueEmail } from './helpers/app.ts';
import { Browser } from './helpers/browser.ts';
import { appoint, keepOnline } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * A former Owner's queued message must not replay with full power on the new Owner's machine (pre-production review S7):
 * the transfer drops the queued turns, and a turn re-checks that its author is the Owner when it starts.
 */
const FULL_POWER = ['ceo:1', 'ceo-full-power:1'];
const open: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of open.splice(0).reverse()) await c();
});

/** A world with a CEO whose runner is offline and one message queued for it. */
async function queuedWorld() {
  const w: World = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  open.push(async () => {
    await w.t.close();
    await closeAdminPool();
  });
  await appoint(w);
  const owner = (method: string, url: string, body?: unknown) =>
    w.t.req(method, url, { cookie: w.owner.cookie, body });
  const threadId = (await ok<any>(owner('POST', '/api/ceo/chat'))).threadId as string;
  const b = await Browser.open(w.baseUrl, w.owner.cookie);
  open.push(() => b.close());
  await b.hello();
  let r: FakeRunner | undefined;
  open.push(() => r?.close());
  r = await w.connectRunner({ capabilities: FULL_POWER });
  await keepOnline(w);
  r.close();
  await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'offline');
  b.send({ type: 'chat.send', threadId, body: 'do the risky thing', clientMsgId: 'm-1' });
  await b.until(() => b.of('chat.queued').length >= 1);
  const orgId = (
    await q(`SELECT id FROM organizations WHERE owner_user_id=$1 ORDER BY created_at LIMIT 1`, [w.owner.id])
  )[0]!.id as string;
  const turns = () => q(`SELECT id, status FROM ceo_turns WHERE thread_id=$1 ORDER BY queued_at`, [threadId]);
  const reconnect = async () => {
    r = await w.connectRunner({ capabilities: FULL_POWER });
    await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
      w.workstationId,
      FULL_POWER,
    ]);
    await r.barrier();
    return r;
  };
  return { w, orgId, turns, reconnect };
}

describe('a former Owner’s queued message', () => {
  it('is dropped when the organization changes owner, and never sent to the new Owner’s machine', async () => {
    const { w, orgId, turns, reconnect } = await queuedWorld();
    expect((await turns()).map((t) => t.status)).toEqual(['queued']);
    const next = await w.t.createUser(uniqueEmail('new-owner'), 'member');
    await w.t.addOrgMember(orgId, next, 'admin');
    await w.t.app.ctx.store.append([
      {
        streamId: `org-${orgId}`,
        event: {
          type: 'OrgOwnershipTransferred',
          payload: { orgId, fromUserId: w.owner.id, toUserId: next },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId, projectId: null, audience: 'org' },
      },
      ...(await ceoOwnerChangeEvents(w.t.app.ctx.pool, orgId, next)),
    ] as never);
    expect((await turns()).map((t) => t.status)).toEqual(['dropped']);
    const runner = await reconnect();
    expect(runner.received.filter((f: any) => f.type === 'chat.start')).toHaveLength(0);
  });

  it('is also dropped at turn start when its author is no longer the Owner (nothing dropped it at the transfer)', async () => {
    const { w, orgId, turns, reconnect } = await queuedWorld();
    const next = await w.t.createUser(uniqueEmail('new-owner'), 'member');
    await q(`UPDATE organizations SET owner_user_id=$2 WHERE id=$1`, [orgId, next]);
    const runner = await reconnect();
    await until(async () => (await turns()).every((t) => t.status === 'dropped'), 5000, 'dropped at start');
    expect(runner.received.filter((f: any) => f.type === 'chat.start')).toHaveLength(0);
  });
});
