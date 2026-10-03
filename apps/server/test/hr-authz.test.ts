import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember, hireFor, type Member } from './helpers/members.ts';
import { createWorld, type World } from './helpers/world.ts';

let w: World;
let m1: Member;
let m2: Member;
let olga: any; // owner, org-wide
let pam: any; // owner, project-scoped
let mia: any; // m1, project-scoped
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  m1 = await addMember(w, 'm-one');
  m2 = await addMember(w, 'm-two');
  olga = await w.hire('Olga', 'builder', 'junior');
  pam = await w.hire('Pam', 'builder', 'junior', { projectId: w.projectId });
  mia = await hireFor(w, m1, 'Mia', 'builder', 'junior');
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const as = (cookie: string) => ({
  get: (url: string) => w.t.req('GET', url, { cookie }),
  post: (url: string, body: unknown = {}) => w.t.req('POST', url, { cookie, body }),
  patch: (url: string, body: unknown = {}) => w.t.req('PATCH', url, { cookie, body }),
});
const names = async (cookie: string) =>
  ((await as(cookie).get('/api/agents')).body.agents as any[])
    .filter((a) => !a.isDevops)
    .map((a) => a.name)
    .sort();

describe('HR authorization in a shared project', () => {
  it('everyone sees the project agents; org-wide agents stay with the owner', async () => {
    expect(await names(w.owner.cookie)).toEqual(['Mia', 'Olga', 'Pam']);
    expect(await names(m1.cookie)).toEqual(['Mia', 'Pam']);
    expect(await names(m2.cookie)).toEqual(['Mia', 'Pam']);
    // nobody sees another user's DevOps engineer: m1 sees only the one on their own workstation
    const devops = ((await as(m1.cookie).get('/api/agents')).body.agents as any[]).filter((a) => a.isDevops);
    expect(devops.map((a) => a.workstationId)).toEqual([m1.workstationId]);
  });

  it('the owner can change and fire any agent of the project, org-wide ones included', async () => {
    const changed = await as(w.owner.cookie).patch(`/api/agents/${mia.id}`, {
      model: 'opus',
      effort: 'high',
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ model: 'opus', effort: 'high', managerUserId: m1.id });
    expect((await as(w.owner.cookie).patch(`/api/agents/${olga.id}`, { capacity: 2 })).status).toBe(200);
  });

  it('a member changes and fires only agents they hired themselves', async () => {
    const own = await as(m1.cookie).patch(`/api/agents/${mia.id}`, { model: 'sonnet' });
    expect(own.status).toBe(200);
    expect(own.body.model).toBe('sonnet');
    // the owner's project agent: visible but not theirs
    expect((await as(m1.cookie).patch(`/api/agents/${pam.id}`, { model: 'opus' })).status).toBe(403);
    expect((await as(m1.cookie).post(`/api/agents/${pam.id}/fire`)).status).toBe(403);
    // another manager's agent
    expect((await as(m2.cookie).patch(`/api/agents/${mia.id}`, { model: 'opus' })).status).toBe(403);
    expect((await as(m2.cookie).post(`/api/agents/${mia.id}/fire`)).status).toBe(403);
    // an agent outside the project is not even visible
    expect((await as(m1.cookie).patch(`/api/agents/${olga.id}`, { model: 'opus' })).status).toBe(404);
    expect((await as(m1.cookie).post(`/api/agents/${olga.id}/fire`)).status).toBe(404);
    const row = (await q('SELECT model, status FROM agents WHERE id=$1', [pam.id]))[0]!;
    expect(row.status).toBe('active');
  });

  it('members hire for the project only, onto their own workstation', async () => {
    // they cannot hire for a project they are not in
    const own = await as(m2.cookie).post('/api/projects', { key: 'TWO', name: 'Second' });
    expect(own.status).toBe(201);
    const wrong = await as(m1.cookie).post('/api/agents', {
      name: 'Zed',
      roleKey: 'builder',
      seniority: 'junior',
      workstationId: m1.workstationId,
      projectId: own.body.project.id,
    });
    expect(wrong.status).toBe(404);
    // and the agent they hire serves the owner's org (owner's catalogue, owner's name space)
    const clash = await as(m1.cookie).post('/api/agents', {
      name: 'olga',
      roleKey: 'builder',
      seniority: 'junior',
      workstationId: m1.workstationId,
      projectId: w.projectId,
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('name_taken');
  });

  it('a member can fire their own hire; the owner can fire anyone', async () => {
    const fired = await as(m1.cookie).post(`/api/agents/${mia.id}/fire`);
    expect(fired.status).toBe(200);
    expect(fired.body.agent.status).toBe('retired');
    expect((await as(w.owner.cookie).post(`/api/agents/${pam.id}/fire`)).status).toBe(200);
    expect((await as(w.owner.cookie).post(`/api/agents/${olga.id}/fire`)).status).toBe(200);
  });

  it('the DevOps engineer is out of reach for everyone but its owner', async () => {
    const devops = ((await as(w.owner.cookie).get('/api/agents')).body.agents as any[]).find(
      (a) => a.isDevops,
    );
    expect((await as(m1.cookie).post(`/api/agents/${devops.id}/reset`)).status).toBe(404);
    expect((await as(m1.cookie).post(`/api/agents/${devops.id}/fire`)).status).toBe(404);
    expect((await as(w.owner.cookie).post(`/api/agents/${devops.id}/reset`)).status).toBe(200);
  });

  it('after removal a member loses all HR rights in the project', async () => {
    const back = await hireFor(w, m2, 'Max', 'builder', 'junior');
    expect(
      (await as(w.owner.cookie).get(`/api/projects/${w.projectId}/members/${m2.id}/removal-preview`)).status,
    ).toBe(200);
    const del = await w.t.req('DELETE', `/api/projects/${w.projectId}/members/${m2.id}`, {
      cookie: w.owner.cookie,
    });
    expect(del.status).toBe(200);
    expect((await as(m2.cookie).patch(`/api/agents/${back.id}`, { model: 'opus' })).status).toBe(404);
    expect(await names(m2.cookie)).toEqual([]);
  });
});
