import {
  RELEASE_REF_CLEANUP_CAPABILITY,
  RELEASE_SHIP_CAPABILITY,
  type ReleaseFacts,
  ReleaseFactsSchema,
} from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileReleaseProposal } from '../src/release/reconcile.ts';
import { applyReleaseShipResult } from '../src/release/ship.ts';
import {
  RELEASE_SHIP_LOST_TEXT,
  RELEASE_SHIP_OFFLINE_SECONDS,
  RELEASE_SHIP_STUCK_GRACE_SECONDS,
  releaseShipStuckChecks,
} from '../src/release/ship-stuck.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, markOnline, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

type Rows = [any, ...any[]];
const HEAD = 'a'.repeat(40);
const file = (v: string) => `export const RUNNER_VERSION = '${v}';\n`;
const facts = (): ReleaseFacts =>
  ReleaseFactsSchema.parse({
    headSha: HEAD,
    ahead: 3,
    lastTag: { name: 'v1.3.0', sha: 'b'.repeat(40) },
    existingTags: ['v1.3.0'],
    changedTotal: 4,
    components: [
      { name: 'runner', changedCount: 17, contentAtHead: file('0.1.62'), contentAtTag: file('0.1.62') },
    ],
    changelog: '## [Unreleased]\n\n### Added\n\n- One.\n\n## [1.3.0] - 2026-10-20\n',
  });

const q2 = async (sql: string, params: unknown[] = []) => (await q(sql, params)) as Rows;
const proposal = async () =>
  (await q2(`SELECT * FROM release_proposals WHERE repo_id=$1 ORDER BY created_at DESC`, [w.repoId]))[0];
const shipItem = async () =>
  (await q2(`SELECT * FROM desk_items WHERE subkind='ship_release' AND data->>'repoId'=$1`, [w.repoId]))[0];
const commands = () => q2(`SELECT * FROM runner_commands WHERE type='release.ship' ORDER BY created_at`);
const ships = () => q2(`SELECT * FROM release_ships WHERE repo_id=$1`, [w.repoId]);
const eventCount = async (type: string) =>
  Number((await q2(`SELECT count(*)::int AS n FROM events WHERE type=$1`, [type]))[0].n);

async function capableWorkstation(capable = true) {
  await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
  await q(
    `INSERT INTO workstation_capabilities (workstation_id, capabilities, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (workstation_id) DO UPDATE SET capabilities=$2`,
    [w.workstationId, capable ? [RELEASE_SHIP_CAPABILITY] : []],
  );
}

async function proposeAndApprove(cookie = w.owner.cookie) {
  await q(
    `INSERT INTO repo_release_facts (project_repo_id, request_id, trigger, state, head_sha, facts, requested_at, updated_at)
     VALUES ($1, gen_random_uuid(), 'manual', 'ready', $2, $3::jsonb, now(), now())
     ON CONFLICT (project_repo_id) DO UPDATE SET state='ready', head_sha=$2, facts=$3::jsonb`,
    [w.repoId, HEAD, JSON.stringify(facts())],
  );
  await reconcileReleaseProposal(w.t.app.ctx, w.repoId, 'manual');
  const item = await shipItem();
  const res = await w.t.req('POST', `/api/desk/${item.id}/resolve`, {
    cookie,
    body: {
      resolution: 'approved',
      release: { version: '1.4.0', components: [{ name: 'runner', level: 'patch' }], factsHeadSha: HEAD },
    },
  });
  return { item, res };
}

beforeEach(async () => {
  await freshState();
  await q(`TRUNCATE release_proposals, release_ships, repo_release_facts`);
  await q(`TRUNCATE runner_commands CASCADE`);
  await q(`UPDATE project_repos SET component_rules=$2::jsonb WHERE id=$1`, [
    w.repoId,
    JSON.stringify([
      {
        name: 'runner',
        paths: ['apps/runner/**'],
        versionFile: 'apps/runner/src/version.ts',
        pattern: "RUNNER_VERSION = '(.*)'",
      },
    ]),
  ]);
  await capableWorkstation();
});

describe('release.ship on the server', () => {
  it('approval queues exactly one release.ship with the mapped payload and records ReleaseShipStarted', async () => {
    const started = await eventCount('ReleaseShipStarted');
    const { res } = await proposeAndApprove();
    expect(res.status).toBe(200);
    const cmds = await commands();
    expect(cmds).toHaveLength(1);
    const p = cmds[0].payload;
    expect(p).toMatchObject({
      version: '1.4.0',
      tag: 'v1.4.0',
      lastTag: 'v1.3.0',
      components: [{ name: 'runner', level: 'patch', approvedTo: '0.1.63' }],
    });
    expect(p.shipId).toBe((await proposal()).id);
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cmds[0].workstation_id).toBe(w.workstationId);
    expect(await eventCount('ReleaseShipStarted')).toBe(started + 1);
    expect((await ships())[0]).toMatchObject({ status: 'committing', version: '1.4.0' });
  });

  it('with no capable workstation the approval is refused and rolled back', async () => {
    await capableWorkstation(false);
    const approved = await eventCount('ReleaseApproved');
    const { res } = await proposeAndApprove();
    expect(res.status).toBe(409);
    expect((await proposal()).state).toBe('proposed');
    expect(await commands()).toHaveLength(0);
    expect(await ships()).toHaveLength(0);
    expect(await eventCount('ReleaseApproved')).toBe(approved);
    expect((await shipItem()).status).toBe('open');
  });

  it('a proposal that is not approved queues nothing', async () => {
    await q(
      `INSERT INTO repo_release_facts (project_repo_id, request_id, trigger, state, head_sha, facts, requested_at, updated_at)
       VALUES ($1, gen_random_uuid(), 'manual', 'ready', $2, $3::jsonb, now(), now())`,
      [w.repoId, HEAD, JSON.stringify(facts())],
    );
    await reconcileReleaseProposal(w.t.app.ctx, w.repoId, 'manual');
    expect(await commands()).toHaveLength(0);
  });

  it('a result from another workstation is ignored; a good result records the commit and a notice', async () => {
    await proposeAndApprove();
    const id = (await proposal()).id;
    const good = { ok: true, step: 'push', commit: 'c'.repeat(40), components: [], notices: [] };
    await applyReleaseShipResult(
      w.t.app.ctx,
      '00000000-0000-4000-8000-000000000000',
      { shipId: id },
      true,
      good,
      undefined,
    );
    expect((await ships())[0].status).toBe('committing');
    await applyReleaseShipResult(w.t.app.ctx, w.workstationId, { shipId: id }, true, good, undefined);
    expect((await ships())[0]).toMatchObject({ status: 'committed', commit_sha: 'c'.repeat(40) });
    expect(await q2(`SELECT * FROM desk_items WHERE subkind='release_committed'`)).toHaveLength(1);
    // the same answer twice changes nothing
    await applyReleaseShipResult(w.t.app.ctx, w.workstationId, { shipId: id }, true, good, undefined);
    expect(await q2(`SELECT * FROM desk_items WHERE subkind='release_committed'`)).toHaveLength(1);
  });

  it('a failed result puts a release_failed alert on the desk; Retry queues the stored payload again', async () => {
    await proposeAndApprove();
    const id = (await proposal()).id;
    const before = (await commands())[0].payload;
    await applyReleaseShipResult(
      w.t.app.ctx,
      w.workstationId,
      { shipId: id },
      true,
      { ok: false, step: 'push', error: 'remote: policy says no', components: [], notices: [] },
      undefined,
    );
    expect((await ships())[0]).toMatchObject({ status: 'failed', step: 'push' });
    const alert = (await q2(`SELECT * FROM desk_items WHERE subkind='release_failed'`))[0];
    expect(alert.body).toContain('policy says no');
    expect(alert.title).toContain('stopped at push');
    await ok(
      w.t.req('POST', `/api/desk/${alert.id}/resolve`, {
        cookie: w.owner.cookie,
        body: { resolution: 'approved' },
      }),
    );
    const cmds = await commands();
    expect(cmds).toHaveLength(2);
    expect(cmds[1].payload.shipId).toBe(before.shipId);
    expect(cmds[1].payload.date).toBe(before.date);
    expect((await ships())[0]).toMatchObject({ status: 'committing' });
    // Retry when nothing failed: refused
    const again = await w.t.req('POST', `/api/desk/${alert.id}/resolve`, {
      cookie: w.owner.cookie,
      body: { resolution: 'approved' },
    });
    expect(again.status).toBe(409);
    expect(await commands()).toHaveLength(2);
  });

  it('Dismiss on a stopped release closes the proposal so the repository can be proposed again', async () => {
    await proposeAndApprove();
    const id = (await proposal()).id;
    await applyReleaseShipResult(
      w.t.app.ctx,
      w.workstationId,
      { shipId: id },
      true,
      { ok: false, step: 'components', error: 'no version file', components: [], notices: [] },
      undefined,
    );
    const alert = (await q2(`SELECT * FROM desk_items WHERE subkind='release_failed'`))[0];
    await ok(w.t.req('POST', `/api/desk/${alert.id}/dismiss`, { cookie: w.owner.cookie, body: {} }));
    expect(await proposal()).toMatchObject({ state: 'dismissed', closed_reason: 'dismissed' });
    await reconcileReleaseProposal(w.t.app.ctx, w.repoId, 'manual');
    expect(
      await q2(`SELECT * FROM release_proposals WHERE repo_id=$1 AND state='proposed'`, [w.repoId]),
    ).toHaveLength(1);
  });
});

const failedAlerts = () => q2(`SELECT * FROM desk_items WHERE subkind='release_failed' ORDER BY created_at`);
const cleanups = () =>
  q2(`SELECT * FROM runner_commands WHERE type='release.ref_cleanup' ORDER BY created_at`);
const setCapabilities = (caps: string[]) =>
  q(`UPDATE workstation_capabilities SET capabilities=$2 WHERE workstation_id=$1`, [w.workstationId, caps]);
const retry = (alertId: string) =>
  w.t.req('POST', `/api/desk/${alertId}/resolve`, {
    cookie: w.owner.cookie,
    body: { resolution: 'approved' },
  });
const dismiss = (alertId: string) =>
  w.t.req('POST', `/api/desk/${alertId}/dismiss`, { cookie: w.owner.cookie, body: {} });
/** Moves the server clock past the stuck grace period, so the ship's last change is old enough. */
const pastGrace = () => w.t.clock.advance((RELEASE_SHIP_STUCK_GRACE_SECONDS + 60) * 1000);
const secondsAgo = (s: number) => new Date(w.t.clock.now().getTime() - s * 1000);

async function failAt(step: string) {
  await proposeAndApprove();
  const id = (await proposal()).id;
  await applyReleaseShipResult(
    w.t.app.ctx,
    w.workstationId,
    { shipId: id },
    true,
    { ok: false, step, error: 'it went wrong', components: [], notices: [] },
    undefined,
  );
  return { id, alert: (await failedAlerts())[0] };
}

describe('Retry guard (the proposal must still be approved)', () => {
  it('Retry on the alert of a dismissed release is refused and changes nothing', async () => {
    const { alert } = await failAt('push');
    await ok(dismiss(alert.id));
    expect((await proposal()).state).toBe('dismissed');
    const started = await eventCount('ReleaseShipStarted');
    const before = (await commands()).length;
    const res = await retry(alert.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('release_not_approved');
    expect(res.body.error.message).toContain('dismissed');
    expect(await commands()).toHaveLength(before);
    expect(await eventCount('ReleaseShipStarted')).toBe(started);
    expect((await ships())[0]).toMatchObject({ status: 'failed', step: 'push' });
    expect((await proposal()).state).toBe('dismissed');
  });

  it('Retry of a release whose proposal is no longer approved is refused, whatever the reason', async () => {
    const { id, alert } = await failAt('commit');
    await q(`UPDATE release_proposals SET state='closed' WHERE id=$1`, [id]);
    const res = await retry(alert.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('release_not_approved');
    expect(res.body.error.message).toContain('closed');
    expect(await commands()).toHaveLength(1);
  });
});

describe('a ship stuck in committing', () => {
  it('is left alone while its command is live; becomes a stopped release once it is not', async () => {
    await proposeAndApprove();
    const id = (await proposal()).id;
    await q(`UPDATE runner_commands SET status='sent', sent_at=$1 WHERE type='release.ship'`, [
      w.t.clock.now(),
    ]);
    pastGrace();
    await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
    // sent to a connected workstation: the runner is still working
    await releaseShipStuckChecks(w.t.app.ctx);
    expect(await failedAlerts()).toHaveLength(0);
    expect((await ships())[0].status).toBe('committing');
    // answered 30 s ago: the result may still be being applied
    await q(`UPDATE runner_commands SET status='done', done_at=$1 WHERE type='release.ship'`, [
      secondsAgo(30),
    ]);
    await releaseShipStuckChecks(w.t.app.ctx);
    expect(await failedAlerts()).toHaveLength(0);
    // answered long ago and the ship never moved on: stuck
    await q(`UPDATE runner_commands SET done_at=$1 WHERE type='release.ship'`, [
      secondsAgo(RELEASE_SHIP_STUCK_GRACE_SECONDS + 60),
    ]);
    await releaseShipStuckChecks(w.t.app.ctx);
    const alerts = await failedAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].options.map((o: { id: string }) => o.id)).toEqual(['retry', 'dismiss']);
    expect(alerts[0].body).toContain(RELEASE_SHIP_LOST_TEXT);
    expect(alerts[0].data).toMatchObject({ shipId: id, step: 'prepare' });
    expect((await ships())[0]).toMatchObject({ status: 'failed', step: 'prepare' });
    // a second pass adds nothing
    await releaseShipStuckChecks(w.t.app.ctx);
    expect(await failedAlerts()).toHaveLength(1);
  });

  it('a ship that only just started is not stuck, even without a command', async () => {
    await proposeAndApprove();
    await q(`DELETE FROM runner_commands WHERE type='release.ship'`);
    await releaseShipStuckChecks(w.t.app.ctx);
    expect(await failedAlerts()).toHaveLength(0);
    pastGrace();
    await releaseShipStuckChecks(w.t.app.ctx);
    expect(await failedAlerts()).toHaveLength(1);
  });

  it('a command on an unlinked workstation, or one offline too long, is not live; it is cancelled', async () => {
    await proposeAndApprove();
    pastGrace();
    await q(`UPDATE workstations SET status='unlinked' WHERE id=$1`, [w.workstationId]);
    await releaseShipStuckChecks(w.t.app.ctx);
    expect(await failedAlerts()).toHaveLength(1);
    expect((await commands())[0]).toMatchObject({ status: 'failed' });
    await q(`UPDATE workstations SET status='active' WHERE id=$1`, [w.workstationId]);
  });

  it('a pending command on a workstation offline for longer than the limit is not live', async () => {
    await proposeAndApprove();
    pastGrace();
    await q(`UPDATE workstations SET connected=false, last_seen_at=$2 WHERE id=$1`, [
      w.workstationId,
      secondsAgo(RELEASE_SHIP_OFFLINE_SECONDS - 120),
    ]);
    await releaseShipStuckChecks(w.t.app.ctx);
    expect(await failedAlerts()).toHaveLength(0);
    await q(`UPDATE workstations SET last_seen_at=$2 WHERE id=$1`, [
      w.workstationId,
      secondsAgo(RELEASE_SHIP_OFFLINE_SECONDS + 60),
    ]);
    await releaseShipStuckChecks(w.t.app.ctx);
    expect(await failedAlerts()).toHaveLength(1);
    expect((await commands())[0]).toMatchObject({ status: 'failed' });
  });

  it('a dismissed proposal is not swept', async () => {
    await proposeAndApprove();
    const id = (await proposal()).id;
    await q(`DELETE FROM runner_commands WHERE type='release.ship'`);
    await q(`UPDATE release_proposals SET state='dismissed' WHERE id=$1`, [id]);
    pastGrace();
    await releaseShipStuckChecks(w.t.app.ctx);
    expect(await failedAlerts()).toHaveLength(0);
  });

  it('Retry re-queues it on the ship workstation; an alreadyDone answer ends it committed', async () => {
    await proposeAndApprove();
    const id = (await proposal()).id;
    await q(`UPDATE runner_commands SET status='done', done_at=$1 WHERE type='release.ship'`, [
      w.t.clock.now(),
    ]);
    pastGrace();
    await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
    await releaseShipStuckChecks(w.t.app.ctx);
    const alert = (await failedAlerts())[0];
    await ok(retry(alert.id));
    const cmds = await commands();
    expect(cmds).toHaveLength(2);
    expect(cmds[1]).toMatchObject({ workstation_id: w.workstationId });
    expect(cmds[1].payload.shipId).toBe(id);
    expect((await ships())[0]).toMatchObject({ status: 'committing', workstation_id: w.workstationId });
    await applyReleaseShipResult(
      w.t.app.ctx,
      w.workstationId,
      { shipId: id },
      true,
      { ok: true, step: 'push', alreadyDone: true, commit: 'c'.repeat(40), components: [], notices: [] },
      undefined,
    );
    expect((await ships())[0]).toMatchObject({ status: 'committed', commit_sha: 'c'.repeat(40) });
    const done = await q2(`SELECT * FROM desk_items WHERE subkind='release_committed'`);
    expect(done).toHaveLength(1);
    expect(done[0].body).toContain('nothing new was committed');
  });

  it('Retry cancels a leftover command of the same ship, so only one is ever live', async () => {
    const { alert } = await failAt('push');
    await q(`UPDATE runner_commands SET status='pending' WHERE type='release.ship'`);
    await ok(retry(alert.id));
    const cmds = await commands();
    expect(cmds.map((c) => c.status)).toEqual(['failed', 'pending']);
  });

  it('Retry of a stuck ship whose proposal is no longer approved is refused', async () => {
    await proposeAndApprove();
    const id = (await proposal()).id;
    await q(`DELETE FROM runner_commands WHERE type='release.ship'`);
    pastGrace();
    await releaseShipStuckChecks(w.t.app.ctx);
    const alert = (await failedAlerts())[0];
    await q(`UPDATE release_proposals SET state='dismissed' WHERE id=$1`, [id]);
    const res = await retry(alert.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('release_not_approved');
    expect(await commands()).toHaveLength(0);
    expect((await ships())[0].status).toBe('failed');
  });
});

describe('Dismiss removes the kept release ref', () => {
  it('queues release.ref_cleanup to the capable workstation with the clone and returns at once', async () => {
    const { id, alert } = await failAt('push');
    await setCapabilities([RELEASE_SHIP_CAPABILITY, RELEASE_REF_CLEANUP_CAPABILITY]);
    const res = await dismiss(alert.id);
    expect(res.status).toBe(200);
    const c = await cleanups();
    expect(c).toHaveLength(1);
    expect(c[0].workstation_id).toBe(w.workstationId);
    expect(c[0].payload).toEqual({
      shipId: id,
      repoId: w.repoId,
      remoteUrlNormalized: (await ships())[0].payload.remoteUrlNormalized,
      version: '1.4.0',
    });
    expect((await proposal()).state).toBe('dismissed');
  });

  it('an offline workstation still gets it queued (delivered when it reconnects)', async () => {
    const { alert } = await failAt('commit');
    await setCapabilities([RELEASE_SHIP_CAPABILITY, RELEASE_REF_CLEANUP_CAPABILITY]);
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    await ok(dismiss(alert.id));
    const c = await cleanups();
    expect(c).toHaveLength(1);
    expect(c[0].status).toBe('pending');
  });

  it('a stuck ship that was dismissed gets the cleanup too', async () => {
    await proposeAndApprove();
    await q(`DELETE FROM runner_commands WHERE type='release.ship'`);
    pastGrace();
    await releaseShipStuckChecks(w.t.app.ctx);
    await setCapabilities([RELEASE_SHIP_CAPABILITY, RELEASE_REF_CLEANUP_CAPABILITY]);
    await ok(dismiss((await failedAlerts())[0].id));
    expect(await cleanups()).toHaveLength(1);
  });

  it('a runner without the capability gets nothing; Dismiss still closes the release', async () => {
    const { alert } = await failAt('push');
    await ok(dismiss(alert.id));
    expect(await cleanups()).toHaveLength(0);
    expect((await proposal()).state).toBe('dismissed');
  });

  it('nothing is queued after the commit was pushed (publish steps) or for a second Dismiss', async () => {
    const { alert } = await failAt('push');
    await setCapabilities([RELEASE_SHIP_CAPABILITY, RELEASE_REF_CLEANUP_CAPABILITY]);
    await q(`UPDATE release_ships SET step='land'`);
    await ok(dismiss(alert.id));
    expect(await cleanups()).toHaveLength(0);
  });
});
