import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok, pairWorkstation } from './helpers/world.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

interface Person {
  id: string;
  email: string;
  cookie: string;
  workstationId: string;
}

/** An organization with an Owner, an Admin and a Member whose own workstation the DevOps work happens on. */
async function acme() {
  const mk = async (label: string): Promise<Person> => {
    const s = await t.userSession(uniqueEmail(label));
    const ws = await pairWorkstation(t, s, `${label}-box`);
    return { ...s, workstationId: ws.workstationId };
  };
  const owner = await mk('owner');
  const admin = await mk('admin');
  const member = await mk('member');
  const org = await t.createOrg(owner.id, 'Acme');
  await t.addOrgMember(org, admin.id, 'admin');
  await t.addOrgMember(org, member.id, 'member');
  const as = (who: Person, method: string, url: string, body?: unknown) =>
    t.req(method, url, { cookie: who.cookie, headers: { 'x-aom-org': org }, body });
  return { owner, admin, member, org, as };
}

/** A request on the member's workstation that waits for approval (the shift report path is covered elsewhere). */
async function waitingRequest(a: Awaited<ReturnType<typeof acme>>) {
  const created = await ok<any>(
    a.as(a.member, 'POST', '/api/devops/requests', {
      workstationId: a.member.workstationId,
      summary: 'install docker',
      origin: 'app',
      context: { route: '/projects' },
    }),
    201,
  );
  const id = created.request.id as string;
  await q(
    `UPDATE devops_requests SET status='needs_approval',
       approval = jsonb_build_object('deskItemId', gen_random_uuid()::text, 'action', 'install docker', 'reason', 'tests', 'commands', '[]'::jsonb, 'resolution', null)
     WHERE id=$1`,
    [id],
  );
  return id;
}
const statusOf = async (id: string) =>
  (await q('SELECT status FROM devops_requests WHERE id=$1', [id]))[0]?.status as string;

describe('DevOps approvals on a member workstation (G-Q8)', () => {
  it('stores the origin and context of an "Ask DevOps" request', async () => {
    const a = await acme();
    const id = await waitingRequest(a);
    const row = (await q('SELECT origin, context FROM devops_requests WHERE id=$1', [id]))[0];
    expect(row).toMatchObject({ origin: 'app', context: { route: '/projects' } });
  });

  it('an Admin approving is not enough: the workstation user must agree too', async () => {
    const a = await acme();
    const id = await waitingRequest(a);
    const first = await ok<any>(a.as(a.admin, 'POST', `/api/devops/requests/${id}/resolve`, { resolution: 'approved' }));
    expect(first.request.status).toBe('needs_approval');
    expect(first.request.approval).toMatchObject({ resolution: null, managerApproved: true });
    expect(first.messages.at(-1).body).toContain("workstation's user");
    // the same person cannot approve twice
    expect((await a.as(a.admin, 'POST', `/api/devops/requests/${id}/resolve`, { resolution: 'approved' })).status).toBe(409);
    // the workstation's user agrees: now it runs
    const second = await ok<any>(a.as(a.member, 'POST', `/api/devops/requests/${id}/resolve`, { resolution: 'approved' }));
    expect(second.request.approval.resolution).toBe('approved');
    expect(await statusOf(id)).toBe('queued');
  });

  it('the workstation user alone cannot approve; an Owner/Admin must as well', async () => {
    const a = await acme();
    const id = await waitingRequest(a);
    const first = await ok<any>(a.as(a.member, 'POST', `/api/devops/requests/${id}/resolve`, { resolution: 'approved' }));
    expect(first.request.status).toBe('needs_approval');
    expect(first.request.approval).toMatchObject({ workstationUserAgreed: true, resolution: null });
    await ok(a.as(a.owner, 'POST', `/api/devops/requests/${id}/resolve`, { resolution: 'approved' }));
    expect(await statusOf(id)).toBe('queued');
  });

  it('either party can reject, and a plain member of another workstation sees nothing', async () => {
    const a = await acme();
    const id = await waitingRequest(a);
    const stranger = await t.userSession(uniqueEmail('stranger'));
    await t.addOrgMember(a.org, stranger.id, 'member');
    expect(
      (await a.as(stranger as Person, 'POST', `/api/devops/requests/${id}/resolve`, { resolution: 'approved' })).status,
    ).toBe(404);
    expect((await a.as(stranger as Person, 'GET', `/api/devops/requests/${id}`)).status).toBe(404);
    // an Admin can see the member's request
    expect((await a.as(a.admin, 'GET', `/api/devops/requests/${id}`)).status).toBe(200);
    await ok(a.as(a.member, 'POST', `/api/devops/requests/${id}/resolve`, { resolution: 'rejected', note: 'not now' }));
    expect(await statusOf(id)).toBe('failed');
  });

  it('an Owner on their own workstation is both parties: one answer is enough', async () => {
    const a = await acme();
    const created = await ok<any>(
      a.as(a.owner, 'POST', '/api/devops/requests', { workstationId: a.owner.workstationId, summary: 'x' }),
      201,
    );
    const id = created.request.id as string;
    await q(
      `UPDATE devops_requests SET status='needs_approval',
         approval = jsonb_build_object('deskItemId', gen_random_uuid()::text, 'action', 'a', 'reason', 'r', 'commands', '[]'::jsonb, 'resolution', null)
       WHERE id=$1`,
      [id],
    );
    await ok(a.as(a.owner, 'POST', `/api/devops/requests/${id}/resolve`, { resolution: 'approved' }));
    expect(await statusOf(id)).toBe('queued');
  });
});
