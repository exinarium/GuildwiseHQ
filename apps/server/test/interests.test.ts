import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

/**
 * Org-level interests (docs/design/restructure.md Part D): each is backed by a hidden project, edited by the role rule
 * (Owner > Admin > Member > Guest), seen by the members of its backing project, and listed on no project page.
 */
let t: TestApp;
let acme: string;
let projectId: string;
type Who = { id: string; email: string; cookie: string };
const who: Record<'owner' | 'admin' | 'member' | 'other' | 'guest', Who> = {} as never;

beforeAll(async () => {
  t = await createTestApp();
  for (const r of ['owner', 'admin', 'member', 'other', 'guest'] as const)
    who[r] = await t.userSession(uniqueEmail(r));
  acme = await t.createOrg(who.owner.id, 'Acme');
  await t.addOrgMember(acme, who.admin.id, 'admin');
  await t.addOrgMember(acme, who.member.id, 'member');
  await t.addOrgMember(acme, who.other.id, 'member');
  projectId = (
    await ok<any>(
      t.req('POST', '/api/projects', {
        cookie: who.owner.cookie,
        headers: { 'x-aom-org': acme },
        body: { key: 'ACM', name: 'Acme app' },
      }),
      201,
    )
  ).project.id;
  // the guest sees one project of Acme
  await ok(
    t.req('POST', `/api/projects/${projectId}/members`, {
      cookie: who.owner.cookie,
      body: { email: who.guest.email },
    }),
    201,
  );
  await ok(t.req('POST', `/api/projects/${projectId}/members/accept`, { cookie: who.guest.cookie }));
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

// A guest is not a member of Acme: their tab works in their own organization, so reads carry no org header.
const call = (role: keyof typeof who, method: string, url: string, body?: unknown) =>
  t.req(method, url, {
    cookie: who[role].cookie,
    ...(role === 'guest' ? {} : { headers: { 'x-aom-org': acme } }),
    body,
  });
const create = (role: keyof typeof who, name: string, extra: Record<string, unknown> = {}) =>
  t.req('POST', '/api/interests', {
    cookie: who[role].cookie,
    headers: { 'x-aom-org': acme },
    body: { name, ...extra },
  });
const made = async (role: keyof typeof who, name: string, extra: Record<string, unknown> = {}) =>
  (await ok<{ id: string }>(create(role, name, extra), 201)).id;
// biome-ignore lint/suspicious/noExplicitAny: a row read for assertions
const row = async (id: string): Promise<any> => (await q('SELECT * FROM interests WHERE id=$1', [id]))[0];

describe('creating an interest', () => {
  it('is backed by a hidden project and its vault folder interests/<slug>', async () => {
    const id = await made('owner', 'Rust async', {
      description: 'Deep dives on tokio internals',
      subCategory: 'rust/async',
      preferredSites: ['lobste.rs'],
      kinds: ['article', 'video'],
      scan: { cron: '0 7 * * *', timezone: 'Africa/Johannesburg', maxItems: 5 },
      delivery: { mode: 'scheduled', cron: '0 7 * * 1-5', timezone: 'Africa/Johannesburg' },
      tasteRules: ['Skip beginner tutorials'],
    });
    const i = await row(id);
    expect(i).toMatchObject({
      name: 'Rust async',
      slug: 'rust-async',
      status: 'active',
      kinds: ['article', 'video'],
      taste_version: 1,
      taste_rules: ['Skip beginner tutorials'],
      scan: {
        cron: '0 7 * * *',
        timezone: 'Africa/Johannesburg',
        windowHours: 24,
        maxItems: 5,
        manual: false,
      },
      delivery: { mode: 'scheduled' },
    });
    expect(new Date(i.next_scan_at).getUTCHours()).toBe(5);
    expect(new Date(i.next_delivery_at).getUTCHours()).toBe(5);
    const p = (await q('SELECT * FROM projects WHERE id=$1', [i.project_id]))[0];
    expect(p).toMatchObject({
      kind: 'interest',
      workflow_key: 'feed',
      vault_dir: 'interests/rust-async',
      rank: null,
    });
    expect(p?.key).toMatch(/^[A-Z][A-Z0-9]{1,9}$/);
    const detail = await ok<any>(call('owner', 'GET', `/api/interests/${id}`));
    expect(detail.interest).toMatchObject({
      vaultDir: 'interests/rust-async',
      canManage: true,
      canShare: true,
      kinds: ['article', 'video'],
      createdBy: { id: who.owner.id },
    });
    expect(detail.taste.rules).toEqual(['Skip beginner tutorials']);
  });

  it('is never listed as a project, a board or a project member page', async () => {
    const id = await made('owner', 'Hidden one');
    const key = (
      await q('SELECT p.key, p.id FROM interests i JOIN projects p ON p.id = i.project_id WHERE i.id=$1', [
        id,
      ])
    )[0];
    const list = await ok<any>(call('owner', 'GET', '/api/projects?status=all'));
    expect(list.projects.map((p: any) => p.key)).toEqual(['ACM']);
    for (const url of [
      `/api/projects/${key?.id}`,
      `/api/board?projectId=${key?.id}`,
      `/api/projects/${key?.id}/phases`,
    ]) {
      const r = await call('owner', 'GET', url);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('managed_by_interest');
    }
    const patch = await call('owner', 'PATCH', `/api/projects/${key?.id}`, { name: 'x' });
    expect(patch.status).toBe(409);
    expect(patch.body.error.details).toMatchObject({ interestId: id });
    // backing projects do not count against the organization's project limit
    const me = await ok<any>(call('owner', 'GET', '/api/org'));
    expect(JSON.stringify(me)).not.toContain(key?.key ?? 'never');
  });

  it('rejects a bad cron, a bad time zone, a duplicate name and agents that cannot do the role', async () => {
    const bad = await create('owner', 'Bad cron', { scan: { cron: 'nope' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_cron');
    expect((await create('owner', 'Bad zone', { scan: { timezone: 'Mars/Olympus' } })).body.error.code).toBe(
      'invalid_timezone',
    );
    expect(
      (await create('owner', 'Bad delivery', { delivery: { mode: 'scheduled', cron: 'x y' } })).body.error
        .code,
    ).toBe('invalid_cron');
    await made('owner', 'Same name');
    const dup = await create('owner', 'SAME name');
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('interest_name_taken');
    const ghost = await create('owner', 'Ghost agent', {
      agents: { scout: '00000000-0000-4000-8000-000000000000' },
    });
    expect(ghost.status).toBe(400);
    expect(ghost.body.error.code).toBe('agent_not_eligible');
  });

  it('numbers the folder and the backing key on a collision', async () => {
    const a = await made('owner', 'Pi day');
    const b = await made('owner', 'Pi  day!'.replace('  ', ' ') + ' x');
    const c = await made('owner', 'pi-day');
    expect((await row(a)).slug).toBe('pi-day');
    expect((await row(c)).slug).toBe('pi-day-2');
    const keys = (await q('SELECT key FROM projects')).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(b).toBeTruthy();
  });
});

describe('who sees and who edits (the role rule)', () => {
  it('a Member creates a private interest: other members do not see it, the Owner and Admins do', async () => {
    const id = await made('member', 'Member topic');
    expect((await call('member', 'GET', `/api/interests/${id}`)).status).toBe(200);
    expect((await call('other', 'GET', `/api/interests/${id}`)).status).toBe(404);
    expect((await call('owner', 'GET', `/api/interests/${id}`)).status).toBe(200);
    expect((await call('admin', 'GET', `/api/interests/${id}`)).status).toBe(200);
    const mine = (await ok<any>(call('other', 'GET', '/api/interests'))).interests;
    expect(mine.map((i: any) => i.name)).not.toContain('Member topic');
    // sharing is the Owner's and the Admins'
    expect(
      (await call('member', 'POST', `/api/interests/${id}/members`, { userId: who.other.id })).status,
    ).toBe(403);
    await ok(call('admin', 'POST', `/api/interests/${id}/members`, { userId: who.other.id }));
    expect((await call('other', 'GET', `/api/interests/${id}`)).status).toBe(200);
    // another Member of the same level may edit it once they see it
    expect((await call('other', 'PATCH', `/api/interests/${id}`, { description: 'by a peer' })).status).toBe(
      200,
    );
    await ok(call('owner', 'DELETE', `/api/interests/${id}/members/${who.other.id}`));
    expect((await call('other', 'GET', `/api/interests/${id}`)).status).toBe(404);
  });

  it("edit and delete need a role at the creator's level or higher", async () => {
    const byAdmin = await made('admin', 'Admin topic');
    // a Member sees nothing of it; an Admin peer and the Owner may edit
    expect((await call('member', 'PATCH', `/api/interests/${byAdmin}`, { description: 'x' })).status).toBe(
      404,
    );
    await ok(call('owner', 'PATCH', `/api/interests/${byAdmin}`, { description: 'by the owner' }));
    // shared with a Member: they see it but may not change it (the creator outranks them)
    await ok(call('owner', 'POST', `/api/interests/${byAdmin}/members`, { userId: who.member.id }));
    for (const [method, url, body] of [
      ['PATCH', `/api/interests/${byAdmin}`, { description: 'no' }],
      ['POST', `/api/interests/${byAdmin}/archive`, undefined],
      ['POST', `/api/interests/${byAdmin}/run`, {}],
      ['PUT', `/api/interests/${byAdmin}/taste`, { rules: ['a rule'] }],
    ] as const) {
      const r = await call('member', method, url, body);
      expect(r.status, `${method} ${url}`).toBe(403);
    }
    const detail = await ok<any>(call('member', 'GET', `/api/interests/${byAdmin}`));
    expect(detail.interest.canManage).toBe(false);
    // the Owner's interest cannot be changed by an Admin either
    const byOwner = await made('owner', 'Owner topic');
    expect((await call('admin', 'PATCH', `/api/interests/${byOwner}`, { description: 'no' })).status).toBe(
      403,
    );
  });

  it('uses the stored rank once the creator has left the organization', async () => {
    const id = await made('other', 'Leaving topic');
    expect((await row(id)).created_by_rank).toBe(2);
    await ok(call('admin', 'POST', `/api/interests/${id}/members`, { userId: who.member.id }));
    // the creator leaves: the member of the same rank may still edit, a guest may not
    await q(`UPDATE org_members SET status='removed' WHERE org_id=$1 AND user_id=$2`, [acme, who.other.id]);
    await q(`UPDATE project_members SET status='removed' WHERE user_id=$1`, [who.other.id]);
    expect((await call('member', 'PATCH', `/api/interests/${id}`, { description: 'still ok' })).status).toBe(
      200,
    );
  });

  it('a guest may create any interest, private to them; the Owner sees it', async () => {
    const id = await made('guest', 'Guest topic');
    expect((await row(id)).created_by_rank).toBe(1);
    expect((await call('guest', 'GET', `/api/interests/${id}`)).status).toBe(200);
    expect((await call('member', 'GET', `/api/interests/${id}`)).status).toBe(404);
    expect((await call('owner', 'GET', `/api/interests/${id}`)).status).toBe(200);
    // the guest's interest does not give them the Acme project list beyond what was shared
    const projects = await ok<any>(call('guest', 'GET', '/api/projects'));
    expect(projects.projects.map((p: any) => p.key)).toEqual(['ACM']);
    // an Admin may edit what a guest created
    expect((await call('admin', 'PATCH', `/api/interests/${id}`, { description: 'tidied' })).status).toBe(
      200,
    );
    // a stranger to the organization cannot create in it
    const stranger = await t.userSession(uniqueEmail('stranger'));
    const no = await t.req('POST', '/api/interests', {
      cookie: stranger.cookie,
      headers: { 'x-aom-org': acme },
      body: { name: 'Nope' },
    });
    expect(no.status).toBe(403);
  });
});

describe('changing an interest', () => {
  it('pausing clears the next run and delivery, resuming sets them again, the slug never changes', async () => {
    const id = await made('owner', 'Cadence', {
      scan: { cron: '0 7 * * *' },
      delivery: { mode: 'scheduled', cron: '0 8 * * *' },
    });
    expect((await row(id)).next_scan_at).not.toBeNull();
    await ok(call('owner', 'PATCH', `/api/interests/${id}`, { status: 'paused' }));
    expect(await row(id)).toMatchObject({ status: 'paused', next_scan_at: null, next_delivery_at: null });
    await ok(call('owner', 'PATCH', `/api/interests/${id}`, { status: 'active' }));
    const r = await row(id);
    expect(r.next_scan_at).not.toBeNull();
    expect(new Date(r.next_delivery_at).getUTCHours()).toBe(8);
    await ok(
      call('owner', 'PATCH', `/api/interests/${id}`, { name: 'Cadence renamed', scan: { manual: true } }),
    );
    const after = await row(id);
    expect(after).toMatchObject({ slug: 'cadence', name: 'Cadence renamed', next_scan_at: null });
    expect(
      (await q('SELECT name, vault_dir FROM projects WHERE id=$1', [after.project_id]))[0],
    ).toMatchObject({
      name: 'Cadence renamed',
      vault_dir: 'interests/cadence',
    });
  });

  it('has no vault domain: a domain in the request is ignored, and an interest project is never ranked', async () => {
    const id = await made('owner', 'No domain', { domain: 'personal', scan: { manual: true } });
    expect((await call('owner', 'PATCH', `/api/interests/${id}`, { domain: 'work' })).status).toBe(200);
    const detail = await ok<any>(call('owner', 'GET', `/api/interests/${id}`));
    expect(detail.interest).not.toHaveProperty('domain');
    expect(detail.interest.vaultDir).toBe('interests/no-domain');
    const p = (await q('SELECT rank FROM projects WHERE id=$1', [(await row(id)).project_id]))[0];
    expect(p?.rank).toBeNull();
  });

  it('archives (cancelling its open run), restores, and deletes only an archived one after typing the slug', async () => {
    const id = await made('owner', 'Short lived');
    const run = await ok<any>(call('owner', 'POST', `/api/interests/${id}/run`, {}), 201);
    const del = await call('owner', 'DELETE', `/api/interests/${id}?confirmSlug=short-lived`);
    expect(del.status).toBe(409);
    await ok(call('owner', 'POST', `/api/interests/${id}/archive`));
    expect((await row(id)).archived_at).not.toBeNull();
    expect((await q('SELECT status FROM cards WHERE id=$1', [run.cardId]))[0]?.status).toBe('cancelled');
    expect((await q('SELECT status FROM interest_runs WHERE id=$1', [run.runId]))[0]?.status).toBe(
      'cancelled',
    );
    expect((await call('owner', 'PATCH', `/api/interests/${id}`, { description: 'x' })).body.error.code).toBe(
      'interest_archived',
    );
    const archivedList = (await ok<any>(call('owner', 'GET', '/api/interests?archived=true'))).interests;
    expect(archivedList.map((i: any) => i.name)).toContain('Short lived');
    expect(
      (await ok<any>(call('owner', 'GET', '/api/interests'))).interests.map((i: any) => i.name),
    ).not.toContain('Short lived');
    await ok(call('owner', 'POST', `/api/interests/${id}/restore`));
    expect((await row(id)).archived_at).toBeNull();
    await ok(call('owner', 'POST', `/api/interests/${id}/archive`));
    expect((await call('owner', 'DELETE', `/api/interests/${id}?confirmSlug=wrong`)).body.error.code).toBe(
      'slug_mismatch',
    );
    await ok(call('owner', 'DELETE', `/api/interests/${id}?confirmSlug=short-lived`));
    expect(await row(id)).toBeUndefined();
    expect(await q('SELECT 1 FROM projects WHERE vault_dir=$1', ['interests/short-lived'])).toHaveLength(0);
    expect(await q('SELECT 1 FROM interest_runs WHERE id=$1', [run.runId])).toHaveLength(0);
  });
});

describe('the quiet cap setting', () => {
  it('the Owner sets the daily cap; a Member sees it but cannot change it', async () => {
    await ok(call('owner', 'PUT', '/api/reporting', { interestDigestCap: 12 }));
    const list = await ok<any>(call('member', 'GET', '/api/interests'));
    expect(list).toMatchObject({ quietCap: 12, canSetCap: false });
    expect((await call('member', 'PUT', '/api/reporting', { interestDigestCap: 3 })).status).toBe(403);
    await ok(call('owner', 'PUT', '/api/reporting', { interestDigestCap: null }));
    expect((await ok<any>(call('owner', 'GET', '/api/interests'))).quietCap).toBeNull();
  });
});
