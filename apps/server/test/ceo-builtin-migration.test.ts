import { startTraining } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ceoProvisionEvents } from '../src/ceo/provision.ts';
import { CEO_BUILTIN_MIGRATION, migrateCeoBuiltin } from '../src/data-migrations/ceo-builtin.ts';
import { DATA_MIGRATIONS } from '../src/data-migrations/index.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';

/** `ceo-builtin-2026-10`: every organization gets a CEO, a training CEO graduates, and a second run does nothing. */
let t: TestApp;
const env = () => ({
  pool: t.app.ctx.pool,
  store: t.app.ctx.store,
  clock: t.app.ctx.clock,
  log: () => {},
});
const liveCeos = (orgId: string) =>
  q(`SELECT * FROM agents WHERE org_id=$1 AND role_key='ceo' AND status <> 'retired'`, [orgId]);
const eventCount = async () => Number((await q('SELECT count(*) AS n FROM events'))[0]!.n);

/** A CEO as the appoint flow made it: in training, without the built-in flag. */
async function legacyCeo(orgId: string, ownerId: string) {
  const events = await ceoProvisionEvents(t.app.ctx.pool, t.app.ctx, orgId, ownerId);
  const hired = events[0]!.event.payload as Record<string, unknown>;
  delete hired.isBuiltin;
  (events[1]!.event.payload as Record<string, unknown>).training = startTraining(t.app.ctx.clock.now());
  await t.app.ctx.store.append(events);
}

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('ceo-builtin data migration', () => {
  it('is registered', () => {
    expect(DATA_MIGRATIONS.map((m) => m.name)).toContain(CEO_BUILTIN_MIGRATION);
  });

  it('gives an organization without a CEO one; leaves the one that has an active CEO alone; graduates a training CEO', async () => {
    const a = await t.createUser(uniqueEmail('plain'), 'member'); // an organization with no CEO
    const b = await t.createUser(uniqueEmail('training'), 'member'); // a CEO in training
    const c = await t.createUser(uniqueEmail('paused'), 'member'); // a graduated, paused CEO (the production shape)
    await legacyCeo(b, b);
    await legacyCeo(c, c);
    await t.app.ctx.store.append([
      {
        streamId: `ceo-${c}`,
        event: {
          type: 'CeoTrainingChanged',
          payload: {
            orgId: c,
            action: 'graduate',
            training: {
              on: false,
              startedAt: null,
              until: null,
              graduatedAt: new Date().toISOString(),
              extensions: 0,
            },
            by: c,
            scores: [],
          },
        },
        actor: { kind: 'user', id: c },
        scope: { orgId: c, projectId: null, audience: 'org' },
      },
      {
        streamId: `ceo-${c}`,
        event: { type: 'CeoPaused', payload: { orgId: c, by: c } },
        actor: { kind: 'user', id: c },
        scope: { orgId: c, projectId: null, audience: 'org' },
      },
    ] as never);
    const bBefore = (await liveCeos(b))[0]!.id;
    const cBefore = (await liveCeos(c))[0]!.id;
    const cEvents = await q(`SELECT count(*) AS n FROM events WHERE org_id=$1`, [c]);

    const report = await migrateCeoBuiltin(env());
    expect(report.provisioned).toContain(a);
    expect(report.graduated).toEqual(expect.arrayContaining([b]));
    expect(report.graduated).not.toContain(c);
    expect(report.provisioned).not.toContain(b);
    expect(report.provisioned).not.toContain(c);

    const ceoA = await liveCeos(a);
    expect(ceoA).toHaveLength(1);
    expect(ceoA[0]).toMatchObject({ is_builtin: true, workstation_id: null });
    expect((await q(`SELECT enabled, training FROM ceo_settings WHERE org_id=$1`, [a]))[0]).toMatchObject({
      enabled: true,
      training: { on: false },
    });

    // the training CEO is the same agent, now graduated
    expect((await liveCeos(b))[0]!.id).toBe(bBefore);
    expect((await q(`SELECT training FROM ceo_settings WHERE org_id=$1`, [b]))[0]!.training).toMatchObject({
      on: false,
    });
    expect(
      (
        await q(
          `SELECT payload FROM events WHERE type='CeoTrainingChanged' AND org_id=$1 ORDER BY seq DESC LIMIT 1`,
          [b],
        )
      )[0]!.payload,
    ).toMatchObject({ action: 'graduate', reason: 'built-in CEO, no training' });

    // the Owner is told once that the CEO graduated (one notice, not for the organizations that were not in training)
    const notices = await q(
      `SELECT org_id, kind, subkind, status FROM desk_items WHERE subkind='ceo_graduated'`,
    );
    expect(notices.filter((n) => n.org_id === b)).toEqual([
      { org_id: b, kind: 'alert', subkind: 'ceo_graduated', status: 'open' },
    ]);
    expect(notices.some((n) => n.org_id === a || n.org_id === c)).toBe(false);

    // production: an active (here paused) CEO is untouched: no event at all
    expect((await liveCeos(c))[0]!.id).toBe(cBefore);
    expect(Number((await q(`SELECT count(*) AS n FROM events WHERE org_id=$1`, [c]))[0]!.n)).toBe(
      Number(cEvents[0]!.n),
    );
    expect((await q(`SELECT paused FROM ceo_settings WHERE org_id=$1`, [c]))[0]!.paused).toBe(true);
  });

  it('is idempotent: a second run appends nothing', async () => {
    const before = await eventCount();
    const again = await migrateCeoBuiltin(env());
    expect(again).toEqual({ provisioned: [], graduated: [] });
    expect(await q(`SELECT 1 FROM desk_items WHERE subkind='ceo_graduated'`)).toHaveLength(1);
    expect(await eventCount()).toBe(before);
    expect(
      (await q(`SELECT count(*) AS n FROM data_migrations WHERE name=$1`, [CEO_BUILTIN_MIGRATION]))[0]!.n,
    ).toBe('1');
  });

  it('replaces a CEO the old Disable retired: the old agent stays retired with its history', async () => {
    const d = await t.createUser(uniqueEmail('disabled'), 'member');
    await legacyCeo(d, d);
    const old = (await liveCeos(d))[0]!.id;
    await t.app.ctx.store.append([
      {
        streamId: `agent-${old}`,
        event: { type: 'AgentRetired', payload: { agentId: old, by: d, releasedCardIds: [] } },
        actor: { kind: 'user', id: d },
        scope: { orgId: d, projectId: null, audience: 'org' },
      },
      {
        streamId: `ceo-${d}`,
        event: { type: 'CeoDisabled', payload: { orgId: d, agentId: old, by: d } },
        actor: { kind: 'user', id: d },
        scope: { orgId: d, projectId: null, audience: 'org' },
      },
    ] as never);
    expect(await liveCeos(d)).toHaveLength(0);
    const report = await migrateCeoBuiltin(env());
    expect(report.provisioned).toEqual([d]);
    const now = await liveCeos(d);
    expect(now).toHaveLength(1);
    expect(now[0]!.id).not.toBe(old);
    expect((await q(`SELECT status FROM agents WHERE id=$1`, [old]))[0]!.status).toBe('retired');
    expect((await q(`SELECT agent_id, enabled FROM ceo_settings WHERE org_id=$1`, [d]))[0]).toMatchObject({
      agent_id: now[0]!.id,
      enabled: true,
    });
  });

  it('binds the new CEO to the Owner’s workstation when he has one', async () => {
    const e = await t.createUser(uniqueEmail('hasws'), 'member');
    await t.app.ctx.pool.query(
      `INSERT INTO workstations (id, user_id, name, platform, hostname, runner_version, token_hash, status, paired_at, last_seen_at)
       VALUES (gen_random_uuid(), $1, 'Desk', 'linux', 'h', '0', $2, 'active', now(), now())`,
      [e, `hash-${e}`],
    );
    const ws = (await q(`SELECT id FROM workstations WHERE user_id=$1`, [e]))[0]!.id;
    await migrateCeoBuiltin(env());
    expect((await liveCeos(e))[0]!.workstation_id).toBe(ws);
  });
});

describe('ceo-builtin never blocks the boot (S5)', () => {
  it('one organization that throws is logged and skipped; the others are still migrated', async () => {
    const bad = await t.createUser(uniqueEmail('badorg'), 'member');
    const good = await t.createUser(uniqueEmail('goodorg'), 'member');
    await q(`DELETE FROM agents WHERE org_id=$1 AND role_key='ceo'`, [bad]).catch(() => undefined);
    await q(`DELETE FROM agents WHERE org_id=$1 AND role_key='ceo'`, [good]).catch(() => undefined);
    const logs: string[] = [];
    const store = t.app.ctx.store;
    const failing = Object.create(store, {
      append: {
        value: async (events: any[], opts: any) => {
          if (events.some((e) => e.scope?.orgId === bad)) throw new Error('boom for one org');
          return store.append(events, opts);
        },
      },
    });
    const report = await migrateCeoBuiltin({ ...env(), store: failing, log: (m) => logs.push(m) });
    expect(report.failed).toEqual([bad]);
    expect(report.provisioned).toContain(good);
    expect(report.provisioned).not.toContain(bad);
    expect(logs.join('\n')).toContain(`ERROR organization ${bad}`);
    expect(await liveCeos(good)).toHaveLength(1);
  });
});
