import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool } from './helpers/db.ts';
import { addMember } from './helpers/members.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** PR-only review per repository: the owner's switch (AC1 on, AC2 off, AC5 owner only). */

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const repoOf = async () =>
  (await ok<any>(owner('GET', `/api/projects/${w.projectId}`))).repos.find((x: any) => x.id === w.repoId);
const prOnlyEvents = async () =>
  (
    await w.t.app.ctx.pool.query(
      `SELECT payload FROM events WHERE type='ProjectRepoPrOnlySet' AND payload->>'repoId' = $1 ORDER BY seq`,
      [w.repoId],
    )
  ).rows.map((r) => r.payload);

describe('PR-only review switch', () => {
  it('is off for a new repository and has no review status', async () => {
    const repo = await repoOf();
    expect(repo.prOnly).toBe(false);
    expect(repo.prReview).toBeNull();
  });

  it('AC1: the owner turns it on with a body of only prOnly; it reads on after a reload', async () => {
    const res = await ok<any>(
      owner('PATCH', `/api/projects/${w.projectId}/repos/${w.repoId}`, { prOnly: true }),
    );
    expect(res.repos.find((x: any) => x.id === w.repoId).prOnly).toBe(true);
    const repo = await repoOf();
    expect(repo.prOnly).toBe(true);
    expect(repo.prReview).toMatchObject({ waiting: 0 });
    const row = (
      await w.t.app.ctx.pool.query('SELECT pr_only, pr_only_since FROM project_repos WHERE id=$1', [w.repoId])
    ).rows[0];
    expect(row.pr_only).toBe(true);
    expect(row.pr_only_since).toBeInstanceOf(Date);
  });

  it('AC1: setting the same value again records nothing new', async () => {
    const before = (await prOnlyEvents()).length;
    await ok(owner('PATCH', `/api/projects/${w.projectId}/repos/${w.repoId}`, { prOnly: true }));
    expect((await prOnlyEvents()).length).toBe(before);
    const last = (await prOnlyEvents()).at(-1);
    expect(last).toMatchObject({ projectId: w.projectId, repoId: w.repoId, prOnly: true, by: w.owner.id });
  });

  it('AC5: a project member who is not the owner is refused and the setting stays as it was', async () => {
    const m = await addMember(w, 'prmember');
    const res = await w.t.req('PATCH', `/api/projects/${w.projectId}/repos/${w.repoId}`, {
      cookie: m.cookie,
      body: { prOnly: false },
    });
    expect(res.status).toBe(403);
    expect((await repoOf()).prOnly).toBe(true);
  });

  it('AC2: the owner turns it off; it reads off after a reload and the since time is cleared', async () => {
    await ok(owner('PATCH', `/api/projects/${w.projectId}/repos/${w.repoId}`, { prOnly: false }));
    const repo = await repoOf();
    expect(repo.prOnly).toBe(false);
    expect(repo.prReview).toBeNull();
    const row = (
      await w.t.app.ctx.pool.query('SELECT pr_only, pr_only_since FROM project_repos WHERE id=$1', [w.repoId])
    ).rows[0];
    expect(row).toMatchObject({ pr_only: false, pr_only_since: null });
  });

  it('refuses a body that is not a boolean, and an unknown repository', async () => {
    const bad = await owner('PATCH', `/api/projects/${w.projectId}/repos/${w.repoId}`, { prOnly: 'yes' });
    expect(bad.status).toBe(400);
    const missing = await owner(
      'PATCH',
      `/api/projects/${w.projectId}/repos/00000000-0000-4000-8000-000000000000`,
      { prOnly: true },
    );
    expect(missing.status).toBe(404);
  });
});
