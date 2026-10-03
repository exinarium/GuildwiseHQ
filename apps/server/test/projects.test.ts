import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

let t: TestApp;
let a: { id: string; cookie: string };
let b: { id: string; cookie: string };
beforeAll(async () => {
  t = await createTestApp();
  a = await t.userSession(uniqueEmail('a'));
  b = await t.userSession(uniqueEmail('b'));
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('projects', () => {
  it('creates a project, makes the creator the owner, and lists it', async () => {
    const r = await t.req('POST', '/api/projects', {
      cookie: a.cookie,
      body: { key: 'WEB', name: 'Web app' },
    });
    expect(r.status).toBe(201);
    expect(r.body.project).toMatchObject({
      key: 'WEB',
      domain: 'work',
      workflowKey: 'code',
      workingBranch: 'main',
      branchPrefix: 'aom/',
      myRole: 'owner',
      status: 'active',
    });
    expect(r.body.members).toHaveLength(1);
    const list = await ok<any>(t.req('GET', '/api/projects', { cookie: a.cookie }));
    expect(list.projects.map((p: any) => p.key)).toEqual(['WEB']);
    const me = await ok<any>(t.req('GET', '/api/auth/me', { cookie: a.cookie }));
    expect(me.visibleProjectIds).toEqual([r.body.project.id]);
  });

  it('rejects bad keys, duplicate keys per org, unknown workflows', async () => {
    expect(
      (await t.req('POST', '/api/projects', { cookie: a.cookie, body: { key: 'x', name: 'n' } })).status,
    ).toBe(400);
    expect(
      (await t.req('POST', '/api/projects', { cookie: a.cookie, body: { key: 'WEB', name: 'dup' } })).status,
    ).toBe(409);
    expect(
      (
        await t.req('POST', '/api/projects', {
          cookie: a.cookie,
          body: { key: 'ZZZ', name: 'n', workflowKey: 'nope' },
        })
      ).status,
    ).toBe(400);
    // same key in another org is fine
    expect(
      (await t.req('POST', '/api/projects', { cookie: b.cookie, body: { key: 'WEB', name: 'b web' } }))
        .status,
    ).toBe(201);
  });

  it('adds repos with normalized URLs and refuses duplicates (ssh and https are the same repo)', async () => {
    const p = (await ok<any>(t.req('GET', '/api/projects', { cookie: a.cookie }))).projects[0];
    const add = await t.req('POST', `/api/projects/${p.id}/repos`, {
      cookie: a.cookie,
      body: { name: 'web', remoteUrl: 'git@github.com:Acme/Web.git' },
    });
    expect(add.status).toBe(201);
    expect(add.body.repos[0].remoteUrlNormalized).toBe('github.com/acme/web');
    const dup = await t.req('POST', `/api/projects/${p.id}/repos`, {
      cookie: a.cookie,
      body: { name: 'web2', remoteUrl: 'https://github.com/acme/web' },
    });
    expect(dup.status).toBe(409);
    const del = await t.req('DELETE', `/api/projects/${p.id}/repos/${add.body.repos[0].id}`, {
      cookie: a.cookie,
    });
    expect(del.status).toBe(200);
    expect(del.body.repos).toHaveLength(0);
    // re-adding after removal works and keeps the repo id
    const again = await t.req('POST', `/api/projects/${p.id}/repos`, {
      cookie: a.cookie,
      body: { name: 'web', remoteUrl: 'https://github.com/acme/web.git' },
    });
    expect(again.status).toBe(201);
    expect(again.body.repos[0].id).toBe(add.body.repos[0].id);
  });

  it('patches project settings (owner only) and hides projects from non-members', async () => {
    const p = (await ok<any>(t.req('GET', '/api/projects', { cookie: a.cookie }))).projects[0];
    const patch = await t.req('PATCH', `/api/projects/${p.id}`, {
      cookie: a.cookie,
      body: { workingBranch: 'develop', e2eGlobs: ['e2e/**'], architecturalGlobs: ['src/core/**'] },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.project).toMatchObject({
      workingBranch: 'develop',
      e2eGlobs: ['e2e/**'],
      architecturalGlobs: ['src/core/**'],
    });
    for (const req of [
      t.req('GET', `/api/projects/${p.id}`, { cookie: b.cookie }),
      t.req('PATCH', `/api/projects/${p.id}`, { cookie: b.cookie, body: { name: 'hax' } }),
      t.req('POST', `/api/projects/${p.id}/repos`, {
        cookie: b.cookie,
        body: { name: 'x', remoteUrl: 'https://x.test/a/b' },
      }),
    ]) {
      expect((await req).status).toBe(404);
    }
  });
});
