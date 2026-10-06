import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, connectMemberRunner, hireFor, type Member } from './helpers/members.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('deactivating a user cuts off runner and project access (review H3)', () => {
  it('unlinks their workstations, removes them from shared projects, and refuses their runner token', async () => {
    const root = await w.t.superAdminSession();
    const m: Member = await addMember(w, 'gone');
    const mr = await connectMemberRunner(w, m);
    const agent = await hireFor(w, m, 'Gus', 'builder', 'junior');
    await w.card({ title: 'Queued for the leaver' });

    // the member owns an organization of their own: it is suspended first (the account of a running organization's
    // Owner is not deactivated), then the login goes
    await ok(
      w.t.req('POST', `/api/platform/orgs/${m.id}/suspend`, {
        cookie: root.cookie,
        body: { reason: 'leaving' },
      }),
    );
    await ok(
      w.t.req('PATCH', `/api/platform/users/${m.id}`, {
        cookie: root.cookie,
        body: { status: 'deactivated' },
      }),
    );

    expect((await q('SELECT status FROM workstations WHERE id=$1', [m.workstationId]))[0]!.status).toBe(
      'unlinked',
    );
    await until(async () => mr.closed, 3000, 'runner socket closed');
    expect(
      (
        await q(`SELECT status FROM project_members WHERE project_id=$1 AND user_id=$2`, [w.projectId, m.id])
      )[0]!.status,
    ).toBe('removed');
    const a = (await q('SELECT manager_user_id, status FROM agents WHERE id=$1', [agent.id]))[0]!;
    expect(a).toMatchObject({ manager_user_id: w.owner.id, status: 'needs_rehome' });
    // the project is not visible any more, and the owner keeps working
    expect((await w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: m.cookie })).status).toBe(401);

    const again = await FakeRunner.connect(w.baseUrl, m.runnerToken);
    await until(async () => again.closed, 3000, 'second connection refused');
    expect(again.closed!.code).toBe(4403);
  });

  it('a legacy workstation of a deactivated account is still refused and never dispatched to', async () => {
    const m = await addMember(w, 'legacy');
    // as if deactivated before the cut-off existed: only the user row changed
    await q(`UPDATE users SET status='deactivated' WHERE id=$1`, [m.id]);
    const r = await FakeRunner.connect(w.baseUrl, m.runnerToken);
    await until(async () => r.closed, 3000, 'connection refused');
    expect(r.closed!.code).toBe(4403);
  });
});
