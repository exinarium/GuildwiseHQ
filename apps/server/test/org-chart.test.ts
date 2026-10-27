import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { appoint } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, markOnline, ok, pairWorkstation, type World } from './helpers/world.ts';

/** The org chart (Organization, Org chart): agents with roles, status, escalation and reporting lines, spend, devops. */
let w: World;
let second: string;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const orgId = async () =>
  (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
const chart = async (cookie = w.owner.cookie, headers?: Record<string, string>) =>
  ok<any>(w.t.req('GET', '/api/org-chart', { cookie, ...(headers ? { headers } : {}) }));
const byName = (c: any, name: string) => c.agents.find((a: any) => a.name === name);

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  const p = await ok<any>(owner('POST', '/api/projects', { key: 'SEC', name: 'Second' }), 201);
  second = p.project.id;
  await w.hire('Bea', 'ba', 'senior');
  await w.hire('Sam', 'builder', 'senior');
  await w.hire('Jo', 'builder', 'junior', { allowedProjectIds: [second] });
  await w.hire('Rae', 'tester', 'junior', { allowedProjectIds: null });
  await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('org chart', () => {
  it('lists every active agent with its role, department, seniority, workstation and reporting line', async () => {
    const c = await chart();
    expect(c.owner.name).toBeTruthy();
    const sam = byName(c, 'Sam');
    expect(sam).toMatchObject({
      roleKey: 'builder',
      roleLabel: 'Builder',
      seniority: 'senior',
      isDevops: false,
    });
    expect(sam.department).toBe('delivery');
    expect(sam.workstation).toMatchObject({ id: w.workstationId, online: true });
    expect(sam.reportsTo.userId).toBe(c.owner.userId);
    expect(sam.reportsTo.orgRole).toBe('owner');
    expect(sam.avatarSeed).toBeTruthy();
    expect(c.departments.map((d: any) => d.key)).toContain('delivery');
    expect(c.projects.map((p: any) => p.key).sort()).toEqual(['SEC', 'TOY']);
  });

  it('draws the escalation: a junior to the seniors of its role, seniors to the BA, the BA and DevOps to the desk', async () => {
    const c = await chart();
    const sam = byName(c, 'Sam');
    const bea = byName(c, 'Bea');
    expect(byName(c, 'Jo').escalatesTo).toEqual({ level: 'peer', agentIds: [sam.id] });
    expect(sam.escalatesTo).toEqual({ level: 'ba', agentIds: [bea.id] });
    // a junior with no senior of its role goes straight to the BA
    expect(byName(c, 'Rae').escalatesTo).toEqual({ level: 'ba', agentIds: [bea.id] });
    expect(bea.escalatesTo).toEqual({ level: 'desk', agentIds: [] });
    const devops = c.agents.find((a: any) => a.isDevops);
    expect(devops.escalatesTo.level).toBe('desk');
  });

  it('sends seniors and the BA to an active CEO, as the routing does (the BA is skipped then)', async () => {
    const ceoId = await appoint(w);
    try {
      const c = await chart();
      const sam = byName(c, 'Sam');
      expect(byName(c, 'Jo').escalatesTo).toEqual({ level: 'peer', agentIds: [sam.id] });
      expect(sam.escalatesTo).toEqual({ level: 'ceo', agentIds: [ceoId] });
      expect(byName(c, 'Rae').escalatesTo).toEqual({ level: 'ceo', agentIds: [ceoId] });
      expect(byName(c, 'Bea').escalatesTo).toEqual({ level: 'ceo', agentIds: [ceoId] });
      // a paused CEO is skipped: back to the BA
      await q(`UPDATE agents SET paused_at=now() WHERE id=$1`, [ceoId]);
      expect(byName(await chart(), 'Sam').escalatesTo.level).toBe('ba');
    } finally {
      await q(`UPDATE agents SET status='retired', paused_at=NULL WHERE id=$1`, [ceoId]);
    }
  });

  it('keeps each workstation with its DevOps engineer apart from the agents', async () => {
    const c = await chart();
    const ws = c.workstations.find((x: any) => x.id === w.workstationId);
    const devops = c.agents.find((a: any) => a.isDevops);
    expect(ws.devopsAgentId).toBe(devops.id);
    expect(ws.agentIds).not.toContain(devops.id);
    expect(ws.agentIds.length).toBeGreaterThanOrEqual(4);
  });

  it('carries the allow-list and focus of each agent (the project filter works on them)', async () => {
    const c = await chart();
    expect(byName(c, 'Jo').allowedProjectIds).toEqual([second]);
    expect(byName(c, 'Rae').allowedProjectIds).toBeNull();
  });

  it('shows what each agent is doing: working on a card, blocked, idle, offline', async () => {
    let c = await chart();
    expect(byName(c, 'Sam').status).toBe('idle');
    const card = await w.card({ title: 'Chart work' });
    await q(`UPDATE cards SET claim_id=$2, claimed_by_agent_id=$3, status='claimed' WHERE id=$1`, [
      card.id,
      randomUUID(),
      byName(c, 'Sam').id,
    ]);
    c = await chart();
    expect(byName(c, 'Sam').status).toBe('working');
    expect(byName(c, 'Sam').activeCards[0]).toMatchObject({ ref: card.ref });
    await q(
      `UPDATE cards SET claim_id=NULL, claimed_by_agent_id=NULL, status='blocked', last_agent_id=$2 WHERE id=$1`,
      [card.id, byName(c, 'Sam').id],
    );
    c = await chart();
    expect(byName(c, 'Sam').status).toBe('blocked');
    expect(byName(c, 'Sam').blockedCards[0].ref).toBe(card.ref);
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    c = await chart();
    expect(byName(c, 'Sam').status).toBe('offline');
    expect(c.workstations.find((x: any) => x.id === w.workstationId).online).toBe(false);
    await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
    await q(`UPDATE cards SET status='cancelled', last_agent_id=NULL WHERE id=$1`, [card.id]);
  });

  it('includes spend and the recent work of an agent', async () => {
    const sam = byName(await chart(), 'Sam');
    const agent = sam.id as string;
    const shiftId = randomUUID();
    const card = (await q(`SELECT id FROM cards ORDER BY created_at LIMIT 1`))[0]?.id as string;
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, status, runtime, model, started_at, ended_at, outcome)
       VALUES ($1,$2,$3,$4,$5,'card','ended','mock','mock', now() - interval '2 minutes', now() - interval '1 minute','reported')`,
      [shiftId, await orgId(), agent, w.workstationId, card],
    );
    await q(
      `INSERT INTO shift_costs (shift_id, org_id, agent_id, project_id, kind, model, cost_usd_micros, ended_at)
       VALUES ($1,$2,$3,$4,'card','sonnet',2500000, now())`,
      [shiftId, await orgId(), agent, w.projectId],
    );
    const c = await chart();
    const s = byName(c, 'Sam');
    expect(s.spend).toMatchObject({ monthMicros: 2_500_000, totalMicros: 2_500_000, currency: 'USD' });
    expect(s.recentWork[0]).toMatchObject({ shiftId, outcome: 'reported', kind: 'card' });
  });

  it('is for the organization members: a stranger asking for this organization is refused, retired agents are left out', async () => {
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    const res = await w.t.req('GET', '/api/org-chart', {
      cookie: stranger.cookie,
      headers: { 'x-aom-org': await orgId() },
    });
    expect([403, 404]).toContain(res.status);
    // an unauthenticated request is 401
    expect((await w.t.req('GET', '/api/org-chart')).status).toBe(401);
    const ws2 = await pairWorkstation(w.t, w.owner, 'Other');
    expect(ws2.workstationId).toBeTruthy();
    const before = (await chart()).agents.length;
    await q(`UPDATE agents SET status='retired' WHERE name='Rae'`);
    expect((await chart()).agents.length).toBe(before - 1);
    await q(`UPDATE agents SET status='active' WHERE name='Rae'`);
  });
});
