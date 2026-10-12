import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';
import { createWorld, ok, pairWorkstation, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ listen: false });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('two-user isolation', () => {
  it("a second user sees none of the first user's projects, cards, agents, shifts or workstations", async () => {
    await w.hire('Mine', 'builder', 'junior');
    const card = await w.card({ title: 'Secret' });
    const other = await w.t.userSession(uniqueEmail('intruder'));
    const c = other.cookie;
    const get = (url: string) => w.t.req('GET', url, { cookie: c });

    expect((await ok<any>(get('/api/projects'))).projects).toEqual([]);
    expect((await ok<any>(get('/api/agents'))).agents).toEqual([]);
    expect((await ok<any>(get('/api/agents?projectId=' + w.projectId))).agents).toEqual([]);
    expect((await ok<any>(get('/api/workstations'))).workstations).toEqual([]);
    expect((await ok<any>(get('/api/shifts'))).shifts).toEqual([]);
    expect((await ok<any>(get('/api/auth/me'))).visibleProjectIds).toEqual([]);
    for (const url of [
      `/api/projects/${w.projectId}`,
      `/api/board?projectId=${w.projectId}`,
      `/api/cards/${card.id}`,
      `/api/cards/${card.ref}`,
    ]) {
      expect((await get(url)).status, url).toBe(404);
    }
    for (const [m, url, body] of [
      ['POST', `/api/cards/${card.id}/cancel`, { reason: 'x' }],
      ['POST', `/api/cards/${card.id}/move`, { toStage: 'spec', reason: 'x' }],
      ['PATCH', `/api/cards/${card.id}`, { title: 'pwned' }],
      ['POST', `/api/projects/${w.projectId}/repos`, { name: 'x', remoteUrl: 'https://x.test/a/b' }],
      ['POST', `/api/workstations/${w.workstationId}/unlink`, {}],
      ['PATCH', `/api/workstations/${w.workstationId}`, { name: 'x' }],
    ] as const) {
      expect((await w.t.req(m, url, { cookie: c, body })).status, `${m} ${url}`).toBe(404);
    }
    // cannot hire onto someone else's workstation, nor into their project
    expect(
      (
        await w.t.req('POST', '/api/agents', {
          cookie: c,
          body: { name: 'Spy', roleKey: 'builder', seniority: 'junior', workstationId: w.workstationId },
        })
      ).status,
    ).toBe(404);
    const mine = await pairWorkstation(w.t, other);
    expect(
      (
        await w.t.req('POST', '/api/agents', {
          cookie: c,
          body: {
            name: 'Spy',
            roleKey: 'builder',
            seniority: 'junior',
            workstationId: mine.workstationId,
            projectId: w.projectId,
          },
        })
      ).status,
    ).toBe(404);
    // the owner's data is untouched
    const own = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: w.owner.cookie }));
    expect(own.card.title).toBe('Secret');
    expect(own.card.status).toBe('queued');
  });

  it('phases, follow-ups and deploy targets of one user are invisible and untouchable to another (admins included)', async () => {
    const target = await ok<any>(
      w.t.req('POST', `/api/projects/${w.projectId}/deploy-targets`, {
        cookie: w.owner.cookie,
        body: { name: 'local', kind: 'local_docker' },
      }),
      201,
    );
    const phase = await ok<any>(
      w.t.req('POST', `/api/projects/${w.projectId}/phases`, {
        cookie: w.owner.cookie,
        body: { name: 'Private phase', followups: [{ kind: 'deploy', targetId: target.id }] },
      }),
      201,
    );
    const card = await w.card({ title: 'In the private phase', specify: false });
    const other = await w.t.userSession(uniqueEmail('phase-intruder'));
    const admin = await w.t.userSession(uniqueEmail('phase-admin'), 'admin');
    for (const who of [other, admin]) {
      const c = who.cookie;
      for (const [m, url, body] of [
        ['GET', `/api/projects/${w.projectId}/phases`, undefined],
        ['POST', `/api/projects/${w.projectId}/phases`, { name: 'Mine now' }],
        ['GET', `/api/phases/${phase.id}`, undefined],
        ['GET', `/api/phases/by-number/TOY/${phase.number}`, undefined],
        ['PATCH', `/api/phases/${phase.id}`, { name: 'pwned' }],
        ['PUT', `/api/phases/${phase.id}/followups`, { followups: [] }],
        ['POST', `/api/phases/${phase.id}/reopen`, { reason: 'x' }],
        ['PUT', `/api/cards/${card.id}/phase`, { phaseId: phase.id }],
        ['POST', `/api/cards/${card.id}/confirm-merged`, {}],
        ['GET', `/api/projects/${w.projectId}/deploy-targets`, undefined],
        ['POST', `/api/projects/${w.projectId}/deploy-targets`, { name: 'x', kind: 'local_docker' }],
        ['PATCH', `/api/deploy-targets/${target.id}`, { notes: 'x' }],
        ['DELETE', `/api/deploy-targets/${target.id}`, undefined],
        ['GET', `/api/projects/${w.projectId}/followup-defaults`, undefined],
        ['PUT', `/api/projects/${w.projectId}/followup-defaults`, { followups: [] }],
        ['GET', `/api/board?projectId=${w.projectId}&phaseId=${phase.id}`, undefined],
      ] as const) {
        expect((await w.t.req(m, url, { cookie: c, body })).status, `${m} ${url}`).toBe(404);
      }
    }
    // the threads of a phase are readable by members only
    expect((await w.t.req('GET', `/api/threads/${phase.id}/messages`, { cookie: other.cookie })).status).toBe(
      404,
    );
    expect(
      (await w.t.req('GET', `/api/threads/${phase.id}/messages`, { cookie: w.owner.cookie })).status,
    ).toBe(200);
    // and the owner's phase is untouched
    expect((await ok<any>(w.t.req('GET', `/api/phases/${phase.id}`, { cookie: w.owner.cookie }))).name).toBe(
      'Private phase',
    );
  });

  it("another organization's Owner gets no visibility into this user's projects, cards or agents", async () => {
    const admin = await w.t.userSession(uniqueEmail('adm'), 'admin');
    const card = (
      await ok<any>(w.t.req('GET', `/api/board?projectId=${w.projectId}`, { cookie: w.owner.cookie }))
    ).columns.flatMap((x: any) => x.cards)[0];
    expect((await w.t.req('GET', `/api/cards/${card.id}`, { cookie: admin.cookie })).status).toBe(404);
    expect((await w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: admin.cookie })).status).toBe(404);
    expect((await ok<any>(w.t.req('GET', '/api/agents', { cookie: admin.cookie }))).agents).toEqual([]);
    // an organization's Owner or Admin has no reach into someone else's workstations either: they are the user's own
    expect(
      (await ok<any>(w.t.req('GET', '/api/workstations', { cookie: admin.cookie }))).workstations,
    ).toEqual([]);
    expect(
      (await w.t.req('POST', `/api/workstations/${w.workstationId}/unlink`, { cookie: admin.cookie })).status,
    ).toBe(404);
    expect(
      (await ok<any>(w.t.req('GET', '/api/workstations', { cookie: w.owner.cookie }))).workstations.map(
        (x: any) => x.id,
      ),
    ).toContain(w.workstationId);
  });

  it('catalogue endpoints list the built-in roles and workflows to any signed-in user', async () => {
    const u = await w.t.userSession(uniqueEmail('cat'));
    const roles = await ok<any>(w.t.req('GET', '/api/roles', { cookie: u.cookie }));
    expect(roles.roles.map((r: any) => r.definition.key).sort()).toEqual([
      'architect',
      'ba',
      'builder',
      'checker',
      'curator',
      'devops',
      'researcher',
      'reviewer',
      'scout',
      'tester',
      'writer',
    ]);
    const wfs = await ok<any>(w.t.req('GET', '/api/workflows', { cookie: u.cookie }));
    expect(wfs.workflows.map((x: any) => x.definition.key).sort()).toEqual([
      'code',
      'code-bugfix',
      'feed',
      'research',
    ]);
    expect((await w.t.req('GET', '/api/roles')).status).toBe(401);
  });
});
