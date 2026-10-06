import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerBuiltins } from '../src/catalogue/boot.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('admin users', () => {
  it('lists users, changes roles, and protects the last admin', async () => {
    const admin = await t.userSession(uniqueEmail('admin'), 'admin');
    const memberEmail = uniqueEmail('member');
    const memberId = await t.createUser(memberEmail);
    const list = await t.req('GET', '/api/admin/users', { cookie: admin.cookie });
    expect(list.status).toBe(200);
    expect(list.body.users.map((u: { email: string }) => u.email)).toContain(memberEmail);

    const promote = await t.req('PATCH', `/api/admin/users/${memberId}`, {
      cookie: admin.cookie,
      body: { role: 'admin' },
    });
    expect(promote.body.role).toBe('admin');
    const demote = await t.req('PATCH', `/api/admin/users/${memberId}`, {
      cookie: admin.cookie,
      body: { role: 'member' },
    });
    expect(demote.body.role).toBe('member');

    // only one admin left in the active set -> cannot demote or deactivate self
    const onlyAdmins = (await q(`SELECT id FROM users WHERE legacy_role='admin' AND status='active'`)).map(
      (r) => r.id,
    );
    expect(onlyAdmins.length).toBeGreaterThanOrEqual(1);
    const self = await t.req('PATCH', `/api/admin/users/${admin.id}`, {
      cookie: admin.cookie,
      body: { status: 'deactivated' },
    });
    expect(self.status).toBe(409);
  });

  it('is invisible to members', async () => {
    const member = await t.userSession(uniqueEmail('member'));
    expect((await t.req('GET', '/api/admin/users', { cookie: member.cookie })).status).toBe(403);
  });

  it('PATCH validates its body', async () => {
    const admin = await t.userSession(uniqueEmail('admin'), 'admin');
    const r = await t.req('PATCH', `/api/admin/users/${admin.id}`, { cookie: admin.cookie, body: {} });
    expect(r.status).toBe(400);
  });
});

describe('catalogue boot', () => {
  it('registers built-in workflow and role versions exactly once', async () => {
    const before = await q('SELECT count(*)::int AS n FROM workflow_versions WHERE org_id IS NULL');
    expect(before[0]!.n).toBe(4);
    expect((await q('SELECT count(*)::int AS n FROM role_definitions WHERE org_id IS NULL'))[0]!.n).toBe(10);
    expect((await q('SELECT count(*)::int AS n FROM workflow_stages'))[0]!.n).toBeGreaterThan(10);
    const again = await registerBuiltins(t.app.ctx);
    expect(again).toEqual({ workflows: 0, roles: 0 });
    // concurrent boots do not duplicate either
    const more = await Promise.all([registerBuiltins(t.app.ctx), registerBuiltins(t.app.ctx)]);
    expect(more).toEqual([
      { workflows: 0, roles: 0 },
      { workflows: 0, roles: 0 },
    ]);
    expect(
      (await q(`SELECT count(*)::int AS n FROM events WHERE type='WorkflowVersionRegistered'`))[0]!.n,
    ).toBe(4);
  });
});

describe('health', () => {
  it('reports db state', async () => {
    const r = await t.req('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, db: true });
  });
});
