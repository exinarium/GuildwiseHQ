import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hireDevopsForOrgIn } from '../src/commands/devops.ts';
import {
  migrateWorkstationOrgServing,
  WORKSTATION_ORG_SERVING_MIGRATION,
} from '../src/data-migrations/workstation-org-serving.ts';
import { withAppendTx } from '../src/db/tx.ts';
import { workstationForVault } from '../src/delivery/recipes.ts';
import { workstationServesOrg } from '../src/simulation/fit.ts';
import { ORIGIN, type TestApp, uniqueEmail } from './helpers/app.ts';
import { appoint } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { latestInviteToken, messagesTo } from './helpers/mailpit.ts';
import { createWorld, markOnline, ok, pairWorkstation, type World } from './helpers/world.ts';

/**
 * R9 (audit F4): moving an agent onto a member's workstation, and the automatic DevOps hire, need that member's consent.
 * A workstation works only for the organizations its user owns until they switch others on ("Works for", accept, or a
 * hire of their own); joining an organization never switches it on.
 */
let w: World;
let t: TestApp;
let orgId: string;
let root: { id: string; cookie: string };
let n = 0;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  t = w.t;
  root = await t.superAdminSession();
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]!.org_id;
  await markOnline(t, w.workstationId);
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const req = (cookie: string, method: string, url: string, body?: unknown) =>
  t.req(method as 'GET', url, { cookie, headers: { 'x-aom-org': orgId }, ...(body ? { body } : {}) });
const servingRow = async (ws: string, org: string) =>
  (
    await q('SELECT serving, set_by FROM workstation_org_serving WHERE workstation_id=$1 AND org_id=$2', [
      ws,
      org,
    ])
  )[0];
const servingEvents = (ws: string) =>
  q(`SELECT payload FROM events WHERE stream_id=$1 AND type='WorkstationOrgServingSet' ORDER BY seq`, [
    `workstation-${ws}`,
  ]);
const devopsOn = (ws: string, org: string) =>
  q(`SELECT id, name FROM agents WHERE workstation_id=$1 AND org_id=$2 AND is_devops AND status='active'`, [
    ws,
    org,
  ]);
const hire = () => w.hire(`Serving${++n}`, 'builder', 'junior');
const moveBody = (workstationId: string) => ({ workstationId, runtime: 'mock', model: 'mock' });

async function inviteMember(email: string, role: 'member' | 'admin' = 'member', projectIds: string[] = []) {
  // the invite mail goes out after the answer (R8): wait for this one, not an earlier invite to the same address
  const before = (await messagesTo(email)).length;
  await ok(req(w.owner.cookie, 'POST', '/api/org/invitations', { email, role, projectIds }), 201);
  return latestInviteToken(email, ORIGIN, before + 1);
}

/** A user with `boxes` paired workstations who then joins the world's organization (accept body as given). */
async function joiner(
  label: string,
  boxes: number,
  acceptBody: (ids: string[]) => Record<string, unknown>,
  projectIds: string[] = [],
) {
  const email = uniqueEmail(label);
  const u = await t.userSession(email);
  const ids: string[] = [];
  for (let i = 0; i < boxes; i++) {
    const p = await pairWorkstation(t, u, `${label}-${i}`);
    await markOnline(t, p.workstationId);
    ids.push(p.workstationId);
  }
  const token = await inviteMember(email, 'member', projectIds);
  await ok(
    t.req('POST', `/api/invitations/${token}/accept-existing`, { cookie: u.cookie, body: acceptBody(ids) }),
    201,
  );
  return { ...u, ids };
}

describe('F4: no move and no automatic DevOps hire without the member’s consent', () => {
  it('a member who joins keeps their workstation to themselves: no DevOps hire, the move is refused, no move target', async () => {
    const m = await joiner('f4', 1, () => ({}));
    const ws = m.ids[0]!;
    expect(await servingRow(ws, orgId)).toBeUndefined();
    expect(await devopsOn(ws, orgId)).toHaveLength(0);
    expect(await workstationServesOrg(t.app.ctx.pool, ws, orgId)).toBe(false);
    const a = await hire();
    const r = await req(w.owner.cookie, 'POST', `/api/agents/${a.id}/rehome`, moveBody(ws));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('workstation_not_serving');
    expect((await q('SELECT workstation_id FROM agents WHERE id=$1', [a.id]))[0]!.workstation_id).toBe(
      w.workstationId,
    );
    const targets = await ok<any>(req(w.owner.cookie, 'GET', `/api/agents/${a.id}/move-targets`));
    expect(targets.workstations.map((x: { id: string }) => x.id)).not.toContain(ws);
    // the membership hook (any later OrgMemberAdded path) does not hire on it either
    await withAppendTx(t.app.ctx.pool, (tx) => hireDevopsForOrgIn(t.app.ctx, tx, m.id, orgId));
    expect(await devopsOn(ws, orgId)).toHaveLength(0);
  });

  it('join as member, then pair: the new workstation serves only the member’s own organizations [rv 1]', async () => {
    const m = await joiner('rv1', 0, () => ({}));
    const p = await pairWorkstation(t, m, 'rv1-late');
    await markOnline(t, p.workstationId);
    expect(await servingRow(p.workstationId, orgId)).toBeUndefined();
    expect(await devopsOn(p.workstationId, orgId)).toHaveLength(0);
    // their own organization (org id = their user id) is served and has its DevOps engineer
    expect((await servingRow(p.workstationId, m.id))?.serving).toBe(true);
    expect(await devopsOn(p.workstationId, m.id)).toHaveLength(1);
    const a = await hire();
    const r = await req(w.owner.cookie, 'POST', `/api/agents/${a.id}/rehome`, moveBody(p.workstationId));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('workstation_not_serving');
  });
});

describe('pairing', () => {
  it('serves the organizations the user owns at pairing time, nothing else', async () => {
    const u = await t.userSession(uniqueEmail('pair'));
    const owned2 = await t.createOrg(u.id, 'Owned two');
    const memberOf = await t.createOrg(w.owner.id, 'Someone else’s');
    await t.addOrgMember(memberOf, u.id, 'admin');
    const p = await pairWorkstation(t, u, 'pair-box');
    const events = (await servingEvents(p.workstationId)).map((e) => e.payload);
    expect(events.map((e) => e.orgId).sort()).toEqual([u.id, owned2].sort());
    expect(events.every((e) => e.serving && e.reason === 'owner_org' && e.by === u.id)).toBe(true);
    expect(await servingRow(p.workstationId, memberOf)).toBeUndefined();
    expect(await devopsOn(p.workstationId, memberOf)).toHaveLength(0);
    expect(await devopsOn(p.workstationId, owned2)).toHaveLength(1);
  });
});

describe('accept opt-in', () => {
  it('a member invitation serves only the ticked workstations; they get the DevOps engineer and take moves', async () => {
    const m = await joiner('optin', 2, (ids) => ({ serveWorkstationIds: [ids[1]] }));
    const [off, on] = m.ids as [string, string];
    expect(await servingRow(off, orgId)).toBeUndefined();
    const row = await servingRow(on, orgId);
    expect(row).toMatchObject({ serving: true, set_by: m.id });
    expect((await servingEvents(on)).map((e) => e.payload).at(-1)).toMatchObject({ orgId, reason: 'accept' });
    expect(await devopsOn(on, orgId)).toHaveLength(1);
    expect(await devopsOn(off, orgId)).toHaveLength(0);
    const a = await hire();
    await ok(req(w.owner.cookie, 'POST', `/api/agents/${a.id}/rehome`, moveBody(on)));
    expect((await q('SELECT workstation_id FROM agents WHERE id=$1', [a.id]))[0]!.workstation_id).toBe(on);
  });

  it('refuses a workstation that is not the user’s own, and the invitation stays usable', async () => {
    const email = uniqueEmail('optbad');
    const u = await t.userSession(email);
    const token = await inviteMember(email);
    const bad = await t.req('POST', `/api/invitations/${token}/accept-existing`, {
      cookie: u.cookie,
      body: { serveWorkstationIds: [w.workstationId] },
    });
    expect(bad.status).toBe(404);
    expect(await q(`SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2`, [orgId, u.id])).toHaveLength(
      0,
    );
    await ok(t.req('POST', `/api/invitations/${token}/accept-existing`, { cookie: u.cookie, body: {} }), 201);
  });

  it('a new organization of your own is served by all your workstations unless you untick them', async () => {
    const email = uniqueEmail('neworg');
    const u = await t.userSession(email);
    const a = (await pairWorkstation(t, u, 'neworg-a')).workstationId;
    const b = (await pairWorkstation(t, u, 'neworg-b')).workstationId;
    await ok(
      t.req('POST', '/api/platform/invitations', {
        cookie: root.cookie,
        body: { email, proposedOrgName: 'Mine' },
      }),
      201,
    );
    const token = await latestInviteToken(email, ORIGIN);
    const me = await ok<any>(
      t.req('POST', `/api/invitations/${token}/accept-existing`, { cookie: u.cookie, body: {} }),
      201,
    );
    const newOrg = me.activeOrg.id as string;
    expect((await servingRow(a, newOrg))?.serving).toBe(true);
    expect((await servingRow(b, newOrg))?.serving).toBe(true);
    // its CEO lives on one of them (placed after serving was set)
    const ceo = (
      await q(`SELECT workstation_id FROM agents WHERE org_id=$1 AND role_key='ceo'`, [newOrg])
    )[0];
    expect([a, b]).toContain(ceo?.workstation_id);
    // unticked: none
    await ok(
      t.req('POST', '/api/platform/invitations', {
        cookie: root.cookie,
        body: { email, proposedOrgName: 'Other' },
      }),
      201,
    );
    const token2 = await latestInviteToken(email, ORIGIN, 2);
    const me2 = await ok<any>(
      t.req('POST', `/api/invitations/${token2}/accept-existing`, {
        cookie: u.cookie,
        body: { serveWorkstationIds: [] },
      }),
      201,
    );
    expect(await servingRow(a, me2.activeOrg.id)).toBeUndefined();
    expect(await servingRow(b, me2.activeOrg.id)).toBeUndefined();
  });
});

describe('a hire onto your own workstation is the consent [rv 8]', () => {
  it('turns serving on for that organization in the same transaction, with its DevOps engineer', async () => {
    const m = await joiner('selfhire', 1, () => ({}), [w.projectId]);
    const ws = m.ids[0]!;
    expect(await servingRow(ws, orgId)).toBeUndefined();
    const a = await ok<any>(
      req(m.cookie, 'POST', '/api/agents', {
        name: `Selfie${++n}`,
        roleKey: 'builder',
        seniority: 'junior',
        workstationId: ws,
        projectId: w.projectId,
        runtime: 'mock',
        model: 'mock',
      }),
      201,
    );
    expect((await servingRow(ws, orgId))?.serving).toBe(true);
    const ev = (await servingEvents(ws)).map((e) => e.payload).at(-1);
    expect(ev).toMatchObject({ orgId, serving: true, reason: 'hire', by: m.id });
    expect(await devopsOn(ws, orgId)).toHaveLength(1);
    // both in the same append: consecutive sequence numbers, nothing in between
    const seqs = await q(
      `SELECT seq::int AS seq FROM events
        WHERE (stream_id=$1 AND type='WorkstationOrgServingSet' AND payload->>'orgId' = $3) OR (stream_id=$2 AND type='AgentHired')
        ORDER BY seq`,
      [`workstation-${ws}`, `agent-${a.id}`, orgId],
    );
    expect(seqs).toHaveLength(2);
    expect(seqs[1]!.seq - seqs[0]!.seq).toBeLessThanOrEqual(3); // serving, the DevOps hire, the agent
  });

  it('a hire that fails switches nothing on', async () => {
    const m = await joiner('hirefail', 1, () => ({}), [w.projectId]);
    const ws = m.ids[0]!;
    const r = await req(m.cookie, 'POST', '/api/agents', {
      name: `Bad${++n}`,
      roleKey: 'no-such-role',
      seniority: 'junior',
      workstationId: ws,
      projectId: w.projectId,
      runtime: 'mock',
      model: 'mock',
    });
    expect(r.status).toBe(400);
    expect(await servingRow(ws, orgId)).toBeUndefined();
  });
});

describe('"Works for"', () => {
  it('lists the organizations per workstation; the owner switches one on, then off', async () => {
    const m = await joiner('worksfor', 1, () => ({}));
    const ws = m.ids[0]!;
    const list = await ok<any>(t.req('GET', '/api/workstations/serving', { cookie: m.cookie }));
    const entry = list.workstations.find((x: { workstationId: string }) => x.workstationId === ws);
    expect(entry.orgs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orgId, role: 'member', serving: false }),
        expect.objectContaining({ orgId: m.id, role: 'owner', serving: true }),
      ]),
    );
    // only the workstation's owner
    const foreign = await t.req('PUT', `/api/workstations/${ws}/orgs/${orgId}`, {
      cookie: w.owner.cookie,
      body: { serving: true },
    });
    expect(foreign.status).toBe(404);
    expect(await servingRow(ws, orgId)).toBeUndefined();

    await ok(
      t.req('PUT', `/api/workstations/${ws}/orgs/${orgId}`, { cookie: m.cookie, body: { serving: true } }),
    );
    expect((await servingRow(ws, orgId))?.serving).toBe(true);
    expect(await devopsOn(ws, orgId)).toHaveLength(1);
    const a = await hire();
    await ok(req(w.owner.cookie, 'POST', `/api/agents/${a.id}/rehome`, moveBody(ws)));

    // off while that organization has a running shift there: 409, nothing changes
    const shiftId = randomUUID();
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at)
       VALUES ($1,$2,$3,$4,'chat','running','mock','mock',now())`,
      [shiftId, orgId, a.id, ws],
    );
    const busy = await t.req('PUT', `/api/workstations/${ws}/orgs/${orgId}`, {
      cookie: m.cookie,
      body: { serving: false },
    });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('org_shift_running');
    await q(`UPDATE shifts SET status='ended', ended_at=now() WHERE id=$1`, [shiftId]);

    // off: its agents there need a new home, its DevOps engineer is retired, the organization cannot move agents back
    const devops = (await devopsOn(ws, orgId))[0]!;
    await ok(
      t.req('PUT', `/api/workstations/${ws}/orgs/${orgId}`, { cookie: m.cookie, body: { serving: false } }),
    );
    expect((await servingRow(ws, orgId))?.serving).toBe(false);
    expect((await q('SELECT status, workstation_id FROM agents WHERE id=$1', [a.id]))[0]).toEqual({
      status: 'needs_rehome',
      workstation_id: null,
    });
    const retired = (await q('SELECT status FROM agents WHERE id=$1', [devops.id]))[0]!;
    expect(retired.status).toBe('retired');
    const why = await q(`SELECT payload FROM events WHERE stream_id=$1 AND type='AgentRetired'`, [
      `agent-${devops.id}`,
    ]);
    expect(why[0]!.payload.reason).toBe('serving_off');
    const back = await req(w.owner.cookie, 'POST', `/api/agents/${a.id}/rehome`, moveBody(ws));
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe('workstation_not_serving');
    // the owner's own organization on that workstation is untouched
    expect((await servingRow(ws, m.id))?.serving).toBe(true);
  });

  it('cannot switch on an organization the user has no access to', async () => {
    const u = await t.userSession(uniqueEmail('stranger'));
    const ws = (await pairWorkstation(t, u, 'stranger-box')).workstationId;
    const r = await t.req('PUT', `/api/workstations/${ws}/orgs/${orgId}`, {
      cookie: u.cookie,
      body: { serving: true },
    });
    expect(r.status).toBe(404);
    expect(await servingRow(ws, orgId)).toBeUndefined();
  });
});

describe('the predicate', () => {
  it('a simulated workstation keeps its own rule without a serving row; a real one never serves a simulation', async () => {
    const sim = await t.createOrg(w.owner.id, 'Sim org');
    await q('UPDATE organizations SET simulation=true WHERE id=$1', [sim]);
    const id = randomUUID();
    await q(
      `INSERT INTO workstations (id, user_id, name, platform, hostname, runner_version, token_hash, status, paired_at, simulation_org_id)
       VALUES ($1, $2, 'Sim', 'linux', 'sim', '0', $3, 'active', now(), $4)`,
      [id, w.owner.id, `hash-${id}`, sim],
    );
    expect(await workstationServesOrg(t.app.ctx.pool, id, sim)).toBe(true);
    expect(await workstationServesOrg(t.app.ctx.pool, id, orgId)).toBe(false);
    await q(
      `INSERT INTO workstation_org_serving (workstation_id, org_id, serving, set_at) VALUES ($1,$2,true,now())`,
      [w.workstationId, sim],
    );
    expect(await workstationServesOrg(t.app.ctx.pool, w.workstationId, sim)).toBe(false);
    expect(await workstationServesOrg(t.app.ctx.pool, w.workstationId, orgId)).toBe(true);
  });
});

describe('the data migration', () => {
  it('switches on owned pairs and pairs where a non-DevOps agent already sits; every other pair stays off', async () => {
    // A pre-1.10.0 picture: the old member join hired DevOps everywhere and agents were moved without asking.
    const placed = await t.userSession(uniqueEmail('mig-placed'));
    const devonly = await t.userSession(uniqueEmail('mig-devonly'));
    await t.addOrgMember(orgId, placed.id, 'member');
    await t.addOrgMember(orgId, devonly.id, 'member');
    const wsPlaced = (await pairWorkstation(t, placed, 'mig-placed')).workstationId;
    const wsDev = (await pairWorkstation(t, devonly, 'mig-dev')).workstationId;
    const a = await hire();
    await q('UPDATE agents SET workstation_id=$2 WHERE id=$1', [a.id, wsPlaced]);
    // the automatic DevOps hire of the old member join (a plain hired agent flagged as DevOps is enough here)
    const d = await hire();
    await q('UPDATE agents SET workstation_id=$2, is_devops=true WHERE id=$1', [d.id, wsDev]);
    // wipe the serving rows as they were before 1.10.0 and run the migration again
    await q('DELETE FROM workstation_org_serving WHERE workstation_id = ANY($1::uuid[])', [
      [w.workstationId, wsPlaced, wsDev],
    ]);
    await q('DELETE FROM data_migrations WHERE name=$1', [WORKSTATION_ORG_SERVING_MIGRATION]);
    const env = {
      pool: t.app.ctx.pool,
      store: t.app.ctx.store,
      clock: t.app.ctx.clock,
      log: () => undefined,
    };
    const report = await migrateWorkstationOrgServing(env);
    expect(report).not.toBeNull();
    expect((await servingRow(w.workstationId, orgId))?.serving).toBe(true); // the owner's
    expect((await servingRow(wsPlaced, orgId))?.serving).toBe(true); // an agent was placed there
    expect((await servingRow(wsPlaced, placed.id))?.serving).toBe(true); // their own organization
    expect(await servingRow(wsDev, orgId)).toBeUndefined(); // only the automatic DevOps hire: stays off
    expect((await servingEvents(wsPlaced)).map((e) => e.payload).filter((p) => p.orgId === orgId)).toEqual([
      { workstationId: wsPlaced, orgId, serving: true, by: null, reason: 'existing' },
    ]);
    // idempotent: done once, and a forced second run adds nothing
    expect(await migrateWorkstationOrgServing(env)).toBeNull();
    await q('DELETE FROM data_migrations WHERE name=$1', [WORKSTATION_ORG_SERVING_MIGRATION]);
    const before = (
      await q(`SELECT count(*)::int AS n FROM events WHERE type='WorkstationOrgServingSet'`)
    )[0]!.n;
    await migrateWorkstationOrgServing(env);
    expect(
      (await q(`SELECT count(*)::int AS n FROM events WHERE type='WorkstationOrgServingSet'`))[0]!.n,
    ).toBe(before);
  });
});

describe('review rework: every path that puts work on a machine needs the consent', () => {
  it('B1: an Admin’s branch run on a member’s workstation that does not serve the organization is refused', async () => {
    const m = await joiner('run', 1, () => ({}), [w.projectId]);
    const r = await req(w.owner.cookie, 'POST', '/api/runs', {
      projectId: w.projectId,
      workstationId: m.ids[0],
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('workstation_not_serving');
    expect(
      await q('SELECT 1 FROM run_environments WHERE workstation_id=$1', [m.ids[0]]).catch(() => []),
    ).toHaveLength(0);
  });

  it('B1: deploys, setup writes and recipe inspection never pick a project member’s workstation that does not serve', async () => {
    const m = await joiner('vault', 1, () => ({}), [w.projectId]);
    const ws = m.ids[0]!;
    // the member's machine is the only connected one, the owner's is offline
    await q('UPDATE workstations SET connected=false WHERE id=$1', [w.workstationId]);
    await q('UPDATE workstations SET connected=true, last_seen_at=now() WHERE id=$1', [ws]);
    const vault = {
      vaultId: randomUUID(),
      orgId,
      storage: 'git',
      workstationId: null,
      name: 'v',
      folder: 'f',
    };
    try {
      // even as the most recently seen connected machine of the audience, it is skipped while it does not serve
      await q(`UPDATE workstations SET last_seen_at = now() + interval '1 day' WHERE id=$1`, [ws]);
      expect(await workstationForVault(t.app.ctx.pool, w.projectId, vault as never, orgId)).not.toBe(ws);
      await ok(
        t.req('PUT', `/api/workstations/${ws}/orgs/${orgId}`, { cookie: m.cookie, body: { serving: true } }),
      );
      expect(await workstationForVault(t.app.ctx.pool, w.projectId, vault as never, orgId)).toBe(ws);
    } finally {
      await markOnline(t, w.workstationId);
    }
  });

  it('B1: the CEO is not moved onto the Owner’s own workstation that does not serve the organization', async () => {
    await appoint(w);
    const spare = (await pairWorkstation(t, w.owner, 'ceo-spare')).workstationId;
    await ok(
      t.req('PUT', `/api/workstations/${spare}/orgs/${orgId}`, {
        cookie: w.owner.cookie,
        body: { serving: false },
      }),
    );
    const r = await req(w.owner.cookie, 'POST', '/api/ceo/workstation', { workstationId: spare });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('workstation_not_serving');
  });

  it('switching off re-homes the organization’s open cards whose work was on that workstation', async () => {
    const m = await joiner('cards', 1, () => ({}), [w.projectId]);
    const ws = m.ids[0]!;
    await ok(
      t.req('PUT', `/api/workstations/${ws}/orgs/${orgId}`, { cookie: m.cookie, body: { serving: true } }),
    );
    const card = await w.card();
    await q('UPDATE cards SET home_workstation_id=$2 WHERE id=$1', [card.id, ws]);
    await ok(
      t.req('PUT', `/api/workstations/${ws}/orgs/${orgId}`, { cookie: m.cookie, body: { serving: false } }),
    );
    expect(
      (await q('SELECT home_workstation_id FROM cards WHERE id=$1', [card.id]))[0]!.home_workstation_id,
    ).toBeNull();
    const ev = await q(`SELECT payload FROM events WHERE stream_id=$1 AND type='CardRehomed'`, [
      `card-${card.id}`,
    ]);
    expect(ev).toHaveLength(1);
  });

  it('accept skips a simulated workstation of the user instead of refusing (and never serves it)', async () => {
    const email = uniqueEmail('simacc');
    const u = await t.userSession(email);
    const real = (await pairWorkstation(t, u, 'simacc-real')).workstationId;
    const sim = await t.createOrg(u.id, 'Their simulation');
    await q('UPDATE organizations SET simulation=true WHERE id=$1', [sim]);
    const simWs = randomUUID();
    await q(
      `INSERT INTO workstations (id, user_id, name, platform, hostname, runner_version, token_hash, status, paired_at, simulation_org_id)
       VALUES ($1, $2, 'Simulated', 'linux', 'sim', '0', $3, 'active', now(), $4)`,
      [simWs, u.id, `hash-${simWs}`, sim],
    );
    await ok(
      t.req('POST', '/api/platform/invitations', {
        cookie: root.cookie,
        body: { email, proposedOrgName: 'Sim owner org' },
      }),
      201,
    );
    const token = await latestInviteToken(email, ORIGIN);
    const me = await ok<any>(
      t.req('POST', `/api/invitations/${token}/accept-existing`, {
        cookie: u.cookie,
        body: { serveWorkstationIds: [real, simWs] },
      }),
      201,
    );
    expect((await servingRow(real, me.activeOrg.id))?.serving).toBe(true);
    expect(await servingRow(simWs, me.activeOrg.id)).toBeUndefined();
  });

  it('a member who left and joins again starts from what they tick: an old consent row is switched off', async () => {
    const m = await joiner('again', 1, () => ({}));
    const ws = m.ids[0]!;
    await ok(
      t.req('PUT', `/api/workstations/${ws}/orgs/${orgId}`, { cookie: m.cookie, body: { serving: true } }),
    );
    await ok(req(w.owner.cookie, 'DELETE', `/api/org/members/${m.id}`));
    expect((await servingRow(ws, orgId))?.serving).toBe(true); // left over from the earlier membership
    const token = await inviteMember(m.email);
    await ok(t.req('POST', `/api/invitations/${token}/accept-existing`, { cookie: m.cookie, body: {} }), 201);
    expect((await servingRow(ws, orgId))?.serving).toBe(false);
    const a = await hire();
    const r = await req(w.owner.cookie, 'POST', `/api/agents/${a.id}/rehome`, moveBody(ws));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('workstation_not_serving');
  });
});
