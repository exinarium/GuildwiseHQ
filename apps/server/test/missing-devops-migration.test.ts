import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatMissingDevopsSummary,
  MISSING_DEVOPS_MIGRATION,
  migrateMissingDevops,
} from '../src/data-migrations/index.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import { pairWorkstation } from './helpers/world.ts';

/**
 * `missing-devops-2026-11` hires the DevOps engineers that a member lacks on the workstations serving an organization
 * (members added while the membership hook still failed for 2+ workstations). The test database is shared: every
 * assertion is on the organizations a test created, never on global totals.
 */
const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];
let t: TestApp;
let logs: string[] = [];
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const env = () => ({
  pool: t.app.ctx.pool,
  store: t.app.ctx.store,
  clock: t.app.ctx.clock,
  log: (m: string) => {
    logs.push(m);
  },
});
async function run() {
  logs = [];
  await q('DELETE FROM data_migrations WHERE name=$1', [MISSING_DEVOPS_MIGRATION]);
  return migrateMissingDevops(env());
}
const active = (org: string) =>
  q(`SELECT id, name, workstation_id FROM agents WHERE org_id=$1 AND is_devops AND status='active'`, [org]);
const hireEvents = (org: string) =>
  q(`SELECT payload, actor_kind FROM events WHERE type='AgentHired' AND payload->>'orgId'=$1`, [org]);

async function newOrg() {
  const owner = await t.userSession(uniqueEmail('own'));
  await pairWorkstation(t, owner, 'owner-box');
  const org = await t.createOrg(owner.id, 'Initech');
  return { owner, org };
}

/** Adds the member while the DevOps hire for `org` (optionally only for one user) fails: the pre-GWP-110 state. */
async function addBroken(org: string, userId: string) {
  let fail = true;
  t.app.ctx.store.intercept(async (_tx, batch) => {
    if (
      fail &&
      batch.some(
        (b) => b.event.type === 'AgentHired' && b.event.payload.isDevops && b.event.payload.orgId === org,
      )
    )
      throw new Error('seed failure');
    return batch;
  });
  await t.addOrgMember(org, userId, 'member');
  fail = false;
}

async function brokenMember(org: string, stations = 2) {
  const u = await t.userSession(uniqueEmail('m'));
  const ws: string[] = [];
  for (let i = 0; i < stations; i++) ws.push((await pairWorkstation(t, u, `box-${i}`)).workstationId);
  await addBroken(org, u.id);
  return { u, ws };
}

describe('missing DevOps engineers migration', () => {
  it('hires one engineer per serving workstation through the normal hire path', async () => {
    const { org } = await newOrg();
    const { u, ws } = await brokenMember(org);
    expect((await active(org)).filter((a) => ws.includes(a.workstation_id))).toHaveLength(0);
    const report = await run();
    expect(report?.byOrg[org]).toEqual({ pairs: 1, hired: 2, failed: 0, skipped: 0 });
    const mine = (await active(org)).filter((a) => ws.includes(a.workstation_id));
    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((a) => a.workstation_id)).size).toBe(2);
    const all = await active(org);
    expect(new Set(all.map((a) => a.name.toLowerCase())).size).toBe(all.length);
    const ev = (await hireEvents(org)).filter((e) => ws.includes(e.payload.workstationId));
    expect(ev).toHaveLength(2);
    for (const e of ev) {
      expect(e.payload.isDevops).toBe(true);
      expect(e.payload.hiredByUserId).toBe(u.id);
      expect(e.actor_kind).toBe('system');
    }
  });

  it('a second run hires nobody and appends no events', async () => {
    const { org } = await newOrg();
    await brokenMember(org);
    expect(await run()).not.toBeNull();
    expect(await run().then(() => 'again')).toBe('again');
    const before = (await hireEvents(org)).length;
    const row = await q('SELECT 1 FROM data_migrations WHERE name=$1', [MISSING_DEVOPS_MIGRATION]);
    if (row.length) expect(await migrateMissingDevops(env())).toBeNull();
    const report = await run();
    expect(report?.byOrg[org]).toBeUndefined();
    expect((await hireEvents(org)).length).toBe(before);
  });

  it('leaves complete, removed, unlinked and simulated cases alone', async () => {
    const { org } = await newOrg();
    // complete: engineers on every serving workstation already (normal add)
    const full = await t.userSession(uniqueEmail('full'));
    await pairWorkstation(t, full, 'a');
    await t.addOrgMember(org, full.id, 'member');
    // removed member with a missing engineer
    const gone = await brokenMember(org);
    await q(`UPDATE org_members SET status='removed' WHERE org_id=$1 AND user_id=$2`, [org, gone.u.id]);
    // member whose only missing workstation is unlinked
    const unl = await brokenMember(org, 1);
    await q(`UPDATE workstations SET status='unlinked' WHERE id=$1`, [unl.ws[0]]);
    // member whose workstation belongs to another (simulation) organization
    const sim = await brokenMember(org, 1);
    const simOrg = await t.createOrg(sim.u.id, 'Sim');
    await q(`UPDATE organizations SET simulation=true WHERE id=$1`, [simOrg]);
    await q(`UPDATE workstations SET simulation_org_id=$2 WHERE id=$1`, [sim.ws[0], simOrg]);
    const agentsBefore = await active(org);
    const eventsBefore = (await hireEvents(org)).length;
    const report = await run();
    expect(report?.byOrg[org]).toBeUndefined();
    expect(await active(org)).toEqual(agentsBefore);
    expect((await hireEvents(org)).length).toBe(eventsBefore);
  });

  it('repairs only the organization where the engineer is missing', async () => {
    const a = await newOrg();
    const b = await newOrg();
    const u = await t.userSession(uniqueEmail('two'));
    const ws = (await pairWorkstation(t, u, 'x')).workstationId;
    await t.addOrgMember(a.org, u.id, 'member'); // engineer for A hired normally
    await addBroken(b.org, u.id);
    const aBefore = await active(a.org);
    const report = await run();
    expect(report?.byOrg[b.org]).toEqual({ pairs: 1, hired: 1, failed: 0, skipped: 0 });
    expect(report?.byOrg[a.org]).toBeUndefined();
    expect(await active(a.org)).toEqual(aBefore);
    expect((await active(b.org)).some((x) => x.workstation_id === ws)).toBe(true);
  });

  it('logs a failing pair, repairs the others and does not throw', async () => {
    const { org } = await newOrg();
    const one = await brokenMember(org, 1);
    const two = await brokenMember(org, 1);
    let fail = true;
    t.app.ctx.store.intercept(async (_tx, batch) => {
      if (
        fail &&
        batch.some(
          (b) =>
            b.event.type === 'AgentHired' &&
            b.event.payload.isDevops &&
            b.event.payload.orgId === org &&
            b.event.payload.hiredByUserId === one.u.id,
        )
      )
        throw new Error('hire boom');
      return batch;
    });
    const report = await run();
    expect(report?.byOrg[org]).toEqual({ pairs: 2, hired: 1, failed: 1, skipped: 0 });
    expect(logs.some((l) => l.includes(one.u.id) && l.includes(org) && l.includes('hire boom'))).toBe(true);
    expect((await active(org)).some((a) => a.workstation_id === two.ws[0])).toBe(true);
    expect((await active(org)).some((a) => a.workstation_id === one.ws[0])).toBe(false);
    expect(await q('SELECT 1 FROM data_migrations WHERE name=$1', [MISSING_DEVOPS_MIGRATION])).toHaveLength(
      0,
    );
    fail = false;
    const again = await run();
    expect(again?.byOrg[org]).toEqual({ pairs: 1, hired: 1, failed: 0, skipped: 0 });
    expect((await active(org)).some((a) => a.workstation_id === one.ws[0])).toBe(true);
  });

  it('logs a summary with pairs found, hired and failed; an empty report reads zero', async () => {
    const { org } = await newOrg();
    await brokenMember(org);
    await run();
    expect(
      logs.some(
        (l) =>
          l.includes(MISSING_DEVOPS_MIGRATION) &&
          /\d+ pair\(s\) found, \d+ engineer\(s\) hired, \d+ failed/.test(l),
      ),
    ).toBe(true);
    expect(formatMissingDevopsSummary({ pairs: 0, hired: 0, failed: 0, skipped: 0 })).toBe(
      '0 pair(s) found, 0 engineer(s) hired, 0 failed, 0 skipped',
    );
  });
});
