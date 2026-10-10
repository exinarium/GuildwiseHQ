import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let member: { id: string; cookie: string };
let orgId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
  const u = await w.t.userSession(uniqueEmail('newbie'));
  await w.t.addOrgMember(orgId, u.id, 'member');
  member = u;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const get = (cookie = w.owner.cookie) =>
  ok<any>(w.t.req('GET', '/api/setup-checklist', { cookie, headers: { 'x-aom-org': orgId } }));
const step = (c: any, id: string) => c.steps.find((s: any) => s.id === id);

describe('setup checklist', () => {
  it('computes the steps from real state and ticks them as things appear', async () => {
    await freshState();
    await q(`UPDATE projects SET status='archived' WHERE id=$1`, [w.projectId]);
    let c = await get();
    expect(c.steps.map((s: any) => s.id)).toEqual(['project', 'repository', 'workstation', 'team', 'ba']);
    expect(step(c, 'project')).toMatchObject({ done: false, link: '/projects?new=1', actionable: true });
    expect(step(c, 'repository')).toMatchObject({ done: false });
    expect(step(c, 'workstation')).toMatchObject({ done: true, link: null });
    expect(step(c, 'team')).toMatchObject({ done: false, link: '/agents?hire=ba' });
    expect(c).toMatchObject({ doneCount: 1, complete: false, dismissed: false });

    await q(`UPDATE projects SET status='active' WHERE id=$1`, [w.projectId]);
    c = await get();
    expect(step(c, 'project').done).toBe(true);
    expect(step(c, 'repository').done).toBe(true);

    await w.hire('Ben', 'ba', 'senior');
    await w.hire('Bea', 'builder', 'junior');
    c = await get();
    expect(step(c, 'team')).toMatchObject({
      done: false,
      link: '/agents?hire=reviewer',
      missing: ['reviewer', 'tester'],
    });
    await w.hire('Rex', 'reviewer', 'senior');
    await w.hire('Tia', 'tester', 'junior');
    c = await get();
    expect(step(c, 'team')).toMatchObject({ done: true, link: null });
    expect(step(c, 'ba').done).toBe(false);
    expect(c.complete).toBe(false);
  });

  it('the DevOps agent does not count as part of the team', async () => {
    await freshState();
    await w.hire('Ben', 'ba', 'senior');
    await q(`UPDATE agents SET is_devops=true WHERE name='Ben'`);
    expect(step(await get(), 'team').missing).toContain('business analyst');
  });

  it('completes itself once the BA has been talked to', async () => {
    await freshState();
    const runner = await w.connectRunner();
    for (const [n, r] of [
      ['Ben', 'ba'],
      ['Bea', 'builder'],
      ['Rex', 'reviewer'],
      ['Tia', 'tester'],
    ] as const)
      await w.hire(n, r, 'senior');
    await ok(
      w.t.req('POST', '/api/intakes', { cookie: w.owner.cookie, body: { note: 'I need a login page' } }),
      201,
    );
    const c = await get();
    expect(step(c, 'ba')).toMatchObject({ done: true, link: null });
    expect(c).toMatchObject({ doneCount: 5, complete: true });
    runner.close();
  });

  it('a Member sees the progress, with links only on the steps they may do', async () => {
    await freshState();
    const c = await get(member.cookie);
    expect(step(c, 'project')).toMatchObject({ done: true, actionable: false, link: null });
    expect(step(c, 'repository')).toMatchObject({ actionable: false, link: null });
    expect(step(c, 'team')).toMatchObject({ actionable: true, link: '/agents?hire=ba' });
    expect(step(c, 'ba')).toMatchObject({ actionable: true, link: '/desk' });
  });

  it('hiding and reopening is kept per user and does not change the steps', async () => {
    await freshState();
    const put = (cookie: string, dismissed: boolean) =>
      ok<any>(
        w.t.req('PUT', '/api/setup-checklist', {
          cookie,
          body: { dismissed },
          headers: { 'x-aom-org': orgId },
        }),
      );
    expect((await put(w.owner.cookie, true)).dismissed).toBe(true);
    expect((await get()).dismissed).toBe(true);
    expect((await get(member.cookie)).dismissed).toBe(false);
    expect((await put(w.owner.cookie, false)).dismissed).toBe(false);
  });

  it('needs a signed-in organization member', async () => {
    const res = await w.t.req('GET', '/api/setup-checklist', {});
    expect(res.status).toBe(401);
  });
});
