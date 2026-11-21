import { randomUUID } from 'node:crypto';
import { ACCOUNT_SCOPE_IDS } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withConfig } from '../src/config.ts';
import { syncPlatformTeamDesignation } from '../src/platform-team/settings.ts';
import { PASSWORD, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { singleOrgUser } from './helpers/single-org.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * R5 route list: every guarded route answers 403 `step_up_required` on a session whose proof is stale, and passes the
 * guard once the user has confirmed it is them (the password for an account without two-factor login, a code for the
 * super admin). Status-only GETs stay open. What a route answers after the guard (202, 404 for an unknown id...) is its
 * own business; the list checks the guard.
 */
let w: World;
let root: { id: string; cookie: string; email: string };
let memberId: string;
const WS_KEY = 'abcd1234abcd1234';

beforeAll(async () => {
  w = await createWorld();
  root = await w.t.superAdminSession();
  // no access in another organization, so the member resets are not refused by R6 after the guard
  memberId = (await singleOrgUser(w.t, uniqueEmail('member'))).id;
  await w.t.addOrgMember(w.owner.id, memberId);
  // a platform team (the owner's organization) so the owner may ask for grants: server config since R17-1
  // (PUT /api/platform/team is gone)
  w.t.app.ctx.config = withConfig(w.t.app.ctx.config, {
    platformTeam: { orgId: w.owner.id, projectId: w.projectId },
  });
  await syncPlatformTeamDesignation(w.t.app.ctx);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

/** Makes every session of the user stale: its last proof lies just outside the window. */
const stale = (userId: string) =>
  q('UPDATE auth_sessions SET second_factor_at=$2 WHERE user_id=$1', [
    userId,
    new Date(w.t.clock.now().getTime() - (w.t.app.ctx.config.stepUpWindowSec + 1) * 1000),
  ]);

type Route = [method: string, url: () => string, body?: () => unknown];
const ws = () => w.workstationId;
const sealed = () => ({ workstationId: w.workstationId, keyId: WS_KEY, ciphertext: 'Zm9v' });

const OWNER_ROUTES: Route[] = [
  // sudo key and password (devops.ts)
  ['GET', () => `/api/workstations/${ws()}/sudo-key`],
  ['PUT', () => `/api/workstations/${ws()}/sudo-password`, () => ({ ciphertext: 'Zm9v', keyId: WS_KEY })],
  ['DELETE', () => `/api/workstations/${ws()}/sudo-password`],
  // test accounts of a deploy target (runs.ts)
  [
    'PUT',
    () => `/api/workstations/${ws()}/target-secrets`,
    () => ({ targetId: randomUUID(), name: 'TEST_USER_PASSWORD', keyId: WS_KEY, ciphertext: 'Zm9v' }),
  ],
  // the project's accounts (projects.ts)
  ['PUT', () => `/api/projects/${w.projectId}/claude-account`, () => ({ accountKey: null })],
  [
    'PUT',
    () => `/api/projects/${w.projectId}/provider-accounts/${ACCOUNT_SCOPE_IDS[0]}`,
    () => ({ accountKey: null }),
  ],
  // deploy targets (phases.ts)
  [
    'POST',
    () => `/api/projects/${w.projectId}/deploy-targets`,
    () => ({ name: 'staging', kind: 'local_docker', appUrl: 'https://staging.example.test', notes: '' }),
  ],
  ['PATCH', () => `/api/deploy-targets/${randomUUID()}`, () => ({ notes: 'x' })],
  ['DELETE', () => `/api/deploy-targets/${randomUUID()}`],
  // workstation provider keys (providers.ts)
  [
    'PUT',
    () => `/api/workstations/${ws()}/providers/openai`,
    () => ({ keyId: WS_KEY, ciphertext: 'Zm9v', generation: 1_790_000_000 }),
  ],
  ['DELETE', () => `/api/workstations/${ws()}/providers/openai`],
  // organization provider keys (org-providers.ts)
  ['PUT', () => '/api/org/providers/openai', () => ({ shares: [sealed()], generation: 1 })],
  ['DELETE', () => '/api/org/providers/openai'],
  ['PUT', () => '/api/org/providers/openai/shares', () => ({ ...sealed(), generation: 1 })],
  [
    'POST',
    () => '/api/org/providers/openai/reshare',
    () => ({ sourceWorkstationId: ws(), targetWorkstationId: randomUUID(), generation: 1, approval: 'x' }),
  ],
  // platform-team grants
  ['POST', () => '/api/platform-team/grants', () => ({ signature: 'sig-1', reason: 'please look' })],
  ['POST', () => `/api/platform-team/grants/${randomUUID()}/revoke`],
  // member resets (orgs.ts)
  ['POST', () => `/api/org/members/${memberId}/reset-two-factor`],
  ['POST', () => `/api/org/members/${memberId}/reset-password`],
];

const ROOT_ROUTES: Route[] = [
  ['PATCH', () => '/api/platform/security-settings', () => ({ enforceTwoFactor: false })],
  ['POST', () => `/api/platform/users/${memberId}/send-password-reset`],
];

/** The route as written in the list (the ids are known only once the world exists). */
const label = ([method, url]: Route) =>
  `${method} ${url
    .toString()
    .replace(/^\(\) =>\s*/, '')
    .replace(/\$\{.*?\}/g, ':id')
    .replace(/[`"']/g, '')}`;

const call = (cookie: string, [method, url, body]: Route) =>
  w.t.req(method, url(), { cookie, ...(body ? { body: body() } : {}) });

describe('the guarded routes of a member', () => {
  it.each(OWNER_ROUTES.map((r) => [label(r), r] as const))(
    '%s: 403 step_up_required when stale, through the guard after the password',
    async (_name, route) => {
      await stale(w.owner.id);
      const before = await call(w.owner.cookie, route);
      expect(before.status, JSON.stringify(before.body)).toBe(403);
      expect(before.body.error).toMatchObject({ code: 'step_up_required', details: { method: 'password' } });

      await ok(
        w.t.req('POST', '/api/auth/step-up', { cookie: w.owner.cookie, body: { password: PASSWORD } }),
      );
      const after = await call(w.owner.cookie, route);
      expect(after.body?.error?.code, JSON.stringify(after.body)).not.toBe('step_up_required');
    },
  );

  it('a member reset works end to end after the step-up (temporary password in the answer)', async () => {
    await stale(w.owner.id);
    await ok(w.t.req('POST', '/api/auth/step-up', { cookie: w.owner.cookie, body: { password: PASSWORD } }));
    const r = await ok<any>(
      w.t.req('POST', `/api/org/members/${memberId}/reset-password`, { cookie: w.owner.cookie }),
    );
    expect(typeof r.temporaryPassword).toBe('string');
  });

  it('status-only GETs stay open on a stale session', async () => {
    await stale(w.owner.id);
    for (const url of [
      `/api/projects/${w.projectId}/target-secrets`,
      `/api/workstations/${ws()}/providers`,
      `/api/projects/${w.projectId}/deploy-targets`,
      '/api/org/providers',
    ]) {
      const r = await w.t.req('GET', url, { cookie: w.owner.cookie });
      expect(r.status, `${url} ${JSON.stringify(r.body)}`).toBe(200);
    }
  });
});

describe('the super admin: every platform write, never a read', () => {
  it.each(ROOT_ROUTES.map((r) => [label(r), r] as const))(
    '%s: 403 step_up_required {totp} when stale, through the guard after a code',
    async (_name, route) => {
      await stale(root.id);
      const before = await call(root.cookie, route);
      expect(before.status, JSON.stringify(before.body)).toBe(403);
      expect(before.body.error).toMatchObject({ code: 'step_up_required', details: { method: 'totp' } });

      await ok(
        w.t.req('POST', '/api/auth/step-up', {
          cookie: root.cookie,
          body: { code: await w.t.totpCode(root.id) },
        }),
      );
      const after = await call(root.cookie, route);
      expect(after.status, JSON.stringify(after.body)).toBeLessThan(300);
    },
  );

  it('platform reads stay open on a stale session', async () => {
    await stale(root.id);
    for (const url of ['/api/platform/team', '/api/platform/security-settings']) {
      const r = await w.t.req('GET', url, { cookie: root.cookie });
      expect(r.status, `${url} ${JSON.stringify(r.body)}`).toBe(200);
    }
  });

  it('a non-super-admin still gets 404 from a platform write, never a step-up prompt', async () => {
    await stale(w.owner.id);
    const r = await w.t.req('PATCH', '/api/platform/security-settings', {
      cookie: w.owner.cookie,
      body: { enforceTwoFactor: false },
    });
    expect(r.status).toBe(404);
  });

  it('only a password sign-in is fresh: a super-admin session from an invitation or demo method must step up', async () => {
    const { createSession, SESSION_COOKIE } = await import('../src/auth/sessions.ts');
    const { token } = await createSession(w.t.app.ctx, root.id, {}, 'invitation');
    const r = await w.t.req('PATCH', '/api/platform/security-settings', {
      cookie: `${SESSION_COOKIE}=${token}`,
      body: { enforceTwoFactor: false },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('step_up_required');
  });
});

/** Follow-up (coordinator, after review): privilege and secret writes the first list did not name. */
const FOLLOW_UP_ROUTES: Route[] = [
  // member role changes and invitations (orgs.ts)
  ['PATCH', () => `/api/org/members/${memberId}`, () => ({ role: 'admin' })],
  ['POST', () => '/api/org/invitations', () => ({ email: uniqueEmail('invitee'), role: 'member' })],
  // DevOps access grants and approvals (devops.ts)
  ['PATCH', () => `/api/workstations/${ws()}/devops-access`, () => ({ allowDocker: true })],
  ['POST', () => `/api/devops/requests/${randomUUID()}/resolve`, () => ({ resolution: 'approved' })],
  // integration connect (integrations.ts): sealed credentials, or a sign-in session that ends in them
  [
    'POST',
    () => `/api/workstations/${ws()}/integrations/connect`,
    () => ({
      requestId: randomUUID(),
      kind: 'jira',
      instance: '',
      method: 'token',
      envelope: { v: 1, alg: 'RSA-OAEP-256+A256GCM', keyId: WS_KEY, wrappedKey: 'eA', iv: 'aXY', ct: 'eA' },
    }),
  ],
  [
    'POST',
    () => `/api/workstations/${ws()}/integrations/sessions`,
    () => ({ kind: 'claude-code', instance: '', method: 'setup_token' }),
  ],
  // rotating schedule, relay and hook secrets
  ['POST', () => `/api/schedules/${randomUUID()}/rotate-secret`],
  ['POST', () => `/api/relay/integrations/${randomUUID()}/rotate`],
  ['POST', () => `/api/journeys/${randomUUID()}/hooks/${randomUUID()}/rotate`],
];

describe('follow-up: privilege and secret writes', () => {
  it.each(FOLLOW_UP_ROUTES.map((r) => [label(r), r] as const))(
    '%s: 403 step_up_required when stale, through the guard after the password',
    async (_name, route) => {
      await stale(w.owner.id);
      const before = await call(w.owner.cookie, route);
      expect(before.status, JSON.stringify(before.body)).toBe(403);
      expect(before.body.error).toMatchObject({ code: 'step_up_required', details: { method: 'password' } });
      await ok(
        w.t.req('POST', '/api/auth/step-up', { cookie: w.owner.cookie, body: { password: PASSWORD } }),
      );
      const after = await call(w.owner.cookie, route);
      expect(after.body?.error?.code, JSON.stringify(after.body)).not.toBe('step_up_required');
    },
  );

  it('rejecting a DevOps request needs no step-up', async () => {
    await stale(w.owner.id);
    const r = await w.t.req('POST', `/api/devops/requests/${randomUUID()}/resolve`, {
      cookie: w.owner.cookie,
      body: { resolution: 'rejected' },
    });
    expect(r.body?.error?.code).not.toBe('step_up_required');
  });

  const deskItem = async (subkind: string) => {
    const id = randomUUID();
    await q(
      `INSERT INTO desk_items (id, org_id, kind, subkind, title, status, created_at, updated_at)
       VALUES ($1,$2,'approval',$3,'test approval','open',now(),now())`,
      [id, w.owner.id, subkind],
    );
    return id;
  };
  const resolve = (id: string, resolution: string) =>
    w.t.req('POST', `/api/desk/${id}/resolve`, { cookie: w.owner.cookie, body: { resolution } });

  it.each([
    ['a diagnostics grant request', 'platform_grant_request'],
    ['a DevOps approval', 'devops'],
  ])('approving %s on the desk needs a fresh step-up; rejecting does not', async (_name, subkind) => {
    const approveId = await deskItem(subkind);
    await stale(w.owner.id);
    const before = await resolve(approveId, 'approved');
    expect(before.status, JSON.stringify(before.body)).toBe(403);
    expect(before.body.error.code).toBe('step_up_required');
    expect((await resolve(await deskItem(subkind), 'rejected')).body?.error?.code).not.toBe(
      'step_up_required',
    );
    await ok(w.t.req('POST', '/api/auth/step-up', { cookie: w.owner.cookie, body: { password: PASSWORD } }));
    expect((await resolve(approveId, 'approved')).body?.error?.code).not.toBe('step_up_required');
  });

  it('the one-tap approve link asks for the step-up before it spends the token', async () => {
    const { issueDeskActionToken } = await import('../src/push/desk-actions.ts');
    const id = await deskItem('platform_grant_request');
    const token = await issueDeskActionToken(w.t.app.ctx, {
      orgId: w.owner.id,
      userId: w.owner.id,
      deskItemId: id,
      action: 'approve',
    });
    await stale(w.owner.id);
    const apply = () => w.t.req('POST', `/api/m/desk/${token}/apply`, { cookie: w.owner.cookie });
    const before = await apply();
    expect(before.status, JSON.stringify(before.body)).toBe(403);
    expect(before.body.error.code).toBe('step_up_required');
    await ok(w.t.req('POST', '/api/auth/step-up', { cookie: w.owner.cookie, body: { password: PASSWORD } }));
    const after = await apply();
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(after.body.outcome).toBe('approved');
  });

  it('TikTok connect is a write: a stale super admin gets step_up_required {totp}', async () => {
    await stale(root.id);
    const r = await w.t.req('POST', '/api/platform/social/tiktok/connect', { cookie: root.cookie });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: 'step_up_required', details: { method: 'totp' } });
    // the old GET link no longer starts a sign-in
    expect(
      (await w.t.req('GET', '/api/platform/social/tiktok/connect', { cookie: root.cookie })).status,
    ).toBe(404);
  });
});
