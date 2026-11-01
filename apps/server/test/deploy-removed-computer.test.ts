import { randomUUID } from 'node:crypto';
import { DEPLOY_CONNECT_CAPABILITY, DEPLOY_SETUP_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEPLOY_REMOVED_COMPUTERS_MIGRATION,
  migrateDeployRemovedComputers,
} from '../src/data-migrations/index.ts';
import { reachabilityTick } from '../src/delivery/reachability.ts';
import { requestDeployRun } from '../src/delivery/runs.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { keepOnline } from './helpers/ceo.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import {
  type DeliveryWorld,
  deliveryWorld,
  mergeLanded,
  parseFixture,
  setWeekday,
} from './helpers/delivery.ts';
import { markOnline, ok, pairWorkstation } from './helpers/world.ts';

/**
 * The computer that deploys a place was unpaired: the places that used it are marked (`DeployTargetComputerRemoved`), every
 * delivery path answers `deploying_computer_removed`, the Owner recovers by choosing another computer (PATCH
 * `workstationId`), a rebuild reproduces the state, and the one-time data migration marks places from before the mark existed.
 */
const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];
const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';
const CAPS = ['ceo:1', 'delivery:1', DEPLOY_SETUP_CAPABILITY, DEPLOY_CONNECT_CAPABILITY, 'runs:1', 'runs:2'];
let d: DeliveryWorld;
let doomed: string;
let fresh: string;
const ids: Record<string, string> = {};

async function computer(name: string): Promise<string> {
  const p = await pairWorkstation(d.w.t, d.w.owner, name);
  await markOnline(d.w.t, p.workstationId);
  await q(
    `INSERT INTO workstation_capabilities (workstation_id, capabilities, updated_at) VALUES ($1,$2::text[],now())
     ON CONFLICT (workstation_id) DO UPDATE SET capabilities=EXCLUDED.capabilities`,
    [p.workstationId, CAPS],
  );
  return p.workstationId;
}

beforeAll(async () => {
  d = await deliveryWorld({ vault: 'git' });
  await keepOnline(d.w);
  await setWeekday(d);
  await mergeLanded(d, COMMIT);
  const o = await d.observe(parseFixture(), { commit: '9999999aaaaaaa' });
  await ok(d.approve(o.hash));
  await ok(
    d.w.t.req('PUT', `/api/projects/${d.w.projectId}/delivery/mode`, {
      cookie: d.w.owner.cookie,
      body: { mode: 'recipe' },
    }),
  );
  doomed = await computer('Doomed');
  fresh = await computer('Fresh');
});
afterAll(async () => {
  await d.w.t.close();
  await closeAdminPool();
});

const base = () => `/api/projects/${d.w.projectId}`;
const req = (method: string, url: string, body?: unknown, cookie = d.w.owner.cookie) =>
  d.w.t.req(method, url, {
    cookie,
    headers: { 'x-aom-org': d.orgId },
    ...(body === undefined ? {} : { body }),
  });
const call = (method: string, url: string, body?: unknown, status = 200) =>
  ok<any>(req(method, url, body, d.w.owner.cookie), status);
const flagged = async (id: string) =>
  (await q('SELECT computer_removed_at FROM deploy_targets WHERE id=$1', [id]))[0]!.computer_removed_at !==
  null;
const place = async (id: string) =>
  (await call('GET', `${base()}/places`)).places.find((p: any) => p.id === id);
const MESSAGE = (name: string) =>
  `The computer that deploys ${name} was removed. Choose another computer for it.`;

describe('unpairing a computer that deploys places', () => {
  it('marks every live place on it (servers, computers, production) and cancels an open move', async () => {
    const mk = async (key: string, body: Record<string, unknown>) => {
      ids[key] = (await call('POST', `${base()}/deploy-targets`, { notes: '', ...body }, 201)).id;
    };
    await mk('srv', { name: 'srv', kind: 'remote_ssh', workstationId: doomed, host: 'srv-box' });
    await mk('live', {
      name: 'live',
      kind: 'remote_ssh',
      workstationId: doomed,
      host: 'live-box',
      production: true,
    });
    await mk('box', { name: 'box', kind: 'local_docker', workstationId: doomed });
    await mk('ok', { name: 'ok-server', kind: 'remote_ssh', workstationId: fresh, host: 'ok-box' });
    await mk('gone', { name: 'gone', kind: 'local_docker', workstationId: doomed });
    await call('DELETE', `/api/deploy-targets/${ids.gone}`, undefined, 204);
    ids.move = randomUUID();
    await q(
      `INSERT INTO deploy_target_moves (id, org_id, project_id, env_name, from_target_id, to_target_id, workstation_id, spec, state, started_by, started_at)
       VALUES ($1,$2,$3,'production',$4,$5,$6,'{}'::jsonb,'ready',$7,now())`,
      [ids.move, d.orgId, d.w.projectId, ids.srv, ids.live, doomed, d.w.owner.id],
    );

    // the impact list the Unpair dialog shows
    const impact = await call('GET', `/api/workstations/${doomed}/unlink-impact`);
    expect(impact.places.map((p: any) => p.placeName).sort()).toEqual(['box', 'live', 'srv']);
    expect(impact.places.find((p: any) => p.placeName === 'box')).toMatchObject({
      kind: 'computer',
      projectId: d.w.projectId,
    });
    expect(impact.places.find((p: any) => p.placeName === 'live').production).toBe(true);
    // somebody else's computer is not theirs to look at
    const other = await d.member();
    expect(
      (await req('GET', `/api/workstations/${doomed}/unlink-impact`, undefined, other.cookie)).status,
    ).toBe(404);

    await call('POST', `/api/workstations/${doomed}/unlink`);
    for (const k of ['srv', 'live', 'box']) expect(await flagged(ids[k]!)).toBe(true);
    expect(await flagged(ids.ok!)).toBe(false);
    // the place keeps its computer for the record; the open move is over
    expect(
      (await q('SELECT workstation_id FROM deploy_targets WHERE id=$1', [ids.srv]))[0].workstation_id,
    ).toBe(doomed);
    expect((await q('SELECT state FROM deploy_target_moves WHERE id=$1', [ids.move]))[0].state).toBe(
      'cancelled',
    );
    const places = (await call('GET', `${base()}/places`)).places;
    for (const k of ['srv', 'live', 'box'])
      expect(places.find((p: any) => p.id === ids[k]).computerRemoved).toBe(true);
    expect(places.find((p: any) => p.id === ids.ok).computerRemoved).toBe(false);
  });

  it('is part of the event log: a rebuild of the projections gives the same state', async () => {
    const snap = () =>
      q(
        `SELECT id, workstation_id, computer_removed_at IS NOT NULL AS removed FROM deploy_targets WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[ids.srv, ids.live, ids.box, ids.ok]],
      );
    const before = await snap();
    expect(before.filter((r) => r.removed)).toHaveLength(3);
    await rebuildProjections(d.w.t.app.ctx.pool, d.w.t.app.ctx.store);
    expect(await snap()).toEqual(before);
  });

  it('every delivery path says deploying_computer_removed (409), not workstation not found', async () => {
    const err = async (p: Promise<{ status: number; body: any }>) => {
      const r = await p;
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('deploying_computer_removed');
      return r.body.error.message as string;
    };
    expect(await err(req('POST', `${base()}/delivery/targets/${ids.srv}/check`))).toBe(MESSAGE('srv'));
    expect(
      await err(req('POST', `${base()}/delivery/probe`, { scope: 'ssh_target', targetId: ids.srv })),
    ).toBe(MESSAGE('srv'));
    expect(await err(req('POST', `${base()}/delivery/probe`, { scope: 'local', targetId: ids.box }))).toBe(
      MESSAGE('box'),
    );
    const sealed = { name: 'TEST_PASSWORD', keyId: 'k', ciphertext: 'c' };
    await err(req('PUT', `/api/workstations/${doomed}/target-secrets`, { targetId: ids.box, ...sealed }));
    await err(
      req('PUT', `/api/workstations/${doomed}/deploy-secrets`, { projectId: d.w.projectId, ...sealed }),
    );
    await err(
      req('POST', `/api/devops/requests`, {
        workstationId: doomed,
        summary: 'fix it',
        context: { projectId: d.w.projectId },
      }),
    );
    // an explicit computer the caller named keeps its plain 404
    const r = await req('POST', `${base()}/delivery/probe`, {
      scope: 'ssh_target',
      targetId: ids.srv,
      workstationId: doomed,
    });
    expect(r.status).toBe(404);
  });

  it('the reachability tick skips them', async () => {
    await q(
      `INSERT INTO deploy_target_keys (target_id, workstation_id, project_id, org_id, fingerprint, public_key, alias, method, state, added_at)
       VALUES ($1,$2,$3,$4,'SHA256:x','ssh-ed25519 AAAA','a','panel','active',now())`,
      [ids.srv, doomed, d.w.projectId, d.orgId],
    );
    await reachabilityTick(d.w.t.app.ctx);
    expect(
      await q(`SELECT 1 FROM runner_commands WHERE type='deploy.probe' AND payload->>'targetId'=$1`, [
        ids.srv,
      ]),
    ).toHaveLength(0);
  });

  it('a deploy to a place on a removed computer is refused with the same reason and message', async () => {
    // (the rebuild above forgot the targets the world made straight in the table: make this one again, with no mark)
    await q(`DELETE FROM deploy_targets WHERE id=$1`, [d.targets.local]);
    await q(
      `INSERT INTO deploy_targets (id, org_id, project_id, name, kind, workstation_id, app_url, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,'p5-local','local_docker',$4,'http://localhost:5500',$2,now(),now())`,
      [d.targets.local, d.orgId, d.w.projectId, doomed],
    );
    const res = await requestDeployRun(d.w.t.app.ctx, {
      projectId: d.w.projectId,
      env: 'local',
      commit: COMMIT,
      trigger: 'after_merge',
      requester: { kind: 'trigger', id: null, name: 'after_merge', provenance: 'trigger' },
    });
    expect(res.runs[0]).toMatchObject({ status: 'refused', refusal: 'deploying_computer_removed' });
    const [row] = await q(`SELECT refusal_detail FROM deploy_runs WHERE id=$1`, [res.runs[0]!.runId]);
    expect(row.refusal_detail).toBe(MESSAGE('p5-local'));
    // old data without the mark counts as removed too
    expect((await place(d.targets.local)).computerRemoved).toBe(true);
  });
});

describe('choosing another computer', () => {
  it('PATCH workstationId clears the mark for a server, a computer and a production place (project owner)', async () => {
    for (const k of ['srv', 'live', 'box']) {
      await call('PATCH', `/api/deploy-targets/${ids[k]}`, { workstationId: fresh });
      expect(await flagged(ids[k]!)).toBe(false);
      const p = await place(ids[k]!);
      expect(p).toMatchObject({ computerRemoved: false, workstationId: fresh });
    }
    // and the check works again (the cheap look is queued on the new computer)
    await call('POST', `${base()}/delivery/targets/${ids.srv}/check`, undefined, 202);
    const rows = await q(
      `SELECT workstation_id FROM runner_commands WHERE type='deploy.probe' AND payload->>'targetId'=$1`,
      [ids.srv],
    );
    expect(rows.at(-1)!.workstation_id).toBe(fresh);
  });

  it('a rebuild keeps the recovered state', async () => {
    await rebuildProjections(d.w.t.app.ctx.pool, d.w.t.app.ctx.store);
    for (const k of ['srv', 'live', 'box']) {
      const [row] = await q('SELECT workstation_id, computer_removed_at FROM deploy_targets WHERE id=$1', [
        ids[k],
      ]);
      expect(row.workstation_id).toBe(fresh);
      expect(row.computer_removed_at).toBeNull();
    }
  });

  it('a project member who is not the owner cannot repoint a production place', async () => {
    const member = await d.member();
    const r = await req('PATCH', `/api/deploy-targets/${ids.live}`, { workstationId: doomed }, member.cookie);
    expect(r.status).toBeGreaterThanOrEqual(403);
  });
});

describe('the one-time repair of existing data', () => {
  it('marks places whose computer is gone (unlinked or missing), skips healthy ones, and is idempotent', async () => {
    const stale = await computer('Stale');
    const mk = async (name: string, ws: string, kind = 'remote_ssh') =>
      (
        await call(
          'POST',
          `${base()}/deploy-targets`,
          {
            name,
            kind,
            workstationId: ws,
            notes: '',
            ...(kind === 'remote_ssh' ? { host: `${name}-box` } : {}),
          },
          201,
        )
      ).id as string;
    const a = await mk('old-server', stale);
    const b = await mk('old-computer', stale, 'local_docker');
    const healthy = await mk('still-fine', fresh);
    // the unpair of the old release: the status changed, nothing else
    await q(`UPDATE workstations SET status='unlinked', connected=false WHERE id=$1`, [stale]);
    expect(await flagged(a)).toBe(false);
    // still reported as removed, because its computer is not active
    expect((await place(a)).computerRemoved).toBe(true);

    const env = () => ({
      pool: d.w.t.app.ctx.pool,
      store: d.w.t.app.ctx.store,
      clock: d.w.t.app.ctx.clock,
      log: () => {},
    });
    await q('DELETE FROM data_migrations WHERE name=$1', [DEPLOY_REMOVED_COMPUTERS_MIGRATION]);
    const report = await migrateDeployRemovedComputers(env());
    expect(report).toMatchObject({ flagged: 2 });
    expect(await flagged(a)).toBe(true);
    expect(await flagged(b)).toBe(true);
    expect(await flagged(healthy)).toBe(false);
    // recorded once; a second run does nothing
    expect(await migrateDeployRemovedComputers(env())).toBeNull();
    // and even without the record it marks nothing twice
    await q('DELETE FROM data_migrations WHERE name=$1', [DEPLOY_REMOVED_COMPUTERS_MIGRATION]);
    expect(await migrateDeployRemovedComputers(env())).toMatchObject({ flagged: 0, movesCancelled: 0 });
    const n = await q(
      `SELECT count(*)::int AS n FROM events WHERE type='DeployTargetComputerRemoved' AND payload->>'targetId'=$1`,
      [a],
    );
    expect(n[0].n).toBe(1);
  });
});
