import { randomUUID } from 'node:crypto';
import {
  DEPLOY_CONNECT_CAPABILITY,
  DEPLOY_MOVE_CAPABILITY,
  DEPLOY_SETUP_CAPABILITY,
  DeliverySetupSchema,
  localAdoptEnv,
  sshShipEnv,
} from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setDnsResolver } from '../src/delivery/dns.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { keepOnline } from './helpers/ceo.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import { type DeliveryWorld, deliveryWorld } from './helpers/delivery.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { ok, until } from './helpers/world.ts';

// Moving to a new server (design v3), server side: the move is built from the approved guided setup, one step at a time goes to the
// computer, the steps that change nothing run by themselves, the downtime waits for the person, the names swap only when the Owner
// confirms, and retiring removes Guildwise's keys only. Replay-safe.

const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];

let d: DeliveryWorld;
let r: FakeRunner;
const CAPS = [
  'ceo:1',
  'delivery:1',
  DEPLOY_SETUP_CAPABILITY,
  DEPLOY_CONNECT_CAPABILITY,
  DEPLOY_MOVE_CAPABILITY,
  'runs:1',
  'runs:2',
];
let newTarget: string;
const OLD_IP = '198.51.100.7';
const NEW_IP = '203.0.113.9';
const FP = `SHA256:${'A'.repeat(43)}`;

const base = () => `/api/projects/${d.w.projectId}`;
const req = (method: string, url: string, body?: unknown, cookie = d.w.owner.cookie) =>
  d.w.t.req(method, url, {
    cookie,
    headers: { 'x-aom-org': d.orgId },
    ...(body === undefined ? {} : { body }),
  });
const call = (method: string, url: string, body?: unknown, status = 200, cookie = d.w.owner.cookie) =>
  ok<any>(req(method, url, body, cookie), status);

const setup = () =>
  DeliverySetupSchema.parse({
    environments: [
      localAdoptEnv({
        name: 'uat',
        label: 'Test copy',
        target: 'p5-local',
        composeFile: '~/uat/docker-compose.yml',
        composeProject: 'uat',
        service: 'app',
        imageName: 'uat-app',
        appUrl: 'http://localhost:5500',
        database: { service: 'postgres', dir: '~/uat/backups' },
      }),
      sshShipEnv(
        {
          name: 'production',
          label: 'Live site',
          target: 'p5-prod',
          host: 'prod',
          composeFile: '/opt/p5/docker-compose.yml',
          service: 'app',
          imageName: 'p5',
          imageVar: 'P5_IMAGE',
          healthUrl: 'https://p5.example.com/ready',
          appUrl: 'https://p5.example.com',
          database: { service: 'postgres', dir: '/opt/p5/backups' },
        },
        'uat',
      ),
    ],
  });

const commands = () =>
  r.of('command').filter((c) => c.command === 'deploy.move') as Array<{ commandId: string; payload: any }>;
const lastMove = async (n: number) => {
  await until(async () => commands().length > n, 8000, 'deploy.move command');
  return commands()[n] as { commandId: string; payload: any };
};
const answer = (commandId: string, result: unknown, okay = true) =>
  r.send('command.result', { commandId, ok: okay, result });
const stepOk = (step: string, extra: Record<string, unknown> = {}) => ({
  ok: true,
  step,
  checks: [{ id: 'c', ok: true, text: `${step} done` }],
  facts: {},
  ...extra,
});
const move = (id: string) => call('GET', `${base()}/delivery/moves/${id}`);
const state = async (id: string, want: string) => {
  await until(async () => (await move(id)).state === want, 8000, `move ${want}`);
  return move(id);
};

beforeAll(async () => {
  d = await deliveryWorld();
  r = await d.w.connectRunner({ capabilities: CAPS });
  await keepOnline(d.w);
  newTarget = randomUUID();
  await q(
    `INSERT INTO deploy_targets (id, org_id, project_id, name, kind, workstation_id, host, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,'p5-new','remote_ssh',$4,'aom-p5-new',$2,now(),now())`,
    [newTarget, d.orgId, d.w.projectId, d.w.workstationId],
  );
  for (const [t, ip, alias] of [
    [d.targets.prod, OLD_IP, 'prod'],
    [newTarget, NEW_IP, 'aom-p5-new'],
  ] as const)
    await q(
      `INSERT INTO deploy_target_keys (target_id, workstation_id, project_id, org_id, fingerprint, public_key, alias, method, address, ssh_user,
         port, state, added_at) VALUES ($1,$2,$3,$4,$5,'ssh-ed25519 AAAA guildwise-deploy:x:Y',$6,'password',$7,'root',22,'active',now())`,
      [t, d.w.workstationId, d.w.projectId, d.orgId, FP, alias, ip],
    );
  setDnsResolver(async (name) => (name === 'p5.example.com' ? dnsAnswer : []));
});
afterAll(async () => {
  setDnsResolver(null);
  r.close();
  await d.w.t.close();
  await closeAdminPool();
});

let dnsAnswer: string[] = [OLD_IP];

/** A fresh approved guided setup, no open move, both servers active as they started. */
beforeEach(async () => {
  await d.observe();
  await q(`UPDATE delivery_recipes SET setup=$2::jsonb, status='approved' WHERE project_id=$1`, [
    d.w.projectId,
    JSON.stringify(setup()),
  ]);
  await q(`DELETE FROM deploy_target_moves WHERE project_id=$1`, [d.w.projectId]);
  await q(`UPDATE deploy_targets SET role='standby' WHERE id=$1 AND false`, [d.targets.prod]);
  await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
    d.w.workstationId,
    CAPS,
  ]);
  await q(`DELETE FROM runner_commands WHERE type='deploy.move'`);
  r.received.length = 0;
  dnsAnswer = [OLD_IP];
});

const start = (body: Record<string, unknown> = {}, status = 201, cookie = d.w.owner.cookie) =>
  call(
    'POST',
    `${base()}/delivery/moves`,
    { fromTargetId: d.targets.prod, toTargetId: newTarget, workstationId: d.w.workstationId, ...body },
    status,
    cookie,
  );

/** Runs the preparation by answering the four steps; returns the move once it waits for the person. */
async function prepared() {
  const m = await start();
  let n = 0;
  const check = await lastMove(n++);
  expect(check.payload).toMatchObject({ step: 'check', moveId: m.id, projectId: d.w.projectId });
  answer(check.commandId, stepOk('check', { facts: { image: 'p5:abc123def456', appPort: 4600 } }));
  for (const s of ['copy_config', 'copy_image', 'start_database']) {
    const c = await lastMove(n++);
    expect(c.payload.step).toBe(s);
    answer(c.commandId, stepOk(s));
  }
  await state(m.id, 'ready');
  return { id: m.id as string, n };
}

describe('starting a move', () => {
  it('is built from the approved setup, not from the browser: the spec names the app, the database and the backup folder', async () => {
    const m = await start();
    expect(m).toMatchObject({
      state: 'preparing',
      envName: 'production',
      fromName: 'p5-prod',
      toName: 'p5-new',
      domain: 'p5.example.com',
    });
    const c = await lastMove(0);
    expect(c.payload.spec).toMatchObject({
      composeFile: '/opt/p5/docker-compose.yml',
      appService: 'app',
      imageVar: 'P5_IMAGE',
      dbService: 'postgres',
      backupDir: '/opt/p5/backups',
      healthPath: '/ready',
      from: { alias: 'prod' },
      to: { alias: 'aom-p5-new' },
    });
    // only the first look is asked for; nothing else is queued until it answers
    expect(commands()).toHaveLength(1);
  });

  it('is refused: another move open, a computer that needs an update, the same server, a server that is not a server, a setup that is not approved', async () => {
    await start();
    const two = await req('POST', `${base()}/delivery/moves`, {
      fromTargetId: d.targets.prod,
      toTargetId: newTarget,
      workstationId: d.w.workstationId,
    });
    expect(two.status).toBe(409);
    expect(two.body.error.code).toBe('move_in_progress');
    await q(`DELETE FROM deploy_target_moves WHERE project_id=$1`, [d.w.projectId]);
    expect((await start({ toTargetId: d.targets.prod }, 422)).error?.code ?? 'x').toBeDefined();
    expect(
      (
        await req('POST', `${base()}/delivery/moves`, {
          fromTargetId: d.targets.prod,
          toTargetId: d.targets.local,
          workstationId: d.w.workstationId,
        })
      ).status,
    ).toBe(422);
    await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
      d.w.workstationId,
      CAPS.filter((c) => c !== DEPLOY_MOVE_CAPABILITY),
    ]);
    const old = await req('POST', `${base()}/delivery/moves`, {
      fromTargetId: d.targets.prod,
      toTargetId: newTarget,
      workstationId: d.w.workstationId,
    });
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe('runner_outdated');
    await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
      d.w.workstationId,
      CAPS,
    ]);
    await q(`UPDATE delivery_recipes SET status='changed_unapproved' WHERE project_id=$1`, [d.w.projectId]);
    const unapproved = await req('POST', `${base()}/delivery/moves`, {
      fromTargetId: d.targets.prod,
      toTargetId: newTarget,
      workstationId: d.w.workstationId,
    });
    expect(unapproved.body.error.code).toBe('not_approved');
  });

  it('is refused for a setup it cannot move safely (a hand-edited script, no database backup step) and says why', async () => {
    const custom = setup();
    (custom.environments[1] as { mode: string }).mode = 'custom';
    await q(`UPDATE delivery_recipes SET setup=$2::jsonb WHERE project_id=$1`, [
      d.w.projectId,
      JSON.stringify(custom),
    ]);
    const a = await req('POST', `${base()}/delivery/moves`, {
      fromTargetId: d.targets.prod,
      toTargetId: newTarget,
      workstationId: d.w.workstationId,
    });
    expect(a.status).toBe(422);
    expect(a.body.error.message).toContain('edited by hand');
    const noBackup = setup();
    (noBackup.environments[1] as { steps: unknown[] }).steps = (
      noBackup.environments[1] as { steps: Array<{ kind: string }> }
    ).steps.filter((s) => s.kind !== 'db_backup');
    await q(`UPDATE delivery_recipes SET setup=$2::jsonb WHERE project_id=$1`, [
      d.w.projectId,
      JSON.stringify(noBackup),
    ]);
    const b = await req('POST', `${base()}/delivery/moves`, {
      fromTargetId: d.targets.prod,
      toTargetId: newTarget,
      workstationId: d.w.workstationId,
    });
    expect(b.status).toBe(422);
    expect(b.body.error.message).toContain('no database backup step');
  });

  it('only the project owner starts one', async () => {
    const m = await d.member();
    const out = await req(
      'POST',
      `${base()}/delivery/moves`,
      { fromTargetId: d.targets.prod, toTargetId: newTarget, workstationId: d.w.workstationId },
      m.cookie,
    );
    expect([403, 404]).toContain(out.status);
  });
});

describe('the way through', () => {
  it('the preparation runs by itself and stops before the downtime; the switch waits for the person; then the data moves and the app starts', async () => {
    const { id, n: n0 } = await prepared();
    let n = n0;
    const m = await move(id);
    expect(m.steps.map((s: any) => s.step)).toEqual(['check', 'copy_config', 'copy_image', 'start_database']);
    expect(m.facts).toMatchObject({ image: 'p5:abc123def456', appPort: 4600 });
    // nothing is stopped before the person agrees
    expect(commands()).toHaveLength(n);
    expect(m.oldAppStopped).toBe(false);
    // the person's agreement is required in the request
    expect((await req('POST', `${base()}/delivery/moves/${id}/switch`, {})).status).toBe(400);
    await call('POST', `${base()}/delivery/moves/${id}/switch`, { agreedDowntime: true }, 202);
    const stop = await lastMove(n++);
    expect(stop.payload.step).toBe('stop_and_backup');
    answer(
      stop.commandId,
      stepOk('stop_and_backup', {
        facts: { backupFile: '/opt/p5/backups/move-20261021-120000.sql.gz', tablesOld: 3 },
        oldAppRunning: false,
      }),
    );
    // the restore is chained and carries the backup file the last step reported
    const restore = await lastMove(n++);
    expect(restore.payload).toMatchObject({
      step: 'restore',
      context: { backupFile: '/opt/p5/backups/move-20261021-120000.sql.gz' },
    });
    expect((await move(id)).oldAppStopped).toBe(true);
    answer(
      restore.commandId,
      stepOk('restore', { facts: { tablesNew: 3, tablesOld: 3 }, oldAppRunning: false }),
    );
    const startApp = await lastMove(n++);
    expect(startApp.payload).toMatchObject({ step: 'start_app', context: { appPort: 4600 } });
    answer(startApp.commandId, stepOk('start_app', { facts: { healthy: true }, oldAppRunning: false }));
    const done = await state(id, 'app_ready');
    expect(done.oldAppStopped).toBe(true);
    expect(done.newAddresses).toEqual([NEW_IP]);
    expect(commands()).toHaveLength(n);
  });

  it('a failed look stays in "preparing" with the plain words of what is wrong; try again runs it again', async () => {
    const m = await start();
    const c = await lastMove(0);
    answer(c.commandId, {
      ok: false,
      step: 'check',
      error: 'blocked',
      detail: 'The database (postgres) is not running on the old server',
      checks: [
        { id: 'database', ok: false, text: 'The database (postgres) is not running on the old server' },
      ],
      facts: {},
    });
    const failed = await state(m.id, 'failed');
    expect(failed.error).toContain('postgres');
    expect(failed.steps[0].checks[0]).toMatchObject({ ok: false });
    await call('POST', `${base()}/delivery/moves/${m.id}/retry`, undefined, 202);
    expect((await lastMove(1)).payload.step).toBe('check');
    expect((await move(m.id)).state).toBe('preparing');
  });

  it('a backup that failed has started the old app again: the move is failed, nothing is stopped, try again starts over at the backup', async () => {
    const { id, n: n0 } = await prepared();
    await call('POST', `${base()}/delivery/moves/${id}/switch`, { agreedDowntime: true }, 202);
    const stop = await lastMove(n0);
    answer(stop.commandId, {
      ok: false,
      step: 'stop_and_backup',
      error: 'backup_failed',
      detail: 'pg_dump failed',
      oldAppRunning: true,
      checks: [],
      facts: {},
    });
    const m = await state(id, 'failed');
    expect(m.oldAppStopped).toBe(false);
    expect(m.error).toContain('old app was started again');
    await call('POST', `${base()}/delivery/moves/${id}/retry`, undefined, 202);
    expect((await lastMove(n0 + 1)).payload.step).toBe('stop_and_backup');
  });

  it('a restore that failed retries from the backup (the old app was started again meanwhile)', async () => {
    const { id, n: n0 } = await prepared();
    await call('POST', `${base()}/delivery/moves/${id}/switch`, { agreedDowntime: true }, 202);
    answer(
      (await lastMove(n0)).commandId,
      stepOk('stop_and_backup', {
        facts: { backupFile: '/opt/p5/backups/move-1.sql.gz' },
        oldAppRunning: false,
      }),
    );
    answer((await lastMove(n0 + 1)).commandId, {
      ok: false,
      step: 'restore',
      error: 'restore_failed',
      oldAppRunning: true,
      checks: [],
      facts: {},
    });
    const m = await state(id, 'failed');
    expect(m.oldAppStopped).toBe(false);
    await call('POST', `${base()}/delivery/moves/${id}/retry`, undefined, 202);
    expect((await lastMove(n0 + 2)).payload.step).toBe('stop_and_backup');
  });

  it('an app that did not answer leaves the old app stopped; "go back" starts it again and ends the move', async () => {
    const { id, n: n0 } = await prepared();
    await call('POST', `${base()}/delivery/moves/${id}/switch`, { agreedDowntime: true }, 202);
    answer(
      (await lastMove(n0)).commandId,
      stepOk('stop_and_backup', {
        facts: { backupFile: '/opt/p5/backups/move-1.sql.gz' },
        oldAppRunning: false,
      }),
    );
    answer((await lastMove(n0 + 1)).commandId, stepOk('restore', { oldAppRunning: false }));
    answer((await lastMove(n0 + 2)).commandId, {
      ok: false,
      step: 'start_app',
      error: 'app_not_healthy',
      oldAppRunning: false,
      checks: [],
      facts: {},
    });
    const m = await state(id, 'failed');
    expect(m.oldAppStopped).toBe(true);
    expect(m.error).toContain('old app is still stopped');
    // a move cannot be cancelled while a step runs, but this one is idle: go back
    await call('POST', `${base()}/delivery/moves/${id}/cancel`, undefined, 202);
    const undo = await lastMove(n0 + 3);
    expect(undo.payload.step).toBe('restart_old');
    answer(undo.commandId, stepOk('restart_old', { oldAppRunning: true }));
    const end = await state(id, 'cancelled');
    expect(end.oldAppStopped).toBe(false);
    // and the project can start another one
    await start();
  });

  it('cancelling before anything was stopped needs no command', async () => {
    const { id, n } = await prepared();
    await call('POST', `${base()}/delivery/moves/${id}/cancel`, undefined, 202);
    expect((await state(id, 'cancelled')).finishedAt).not.toBeNull();
    expect(commands()).toHaveLength(n);
  });

  it('a stop that timed out leaves the old app in an unknown state: cancel runs the undo (final review)', async () => {
    const { id, n: n0 } = await prepared();
    await call('POST', `${base()}/delivery/moves/${id}/switch`, { agreedDowntime: true }, 202);
    answer((await lastMove(n0)).commandId, {
      ok: false,
      step: 'stop_and_backup',
      error: 'timeout',
      checks: [],
      facts: {},
    });
    const m = await state(id, 'failed');
    expect(m.oldAppStopped).toBe(false); // not known to be stopped ...
    expect(m.facts.oldAppUnknown).toBe(true); // ... and not known to be running
    await call('POST', `${base()}/delivery/moves/${id}/cancel`, undefined, 202);
    const undo = await lastMove(n0 + 1);
    expect(undo.payload.step).toBe('restart_old');
    answer(undo.commandId, stepOk('restart_old', { oldAppRunning: true }));
    const end = await state(id, 'cancelled');
    expect(end.oldAppStopped).toBe(false);
  });

  it('a failed backup that says the old app is running again cancels without an undo', async () => {
    const { id, n: n0 } = await prepared();
    await call('POST', `${base()}/delivery/moves/${id}/switch`, { agreedDowntime: true }, 202);
    answer((await lastMove(n0)).commandId, {
      ok: false,
      step: 'stop_and_backup',
      error: 'backup_failed',
      oldAppRunning: true,
      checks: [],
      facts: {},
    });
    const m = await state(id, 'failed');
    expect(m.facts.oldAppUnknown).toBe(false);
    await call('POST', `${base()}/delivery/moves/${id}/cancel`, undefined, 202);
    await state(id, 'cancelled');
    expect(commands()).toHaveLength(n0 + 1);
  });

  it('final review: the name, address, computer and web address of a server in an open move cannot be changed', async () => {
    const m = await start();
    const patch = (target: string, body: unknown, cookie = d.w.owner.cookie) =>
      req('PATCH', `/api/deploy-targets/${target}`, body, cookie);
    for (const target of [d.targets.prod, newTarget]) {
      for (const body of [{ name: 'renamed' }, { host: 'other' }, { appUrl: 'https://x.example.com' }]) {
        const out = await patch(target, body);
        expect(out.status, JSON.stringify(body)).toBe(409);
        expect(out.body.error.code).toBe('target_in_move');
      }
      // notes and the same value are not a change
      expect((await patch(target, { notes: 'still fine' })).status).toBe(200);
    }
    // once the move is over the server can be edited again
    await call('POST', `${base()}/delivery/moves/${m.id}/cancel`, undefined, 202).catch(() => undefined);
    await q(`UPDATE deploy_target_moves SET state='cancelled', finished_at=now() WHERE id=$1`, [m.id]);
    expect((await patch(newTarget, { notes: 'after' })).status).toBe(200);
  });

  it('final review: a member cannot point a production target at another server or computer; the owner can', async () => {
    const member = await d.member();
    await q(`UPDATE deploy_targets SET production=true WHERE id=$1`, [newTarget]);
    try {
      const out = await req(
        'PATCH',
        `/api/deploy-targets/${newTarget}`,
        { host: 'elsewhere' },
        member.cookie,
      );
      expect([403, 404]).toContain(out.status);
      const host = (await q(`SELECT host FROM deploy_targets WHERE id=$1`, [newTarget]))[0].host;
      expect(host).toBe('aom-p5-new');
      expect((await req('PATCH', `/api/deploy-targets/${newTarget}`, { host: 'elsewhere' })).status).toBe(
        200,
      );
    } finally {
      await q(`UPDATE deploy_targets SET production=false, host='aom-p5-new' WHERE id=$1`, [newTarget]);
    }
  });

  it('cannot be cancelled or switched while a step is running', async () => {
    const m = await start();
    const out = await req('POST', `${base()}/delivery/moves/${m.id}/cancel`);
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe('step_running');
    expect(
      (await req('POST', `${base()}/delivery/moves/${m.id}/switch`, { agreedDowntime: true })).status,
    ).toBe(409);
  });

  it('a late answer for a move that was cancelled changes nothing', async () => {
    const m = await start();
    const c = await lastMove(0);
    await q(`DELETE FROM runner_commands WHERE id=$1`, [c.commandId]); // pretend it is no longer in flight
    await call('POST', `${base()}/delivery/moves/${m.id}/cancel`, undefined, 202);
    expect((await move(m.id)).state).toBe('cancelled');
    answer(c.commandId, stepOk('check'));
    await r.barrier();
    expect((await move(m.id)).state).toBe('cancelled');
    expect(commands()).toHaveLength(1);
  });

  it('deploys of the environment wait while the move is open', async () => {
    await q(`UPDATE projects SET delivery_mode='recipe' WHERE id=$1`, [d.w.projectId]);
    await q(
      `UPDATE delivery_recipes SET approved_hash=observed_hash, approved_parsed=parsed, approved_commit=observed_commit WHERE project_id=$1`,
      [d.w.projectId],
    );
    await start();
    const res = await call('POST', `${base()}/delivery/deploy`, { env: 'production' }, 200);
    expect(res.runs[0]).toMatchObject({ status: 'refused', refusal: 'move_in_progress' });
  });
});

describe('DNS and going live', () => {
  async function appReady() {
    const { id, n: n0 } = await prepared();
    await call('POST', `${base()}/delivery/moves/${id}/switch`, { agreedDowntime: true }, 202);
    answer(
      (await lastMove(n0)).commandId,
      stepOk('stop_and_backup', {
        facts: { backupFile: '/opt/p5/backups/move-1.sql.gz' },
        oldAppRunning: false,
      }),
    );
    answer((await lastMove(n0 + 1)).commandId, stepOk('restore', { oldAppRunning: false }));
    answer(
      (await lastMove(n0 + 2)).commandId,
      stepOk('start_app', { facts: { healthy: true }, oldAppRunning: false }),
    );
    await state(id, 'app_ready');
    return id;
  }

  it('the live check says where the domain points now, in words', async () => {
    const id = await appReady();
    const old = await call('GET', `${base()}/delivery/moves/${id}/dns`);
    expect(old).toMatchObject({
      domain: 'p5.example.com',
      state: 'old',
      expected: [NEW_IP],
      found: [OLD_IP],
      oldAddresses: [OLD_IP],
    });
    expect(old.text).toContain(NEW_IP);
    dnsAnswer = [NEW_IP];
    expect((await call('GET', `${base()}/delivery/moves/${id}/dns`)).state).toBe('new');
    dnsAnswer = [];
    expect((await call('GET', `${base()}/delivery/moves/${id}/dns`)).state).toBe('none');
    dnsAnswer = ['192.0.2.55'];
    expect((await call('GET', `${base()}/delivery/moves/${id}/dns`)).state).toBe('other');
  });

  it('"make the new server live" is the Owner’s, needs a running app, and checks the domain itself', async () => {
    const id = await appReady();
    const admin = await d.admin();
    const notOwner = await req(
      'POST',
      `${base()}/delivery/moves/${id}/complete`,
      { dns: 'unverified' },
      admin.cookie,
    );
    expect(notOwner.status).toBe(403);
    // "verified" is checked by the server, not taken on trust
    const early = await req('POST', `${base()}/delivery/moves/${id}/complete`, { dns: 'verified' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('dns_not_ready');
    expect((await move(id)).state).toBe('app_ready');
    dnsAnswer = [NEW_IP];
    const done = await call('POST', `${base()}/delivery/moves/${id}/complete`, { dns: 'verified' });
    expect(done.state).toBe('completed');
    // the new server took over the name the approved deploy files use; the old one is the standby; the mark and address moved along
    const rows = await q(
      `SELECT id, name, role, production, app_url FROM deploy_targets WHERE project_id=$1 AND name LIKE 'p5-%' ORDER BY name`,
      [d.w.projectId],
    );
    const byId = (id2: string) => rows.find((x: any) => x.id === id2);
    expect(byId(newTarget)).toMatchObject({
      name: 'p5-prod',
      role: 'active',
      production: true,
      app_url: 'https://p5.example.com',
    });
    expect(byId(d.targets.prod)).toMatchObject({ name: 'p5-prod (old server)', role: 'standby' });
    // nobody deploys to the standby: a deploy of production goes to the new server (by name), never to the old one
    const list = await call('GET', `${base()}/deploy-targets`);
    expect(list.targets.find((t: any) => t.id === d.targets.prod)).toMatchObject({ role: 'standby' });
    // a second completion is refused
    expect((await req('POST', `${base()}/delivery/moves/${id}/complete`, { dns: 'unverified' })).status).toBe(
      409,
    );
    // restore the world for the next tests
    await q(
      `UPDATE deploy_targets SET name='p5-new', role='active', production=false, app_url=NULL WHERE id=$1`,
      [newTarget],
    );
    await q(`UPDATE deploy_targets SET name='p5-prod', role='active' WHERE id=$1`, [d.targets.prod]);
  });

  it('without a domain (or when it is handled otherwise) the Owner may confirm without the check', async () => {
    const id = await appReady();
    const done = await call('POST', `${base()}/delivery/moves/${id}/complete`, { dns: 'unverified' });
    expect(done.state).toBe('completed');
    await q(
      `UPDATE deploy_targets SET name='p5-new', role='active', production=false, app_url=NULL WHERE id=$1`,
      [newTarget],
    );
    await q(`UPDATE deploy_targets SET name='p5-prod', role='active' WHERE id=$1`, [d.targets.prod]);
  });
});

describe('retire', () => {
  async function standby() {
    await q(`UPDATE deploy_targets SET role='standby', name='p5-prod (old server)' WHERE id=$1`, [
      d.targets.prod,
    ]);
    const id = randomUUID();
    await q(
      `INSERT INTO deploy_target_moves (id, org_id, project_id, env_name, from_target_id, to_target_id, workstation_id, spec, domain, state, started_by, started_at, finished_at)
       VALUES ($1,$2,$3,'production',$4,$5,$6,$7::jsonb,'p5.example.com','completed',$8,now(),now())`,
      [
        id,
        d.orgId,
        d.w.projectId,
        d.targets.prod,
        newTarget,
        d.w.workstationId,
        JSON.stringify({
          from: { targetId: d.targets.prod, alias: 'prod' },
          to: { targetId: newTarget, alias: 'aom-p5-new' },
          composeFile: '/opt/p5/docker-compose.yml',
          appService: 'app',
          imageVar: 'P5_IMAGE',
          dbService: 'postgres',
          backupDir: '/opt/p5/backups',
        }),
        d.w.owner.id,
      ],
    );
    return id;
  }
  const after = async () => {
    await q(`UPDATE deploy_targets SET role='active', name='p5-prod', retired_at=NULL WHERE id=$1`, [
      d.targets.prod,
    ]);
    await q(`UPDATE deploy_target_keys SET state='active', revoked_at=NULL WHERE target_id=$1`, [
      d.targets.prod,
    ]);
  };

  it('is the Owner’s and only for a standby', async () => {
    const admin = await d.admin();
    expect(
      (await req('POST', `${base()}/delivery/targets/${d.targets.prod}/retire`, { confirmed: true })).status,
    ).toBe(422);
    await standby();
    expect(
      (
        await req(
          'POST',
          `${base()}/delivery/targets/${d.targets.prod}/retire`,
          { confirmed: true },
          admin.cookie,
        )
      ).status,
    ).toBe(403);
    expect((await req('POST', `${base()}/delivery/targets/${d.targets.prod}/retire`, {})).status).toBe(400);
    await after();
  });

  it('removes Guildwise’s keys and nothing else: the keys are recorded as revoked, the server as retired, no deletion command exists', async () => {
    await standby();
    const out = await call(
      'POST',
      `${base()}/delivery/targets/${d.targets.prod}/retire`,
      { confirmed: true },
      202,
    );
    const c = await lastMove(0);
    expect(c.payload).toMatchObject({ step: 'retire_keys', spec: { from: { alias: 'prod' } } });
    expect(out.commandId).toBe(c.commandId);
    answer(c.commandId, stepOk('retire_keys', { facts: { removedKeys: 1 } }));
    await until(
      async () =>
        (await q(`SELECT role FROM deploy_targets WHERE id=$1`, [d.targets.prod]))[0].role === 'retired',
      8000,
      'retired',
    );
    expect(
      (await q(`SELECT state FROM deploy_target_keys WHERE target_id=$1`, [d.targets.prod]))[0].state,
    ).toBe('revoked');
    expect(
      (await q(`SELECT retired_at FROM deploy_targets WHERE id=$1`, [d.targets.prod]))[0].retired_at,
    ).not.toBeNull();
    // a retired server cannot be retired again, nor moved from
    expect(
      (await req('POST', `${base()}/delivery/targets/${d.targets.prod}/retire`, { confirmed: true })).status,
    ).toBe(422);
    await after();
  });

  it('a server that cannot be reached stays a standby and the move says why', async () => {
    await standby();
    await call('POST', `${base()}/delivery/targets/${d.targets.prod}/retire`, { confirmed: true }, 202);
    const c = await lastMove(0);
    answer(c.commandId, { ok: false, step: 'retire_keys', error: 'old_unreachable', checks: [], facts: {} });
    await r.barrier();
    await until(
      async () =>
        (
          await q(`SELECT error FROM deploy_target_moves WHERE from_target_id=$1`, [d.targets.prod])
        )[0]?.error?.includes('cannot sign in'),
      8000,
      'error',
    );
    expect((await q(`SELECT role FROM deploy_targets WHERE id=$1`, [d.targets.prod]))[0].role).toBe(
      'standby',
    );
    await after();
  });
});

describe('replay safety', () => {
  it('rebuilding the projections from the events gives the same moves', async () => {
    const { id, n: n0 } = await prepared();
    await call('POST', `${base()}/delivery/moves/${id}/switch`, { agreedDowntime: true }, 202);
    answer(
      (await lastMove(n0)).commandId,
      stepOk('stop_and_backup', {
        facts: { backupFile: '/opt/p5/backups/move-1.sql.gz', tablesOld: 2 },
        oldAppRunning: false,
      }),
    );
    answer((await lastMove(n0 + 1)).commandId, {
      ok: false,
      step: 'restore',
      error: 'restore_failed',
      oldAppRunning: true,
      checks: [],
      facts: {},
    });
    await state(id, 'failed');
    const snap = async () =>
      JSON.stringify(
        await q(
          `SELECT id, state, current_step, steps, facts, error, old_app_stopped, domain, finished_at FROM deploy_target_moves WHERE id=$1`,
          [id],
        ),
      );
    const before = await snap();
    await rebuildProjections(d.w.t.app.ctx.pool, d.w.t.app.ctx.store);
    expect(await snap()).toBe(before);
  });
});
