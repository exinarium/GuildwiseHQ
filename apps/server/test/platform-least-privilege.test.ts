import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownershipTransferTick } from '../src/commands/platform-transfer.ts';
import { twoFactorRecoveryTick } from '../src/commands/two-factor-recovery.ts';
import { withConfig } from '../src/config.ts';
import { effectivePin } from '../src/platform-team/pins.ts';
import { platformTeamWarnings, syncPlatformTeamDesignation } from '../src/platform-team/settings.ts';
import { createTestApp, PASSWORD, type TestApp, uniqueEmail } from './helpers/app.ts';
import { CaptureMailer } from './helpers/blog.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { singleOrgUser } from './helpers/single-org.ts';
import { ok, pairWorkstation } from './helpers/world.ts';

/**
 * R17: a compromised super admin keeps only the platform-level controls (and deactivating an organization). Every
 * extra power the investigation found is removed or gated: the platform-team designation is server config, there is no
 * 2FA reset (users recover by email with a 24 h wait), an ownership transfer needs the Owner's consent or a 7-day
 * notice, the DevOps log is counts only, simulation tools only on organizations created as one, and feature and
 * notification-address changes are announced.
 */

// The sign-in protection is W1's; here it is forced to lock so the recovery start is shown to go through it.
const guard = vi.hoisted(() => ({ lock: false }));
vi.mock('../src/auth/login-guard.ts', async (orig) => {
  const real = await orig<typeof import('../src/auth/login-guard.ts')>();
  return {
    ...real,
    checkLoginGuard: async (...args: Parameters<typeof real.checkLoginGuard>) =>
      guard.lock ? { locked: true, scope: 'account', retryAfterSec: 900 } : real.checkLoginGuard(...args),
  };
});

let t: TestApp;
let mail: CaptureMailer;
let root: { id: string; email: string; cookie: string };
const DAY = 86_400_000;

beforeAll(async () => {
  t = await createTestApp();
  mail = new CaptureMailer();
  t.app.ctx.mailer = mail;
  root = await t.superAdminSession();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});
beforeEach(() => {
  mail.sent = [];
  guard.lock = false;
});

const as = (cookie: string, method: string, url: string, body?: unknown, org?: string) =>
  t.req(method, url, { cookie, body, ...(org ? { headers: { 'x-aom-org': org } } : {}) });
const sa = (method: string, url: string, body?: unknown) => as(root.cookie, method, url, body);
const mailsTo = (addr: string) => mail.to(addr);
const textOf = (m: { text?: string; html?: string }) => `${m.text ?? ''}\n${m.html ?? ''}`;
const setTeamEnv = (orgId: string | undefined, projectId: string | undefined) => {
  t.app.ctx.config = withConfig(t.app.ctx.config, { platformTeam: { orgId, projectId } });
};
const newProject = async (cookie: string, key: string, org?: string) =>
  (await ok<any>(as(cookie, 'POST', '/api/projects', { key, name: key }, org), 201)).project.id as string;
const uniqueKey = (p: string) => `${p}${Math.floor(Math.random() * 1e5)}`;

/** A user whose own organization is cancelled: a plain member somewhere else, owner of nothing running. */
async function memberOnly(email = uniqueEmail('member')) {
  const s = await t.userSession(email);
  await q(`UPDATE organizations SET status='cancelled' WHERE id=$1`, [s.id]);
  return s;
}

// ------------------------------------------------------------------------------------------- R17-1 designation

describe('the platform team designation is server config', () => {
  let owner: { id: string; email: string; cookie: string };
  let projectId: string;

  beforeAll(async () => {
    owner = await t.userSession(uniqueEmail('plat-owner'));
    projectId = await newProject(owner.cookie, uniqueKey('PL'));
  });

  it('PUT /api/platform/team is gone (404); the GET is read-only and shows the source', async () => {
    expect((await sa('PUT', '/api/platform/team', { orgId: owner.id, projectId })).status).toBe(404);
    expect((await sa('PUT', '/api/platform/team', { orgId: null })).status).toBe(404);
  });

  it('comes from AOM_PLATFORM_TEAM_ORG_ID / _PROJECT_ID, with the project kept at project level and audited', async () => {
    setTeamEnv(owner.id, projectId);
    expect(await syncPlatformTeamDesignation(t.app.ctx)).toBe(true);
    expect(await syncPlatformTeamDesignation(t.app.ctx)).toBe(false); // idempotent
    const s = await ok<any>(sa('GET', '/api/platform/team'));
    expect(s).toMatchObject({ orgId: owner.id, projectId, source: 'env' });
    expect(
      (await q('SELECT decisions_project_only FROM projects WHERE id=$1', [projectId]))[0],
    ).toMatchObject({
      decisions_project_only: true,
    });
    const audit = await q(
      `SELECT summary FROM platform_audit_log WHERE action='PlatformTeamDesignated' ORDER BY seq DESC LIMIT 1`,
    );
    expect(audit[0]?.summary).toContain('(server config)');
    expect(await platformTeamWarnings(t.app.ctx)).toEqual([]);
  });

  it('unsetting the env clears an env designation', async () => {
    setTeamEnv(undefined, undefined);
    expect(await syncPlatformTeamDesignation(t.app.ctx)).toBe(true);
    expect((await ok<any>(sa('GET', '/api/platform/team'))).orgId).toBeNull();
  });

  it('a legacy designation (self-hosted upgrade) keeps working read-only, with a warning; env replaces it', async () => {
    await q(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('platform.team', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ orgId: owner.id, projectId })],
    );
    expect(await syncPlatformTeamDesignation(t.app.ctx)).toBe(false);
    expect(await ok<any>(sa('GET', '/api/platform/team'))).toMatchObject({
      orgId: owner.id,
      source: 'legacy',
    });
    const warnings = await platformTeamWarnings(t.app.ctx);
    expect(warnings.join(' ')).toMatch(/read-only: set AOM_PLATFORM_TEAM_ORG_ID/);
    setTeamEnv(owner.id, undefined);
    expect((await platformTeamWarnings(t.app.ctx)).join(' ')).toMatch(/Only one of/);
    // an env designation that cannot be applied is said out loud, and the legacy one stays in force meanwhile
    const stranger = await t.userSession(uniqueEmail('stranger'));
    const strangerProject = await newProject(stranger.cookie, uniqueKey('ST'));
    setTeamEnv(owner.id, strangerProject);
    expect(await syncPlatformTeamDesignation(t.app.ctx)).toBe(false);
    expect((await platformTeamWarnings(t.app.ctx)).join(' ')).toMatch(
      /not applied: the project belongs to another organization\. Until it is, the earlier designation stays in force/,
    );
    setTeamEnv(owner.id, projectId);
    expect(await syncPlatformTeamDesignation(t.app.ctx)).toBe(true);
    expect((await ok<any>(sa('GET', '/api/platform/team'))).source).toBe('env');
  });

  it('the super admin has no access to the platform-team routes (bugs, pauses, pins, deploy policy)', async () => {
    setTeamEnv(owner.id, projectId);
    await syncPlatformTeamDesignation(t.app.ctx);
    for (const [method, url, body] of [
      ['GET', '/api/platform-team/overview'],
      ['GET', '/api/platform-team/bugs'],
      ['GET', '/api/platform-team/runner-pins'],
      ['POST', '/api/platform-team/pauses', { projectId, reason: 'pause a client' }],
      ['PUT', '/api/platform-team/runner-pin', { workstationId: null, version: null }],
      ['POST', '/api/platform-team/deploy/check', { version: '9.9.9', changedFiles: [] }],
    ] as Array<[string, string, unknown?]>)
      expect((await sa(method, url, body)).status, `${method} ${url}`).toBe(404);
    // the platform org's Owner still reads it
    expect((await as(owner.cookie, 'GET', '/api/platform-team/overview')).status).toBe(200);
  });
});

// ------------------------------------------------------------------------------------- R17-1 pins and pauses

describe('a platform-team manager acts only inside the platform organization', () => {
  let manager: { id: string; email: string; cookie: string };
  let outsider: { id: string; email: string; cookie: string };
  let platformProject: string;
  let ownProject: string;
  let clientProject: string;
  let ownWs: string;
  let clientWs: string;

  beforeAll(async () => {
    manager = await t.userSession(uniqueEmail('manager'));
    outsider = await t.userSession(uniqueEmail('client'));
    platformProject = await newProject(manager.cookie, uniqueKey('PT'));
    ownProject = await newProject(manager.cookie, uniqueKey('OW'));
    clientProject = await newProject(outsider.cookie, uniqueKey('CL'));
    ownWs = (await pairWorkstation(t, manager, 'Platform desk')).workstationId;
    clientWs = (await pairWorkstation(t, outsider, 'Client desk')).workstationId;
    setTeamEnv(manager.id, platformProject);
    await syncPlatformTeamDesignation(t.app.ctx);
  });

  it('cannot pause a client project, a client workstation, or a workflow across all organizations', async () => {
    for (const body of [
      { projectId: clientProject, reason: 'competitor' },
      { workstationId: clientWs, reason: 'competitor' },
      { workflowKey: 'code', reason: 'everyone' },
    ]) {
      const r = await as(manager.cookie, 'POST', '/api/platform-team/pauses', body);
      expect(r.status, JSON.stringify(body)).toBe(403);
      expect(r.body.error.code).toBe('outside_platform_org');
    }
    expect((await q('SELECT count(*)::int AS n FROM platform_pauses WHERE resumed_at IS NULL'))[0]?.n).toBe(
      0,
    );
  });

  it('pauses its own organization’s projects and workstations', async () => {
    const r = await ok<any>(
      as(manager.cookie, 'POST', '/api/platform-team/pauses', {
        projectId: ownProject,
        reason: 'bad release',
      }),
    );
    expect(r.created).toBe(true);
    await ok(
      as(manager.cookie, 'POST', '/api/platform-team/pauses', { workstationId: ownWs, reason: 'flaky' }),
    );
  });

  it('cannot pin a client workstation; an all-workstations pin never reaches one', async () => {
    const r = await as(manager.cookie, 'PUT', '/api/platform-team/runner-pin', {
      workstationId: clientWs,
      version: null,
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('outside_platform_org');
    await ok(
      as(manager.cookie, 'PUT', '/api/platform-team/runner-pin', { workstationId: ownWs, version: null }),
    );
    await q(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('runners.version_pin', '{"version":"0.0.1"}'::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    await q(
      `INSERT INTO workstation_runner_pins (workstation_id, version, pinned_at) VALUES ($1, '0.0.1', now())
       ON CONFLICT (workstation_id) DO NOTHING`,
      [clientWs],
    );
    expect(await effectivePin(t.app.ctx.pool, ownWs)).toMatchObject({ version: '0.0.1', scope: 'all' });
    expect(await effectivePin(t.app.ctx.pool, clientWs)).toBeNull();
    await q(`DELETE FROM platform_settings WHERE key='runners.version_pin'`);
  });
});

// ---------------------------------------------------------------------------------------- R17-2 recovery

async function challengeFor(email: string): Promise<string> {
  const r = await ok<any>(t.req('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
  expect(r.twoFactorRequired).toBe(true);
  return r.challenge as string;
}
const tokenFrom = (m: { text?: string; html?: string }) => {
  const x = /\/recover-2fa#([A-Za-z0-9_-]{16,})/.exec(textOf(m));
  if (!x) throw new Error('no recovery link in the mail');
  return x[1] as string;
};
const twoFactorOn = async (id: string) =>
  (await q('SELECT two_factor_enabled FROM users WHERE id=$1', [id]))[0]?.two_factor_enabled as boolean;

describe('there is no super-admin 2FA reset', () => {
  it('POST /api/platform/users/:id/reset-two-factor gives 404 and leaves 2FA on', async () => {
    const u = await t.userSession(uniqueEmail('victim'));
    await t.enableTwoFactor(u.id);
    expect((await sa('POST', `/api/platform/users/${u.id}/reset-two-factor`, {})).status).toBe(404);
    expect(await twoFactorOn(u.id)).toBe(true);
  });
});

describe('"Lost your authenticator?": the user’s own recovery by email with a 24 h wait', () => {
  let orgOwner: { id: string; email: string; cookie: string };
  let orgId: string;

  beforeAll(async () => {
    orgOwner = await t.userSession(uniqueEmail('boss'));
    orgId = await t.createOrg(orgOwner.id, 'Recovery Co');
  });

  it('needs the password first, then the mailed link; 2FA goes 24 h after confirming; Owners are mailed', async () => {
    const u = await memberOnly(uniqueEmail('lost'));
    await t.addOrgMember(orgId, u.id);
    await t.enableTwoFactor(u.id);
    // a made-up challenge (no right password) does nothing
    expect(
      (await t.req('POST', '/api/auth/2fa/recovery/start', { body: { challenge: 'x'.repeat(43) } })).status,
    ).toBe(401);
    const start = await ok<any>(
      t.req('POST', '/api/auth/2fa/recovery/start', { body: { challenge: await challengeFor(u.email) } }),
    );
    expect(start).toEqual({ state: 'awaiting_confirmation', effectiveAt: null });
    const token = tokenFrom(mailsTo(u.email).at(-1)!);
    expect(mailsTo(orgOwner.email)).toHaveLength(0); // nothing yet: not confirmed
    mail.sent = [];

    const confirmed = await ok<any>(t.req('POST', '/api/auth/2fa/recovery/confirm', { body: { token } }));
    expect(confirmed.state).toBe('waiting');
    const wait = new Date(confirmed.effectiveAt).getTime() - t.clock.now().getTime();
    expect(wait).toBeGreaterThan(DAY - 60_000);
    expect(wait).toBeLessThanOrEqual(DAY);
    expect(mailsTo(u.email)).toHaveLength(1);
    expect(mailsTo(orgOwner.email)).toHaveLength(1);
    expect(textOf(mailsTo(orgOwner.email)[0]!)).toContain(u.email);
    expect(mailsTo(root.email)).toHaveLength(0); // not an Owner: the super admins are not mailed
    expect((await t.req('POST', '/api/auth/2fa/recovery/confirm', { body: { token } })).status).toBe(409);

    await twoFactorRecoveryTick(t.app.ctx);
    expect(await twoFactorOn(u.id)).toBe(true); // still waiting
    mail.sent = [];
    t.clock.advance(DAY + 1000);
    try {
      expect(await twoFactorRecoveryTick(t.app.ctx)).toContain(u.id);
    } finally {
      t.clock.advance(-(DAY + 1000));
    }
    expect(await twoFactorOn(u.id)).toBe(false);
    const ev = await q(
      `SELECT payload FROM events WHERE type='TwoFactorDisabled' AND payload->>'userId'=$1 ORDER BY seq DESC LIMIT 1`,
      [u.id],
    );
    expect(ev[0]?.payload).toMatchObject({ reason: 'reset', by: u.id });
    expect((await q('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id=$1', [u.id]))[0]?.n).toBe(0);
    expect(mailsTo(u.email)).toHaveLength(1);
    expect(mailsTo(orgOwner.email)).toHaveLength(1);
    expect((await ok<any>(t.req('POST', '/api/auth/2fa/recovery/status', { body: { token } }))).state).toBe(
      'done',
    );
  });

  it('is cancelled by a sign-in with a code during the wait, and from the link in the mail', async () => {
    const u = await memberOnly(uniqueEmail('found'));
    await t.enableTwoFactor(u.id);
    await ok(
      t.req('POST', '/api/auth/2fa/recovery/start', { body: { challenge: await challengeFor(u.email) } }),
    );
    const token = tokenFrom(mailsTo(u.email).at(-1)!);
    await ok(t.req('POST', '/api/auth/2fa/recovery/confirm', { body: { token } }));
    // the authenticator turns up: a normal two-factor sign-in
    await ok(
      t.req('POST', '/api/auth/login/2fa', {
        body: { challenge: await challengeFor(u.email), code: await t.totpCode(u.id) },
      }),
    );
    expect((await ok<any>(t.req('POST', '/api/auth/2fa/recovery/status', { body: { token } }))).state).toBe(
      'cancelled',
    );
    t.clock.advance(DAY + 1000);
    try {
      expect(await twoFactorRecoveryTick(t.app.ctx)).toEqual([]);
    } finally {
      t.clock.advance(-(DAY + 1000));
    }
    expect(await twoFactorOn(u.id)).toBe(true);

    await ok(
      t.req('POST', '/api/auth/2fa/recovery/start', { body: { challenge: await challengeFor(u.email) } }),
    );
    const second = tokenFrom(mailsTo(u.email).at(-1)!);
    expect(
      (await ok<any>(t.req('POST', '/api/auth/2fa/recovery/cancel', { body: { token: second } }))).state,
    ).toBe('cancelled');
  });

  it('refuses super admins (server console only)', async () => {
    const r = await t.req('POST', '/api/auth/2fa/recovery/start', {
      body: { challenge: await challengeFor(root.email) },
    });
    expect(r.status).toBe(403);
    expect(mailsTo(root.email)).toHaveLength(0);
  });

  it('goes through the sign-in protection: a locked account gets 429 and a `locked` row', async () => {
    const u = await memberOnly(uniqueEmail('locked'));
    await t.enableTwoFactor(u.id);
    const challenge = await challengeFor(u.email);
    guard.lock = true;
    const r = await t.req('POST', '/api/auth/2fa/recovery/start', { body: { challenge } });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('too_many_attempts');
    expect(
      (
        await q(`SELECT count(*)::int AS n FROM login_failures WHERE user_id=$1 AND reason='locked'`, [u.id])
      )[0]?.n,
    ).toBe(1);
    expect(mailsTo(u.email)).toHaveLength(0);
  });

  it('mails every super admin when an organization Owner confirms a recovery', async () => {
    const u = await t.userSession(uniqueEmail('owner-lost')); // owns their own organization
    await t.enableTwoFactor(u.id);
    await ok(
      t.req('POST', '/api/auth/2fa/recovery/start', { body: { challenge: await challengeFor(u.email) } }),
    );
    await ok(
      t.req('POST', '/api/auth/2fa/recovery/confirm', {
        body: { token: tokenFrom(mailsTo(u.email).at(-1)!) },
      }),
    );
    expect(mailsTo(root.email)).toHaveLength(1);
    expect(textOf(mailsTo(root.email)[0]!)).toContain(u.email);
  });

  it('the Owner’s reset of a member is never instant: it waits 24 h and the member can cancel it', async () => {
    // no access in any other organization (not even a cancelled personal one), so R6 does not refuse the reset
    const u = await singleOrgUser(t, uniqueEmail('reset-me'));
    await t.addOrgMember(orgId, u.id);
    await t.enableTwoFactor(u.id);
    await ok(as(orgOwner.cookie, 'POST', `/api/org/members/${u.id}/reset-two-factor`, {}, orgId));
    expect(await twoFactorOn(u.id)).toBe(true);
    const token = tokenFrom(mailsTo(u.email).at(-1)!);
    expect((await ok<any>(t.req('POST', '/api/auth/2fa/recovery/status', { body: { token } }))).state).toBe(
      'waiting',
    );
    t.clock.advance(DAY + 1000);
    try {
      expect(await twoFactorRecoveryTick(t.app.ctx)).toContain(u.id);
    } finally {
      t.clock.advance(-(DAY + 1000));
    }
    expect(await twoFactorOn(u.id)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------- R17-3 ownership transfer

describe('a platform ownership transfer waits for the Owner', () => {
  async function orgWithAdmin(name: string) {
    const owner = await t.userSession(uniqueEmail('owner'));
    const admin = await t.userSession(uniqueEmail('admin'));
    const orgId = await t.createOrg(owner.id, name);
    await t.addOrgMember(orgId, admin.id, 'admin');
    return { owner, admin, orgId };
  }
  const ownerOf = async (orgId: string) =>
    (await q('SELECT owner_user_id FROM organizations WHERE id=$1', [orgId]))[0]?.owner_user_id as string;
  const request = (orgId: string, toUserId: string) =>
    ok<any>(
      sa('POST', `/api/platform/orgs/${orgId}/transfer-ownership`, { toUserId, reason: 'support case 42' }),
      202,
    );
  const transferLink = (m: { text?: string; html?: string }) => {
    const x = /\/org-transfer\/([0-9a-f-]{36})/.exec(textOf(m));
    if (!x) throw new Error('no transfer link');
    return x[1] as string;
  };

  it('is pending: nothing moves, the Owner gets an approve-or-veto link and every Admin is mailed', async () => {
    const { owner, admin, orgId } = await orgWithAdmin('Pending Co');
    const detail = await request(orgId, admin.id);
    expect(detail.pendingTransfer).toMatchObject({
      toUser: { id: admin.id },
      automatic: true,
      decision: null,
    });
    expect(await ownerOf(orgId)).toBe(owner.id);
    expect(transferLink(mailsTo(owner.email).at(-1)!)).toBe(detail.pendingTransfer.id);
    expect(mailsTo(admin.email)).toHaveLength(1);
    // only the Owner sees the consent page
    expect(
      (await as(admin.cookie, 'GET', `/api/org/ownership-transfers/${detail.pendingTransfer.id}`)).status,
    ).toBe(404);
  });

  it('the Owner approves (with step-up), and the reason is in the audit log', async () => {
    const { owner, admin, orgId } = await orgWithAdmin('Approve Co');
    const id = (await request(orgId, admin.id)).pendingTransfer.id;
    t.clock.advance(11 * 60_000); // the sign-in's second factor is no longer fresh
    try {
      const stale = await as(owner.cookie, 'POST', `/api/org/ownership-transfers/${id}/approve`);
      expect(stale.status).toBe(403);
      expect(stale.body.error.code).toBe('step_up_required');
      await ok(as(owner.cookie, 'POST', '/api/auth/step-up', { password: PASSWORD }));
      const r = await ok<any>(as(owner.cookie, 'POST', `/api/org/ownership-transfers/${id}/approve`));
      expect(r.decision).toBe('approved');
    } finally {
      t.clock.advance(-11 * 60_000);
    }
    expect(await ownerOf(orgId)).toBe(admin.id);
    const audit = await q(
      `SELECT summary FROM platform_audit_log WHERE action='OrgOwnershipTransferred' AND org_id=$1`,
      [orgId],
    );
    expect(audit[0]?.summary).toContain('support case 42');
  });

  it('the Owner vetoes: nothing moves, not even after 7 days', async () => {
    const { owner, admin, orgId } = await orgWithAdmin('Veto Co');
    const id = (await request(orgId, admin.id)).pendingTransfer.id;
    expect(
      (await ok<any>(as(owner.cookie, 'POST', `/api/org/ownership-transfers/${id}/veto`))).decision,
    ).toBe('vetoed');
    t.clock.advance(8 * DAY);
    try {
      expect(await ownershipTransferTick(t.app.ctx)).not.toContain(id);
    } finally {
      t.clock.advance(-8 * DAY);
    }
    expect(await ownerOf(orgId)).toBe(owner.id);
  });

  it('takes effect by itself after the 7-day notice', async () => {
    const { owner, admin, orgId } = await orgWithAdmin('Notice Co');
    const id = (await request(orgId, admin.id)).pendingTransfer.id;
    t.clock.advance(6 * DAY);
    try {
      expect(await ownershipTransferTick(t.app.ctx)).not.toContain(id);
    } finally {
      t.clock.advance(-6 * DAY);
    }
    expect(await ownerOf(orgId)).toBe(owner.id);
    t.clock.advance(7 * DAY + 1000);
    try {
      expect(await ownershipTransferTick(t.app.ctx)).toContain(id);
    } finally {
      t.clock.advance(-(7 * DAY + 1000));
    }
    expect(await ownerOf(orgId)).toBe(admin.id);
  });

  it('never takes effect by itself for an organization with deploy targets, until re-requested after the Owner is deactivated', async () => {
    // the owner's own organization (its id is the owner's user id)
    const owner = await t.userSession(uniqueEmail('deploy-owner'));
    const admin = await t.userSession(uniqueEmail('deploy-admin'));
    const orgId = owner.id;
    await t.addOrgMember(orgId, admin.id, 'admin');
    const projectId = await newProject(owner.cookie, uniqueKey('DT'));
    await q(
      `INSERT INTO deploy_targets (id, org_id, project_id, name, kind, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'staging', 'local_docker', $4, now(), now())`,
      [randomUUID(), orgId, projectId, owner.id],
    );
    const first = (await request(orgId, admin.id)).pendingTransfer;
    expect(first.automatic).toBe(false);
    expect(textOf(mailsTo(owner.email).at(-1)!)).toContain('Only when the Owner approves it');
    t.clock.advance(8 * DAY);
    try {
      expect(await ownershipTransferTick(t.app.ctx)).toEqual([]);
    } finally {
      t.clock.advance(-8 * DAY);
    }
    expect(await ownerOf(orgId)).toBe(owner.id);

    // the Owner is gone: suspend the organization, deactivate the account, then ask again
    await ok(sa('POST', `/api/platform/orgs/${orgId}/suspend`, { reason: 'owner unreachable' }));
    await ok(sa('PATCH', `/api/platform/users/${owner.id}`, { status: 'deactivated' }));
    t.clock.advance(1000);
    try {
      mail.sent = [];
      const again = (await request(orgId, admin.id)).pendingTransfer;
      expect(again.automatic).toBe(true);
      // the deactivated Owner still hears of it at the old address, without an approve link
      expect(mailsTo(owner.email)).toHaveLength(1);
      expect(textOf(mailsTo(owner.email)[0]!)).not.toContain('/org-transfer/');
      t.clock.advance(7 * DAY + 1000);
      try {
        expect(await ownershipTransferTick(t.app.ctx)).toContain(again.id);
      } finally {
        t.clock.advance(-(7 * DAY + 1000));
      }
    } finally {
      t.clock.advance(-1000);
    }
    expect(await ownerOf(orgId)).toBe(admin.id);
  });

  const decisionOf = async (id: string) =>
    (await q('SELECT decision FROM org_ownership_transfers WHERE id=$1', [id]))[0]?.decision as string | null;

  it('is void when the Owner changed since the request: the new Owner never consented', async () => {
    const { owner, admin, orgId } = await orgWithAdmin('Changed Co');
    const other = await t.userSession(uniqueEmail('new-owner'));
    await t.addOrgMember(orgId, other.id, 'admin');
    const id = (await request(orgId, admin.id)).pendingTransfer.id;
    // the Owner hands the organization to someone else himself (password confirmed) and never vetoes
    await ok(
      as(
        owner.cookie,
        'POST',
        '/api/org/transfer-ownership',
        { userId: other.id, password: PASSWORD },
        orgId,
      ),
    );
    expect(await ownerOf(orgId)).toBe(other.id);
    t.clock.advance(8 * DAY);
    try {
      expect(await ownershipTransferTick(t.app.ctx)).not.toContain(id);
    } finally {
      t.clock.advance(-8 * DAY);
    }
    expect(await ownerOf(orgId)).toBe(other.id);
    expect(await decisionOf(id)).toBe('void');
  });

  it('expires after 30 days when it could never take effect by itself', async () => {
    const owner = await t.userSession(uniqueEmail('slow-owner'));
    const admin = await t.userSession(uniqueEmail('slow-admin'));
    await t.addOrgMember(owner.id, admin.id, 'admin');
    const projectId = await newProject(owner.cookie, uniqueKey('EX'));
    await q(
      `INSERT INTO deploy_targets (id, org_id, project_id, name, kind, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'prod', 'local_docker', $4, now(), now())`,
      [randomUUID(), owner.id, projectId, owner.id],
    );
    const id = (await request(owner.id, admin.id)).pendingTransfer.id;
    t.clock.advance(31 * DAY);
    try {
      const cookie = await t.login(owner.email); // a fresh sign-in (the old session has run out), so step-up is fresh
      const late = await as(cookie, 'POST', `/api/org/ownership-transfers/${id}/approve`);
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe('transfer_expired');
      expect(await ownershipTransferTick(t.app.ctx)).not.toContain(id);
    } finally {
      t.clock.advance(-31 * DAY);
    }
    expect(await decisionOf(id)).toBe('expired');
    expect(await ownerOf(owner.id)).toBe(owner.id);
  });
});

// ------------------------------------------------------------------------------------------ R17-4 telemetry

describe('DevOps commands and runner errors: counts for the platform, detail for the Owners', () => {
  let owner: { id: string; email: string; cookie: string };
  let other: { id: string; email: string; cookie: string };
  let ws: string;

  beforeAll(async () => {
    owner = await t.userSession(uniqueEmail('dev-owner'));
    other = await t.userSession(uniqueEmail('dev-other'));
    ws = (await pairWorkstation(t, owner, 'DevOps box')).workstationId;
    const agent = randomUUID();
    const shift = randomUUID();
    await q(
      `INSERT INTO agents (id, org_id, hired_by_user_id, manager_user_id, workstation_id, name, role_key, role_version,
                           seniority, runtime, model, status, hired_at, avatar_seed)
       VALUES ($1, $2, $2, $2, $3, 'Dev', 'devops', 1, 'senior', 'mock', 'mock', 'active', now(), 'dev')`,
      [agent, owner.id, ws],
    );
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at)
       VALUES ($1, $2, $3, $4, 'chat', 'running', 'mock', 'mock', now())`,
      [shift, owner.id, agent, ws],
    );
    await q(
      `INSERT INTO devops_audit (workstation_id, at, session_ref, kind, decision, rule, command) VALUES
         ($1, now(), $2, 'shift', 'allowed', 'git', 'ssh deploy@secret-host.internal ./release.sh'),
         ($1, now(), $2, 'shift', 'refused', 'rm', 'rm -rf /srv/app'),
         ($1, now(), 'chat-1', 'chat', 'allowed', 'ls', 'ls /home/dev/private')`,
      [ws, shift],
    );
    await q(
      `INSERT INTO runner_errors (signature, message, stack, context, first_version, last_version, last_workstation_id,
                                  first_seen_at, last_seen_at)
       VALUES ('sig-1', 'ENOENT /home/dev/clients/acme/.env', $1, 'deploy acme', '0.1.0', '0.1.1', $2, now(), now())
       ON CONFLICT (signature) DO NOTHING`,
      [
        [
          'Error: ENOENT /home/dev/clients/acme/.env',
          '    at readEnv (/home/dev/.guildwise/runner/dist/deploy/env.js:12:7)',
          '    at /home/dev/clients/acme/scripts/hook.js:1:1',
          '    at async run (file:///opt/guildwise/src/deploy/run.ts:40:3)',
          '    at node:internal/process/task_queues:95:5',
        ].join('\n'),
        ws,
      ],
    );
  });

  it('GET /api/platform/devops-audit returns counts per version and platform only', async () => {
    const r = await ok<any>(sa('GET', '/api/platform/devops-audit'));
    const raw = JSON.stringify(r);
    expect(raw).not.toMatch(/secret-host|rm -rf|private|command/);
    const row = r.counts.find((c: any) => c.platform === 'linux');
    expect(row).toMatchObject({ total: 3, refused: 1, workstations: 1 });
  });

  it('GET /api/platform/runner-errors has no message, stack or context; only checked frames', async () => {
    const r = await ok<any>(sa('GET', '/api/platform/runner-errors'));
    const e = r.errors.find((x: any) => x.signature === 'sig-1');
    expect(e).toBeDefined();
    expect(JSON.stringify(r)).not.toMatch(/acme|\/home\/dev|ENOENT/);
    expect(e.message).toBeUndefined();
    expect(e.stack).toBeUndefined();
    expect(e.topFrames).toEqual([
      'at readEnv (dist/deploy/env.js:12:7)',
      'at async run (src/deploy/run.ts:40:3)',
      'at (node:internal/process/task_queues:95:5)',
    ]);
  });

  it('the workstation owner reads the full log of the machine; anyone else gets 404', async () => {
    const r = await ok<any>(as(owner.cookie, 'GET', `/api/workstations/${ws}/devops-audit`));
    expect(r.entries.map((e: any) => e.command)).toEqual(
      expect.arrayContaining(['rm -rf /srv/app', 'ls /home/dev/private']),
    );
    expect((await as(other.cookie, 'GET', `/api/workstations/${ws}/devops-audit`)).status).toBe(404);
    expect((await sa('GET', `/api/workstations/${ws}/devops-audit`)).status).not.toBe(200);
  });

  it('the organization Owner reads the commands of its DevOps shifts; an Admin gets 404', async () => {
    const r = await ok<any>(as(owner.cookie, 'GET', '/api/org/devops-audit', undefined, owner.id));
    expect(r.entries.map((e: any) => e.command).sort()).toEqual([
      'rm -rf /srv/app',
      'ssh deploy@secret-host.internal ./release.sh',
    ]);
    await t.addOrgMember(owner.id, other.id, 'admin');
    expect((await as(other.cookie, 'GET', '/api/org/devops-audit', undefined, owner.id)).status).toBe(404);
    expect((await sa('GET', '/api/org/devops-audit')).status).not.toBe(200);
  });
});

// ------------------------------------------------------------------------------------------ R17-5 simulation

describe('simulation tools only on organizations created as one', () => {
  it('a real organization is refused: switching on, pace, wipe and the demo scenario', async () => {
    const owner = await t.userSession(uniqueEmail('real'));
    const orgId = await t.createOrg(owner.id, 'Real Co');
    const sim = await sa('PUT', `/api/platform/orgs/${orgId}/simulation`, { enabled: true });
    expect(sim.status).toBe(409);
    expect(sim.body.error.code).toBe('not_created_as_simulation');
    expect((await sa('POST', `/api/platform/orgs/${orgId}/demo-scenario`, {})).body.error.code).toBe(
      'not_created_as_simulation',
    );
    // even an organization flagged as simulation later (the old path) is not wiped
    await q(`UPDATE organizations SET simulation=true WHERE id=$1`, [orgId]);
    const wipe = await sa('POST', `/api/platform/orgs/${orgId}/wipe-simulation`, { confirmName: 'Real Co' });
    expect(wipe.status).toBe(409);
    expect(wipe.body.error.code).toBe('not_created_as_simulation');
    expect((await q('SELECT 1 FROM organizations WHERE id=$1', [orgId])).length).toBe(1);
    const detail = await ok<any>(sa('GET', `/api/platform/orgs/${orgId}`));
    expect(detail.createdAsSimulation).toBe(false);
  });
});

// --------------------------------------------------------------------------------- R17-6 and R17-7 notices

describe('feature and notification-address changes are announced', () => {
  it('a feature override gives the Owner a desk item and a mail naming the change', async () => {
    const owner = await t.userSession(uniqueEmail('feat'));
    const orgId = await t.createOrg(owner.id, 'Feature Co');
    await ok(
      sa('PATCH', `/api/platform/orgs/${orgId}`, {
        features: { browserTools: true },
        note: 'trial of browser tools',
      }),
    );
    const desk = await q(`SELECT title, addressee_user_id FROM desk_items WHERE org_id=$1 AND subkind=$2`, [
      orgId,
      'platform_feature_override',
    ]);
    expect(desk).toHaveLength(1);
    expect(desk[0]?.title).toContain('browserTools on');
    expect(desk[0]?.addressee_user_id).toBe(owner.id);
    expect(mailsTo(owner.email)).toHaveLength(1);
    expect(textOf(mailsTo(owner.email)[0]!)).toContain('trial of browser tools');
    // repeating the same value announces nothing new
    mail.sent = [];
    await ok(sa('PATCH', `/api/platform/orgs/${orgId}`, { features: { browserTools: true }, note: 'again' }));
    expect(mailsTo(owner.email)).toHaveLength(0);
  });

  it('changing the support or Contact us address mails the old addresses', async () => {
    const old = uniqueEmail('old-support');
    const next = uniqueEmail('new-support');
    await ok(sa('PATCH', '/api/platform/settings', { supportEmail: old }));
    mail.sent = [];
    await ok(sa('PATCH', '/api/platform/settings', { supportEmail: next }));
    expect(mailsTo(old)).toHaveLength(1);
    expect(textOf(mailsTo(old)[0]!)).toContain(next);
    expect(mailsTo(next)).toHaveLength(0);
    mail.sent = [];
    await ok(sa('PATCH', '/api/platform/settings', { supportEmail: next }));
    expect(mailsTo(next)).toHaveLength(0); // unchanged: nothing sent
    const contact = uniqueEmail('contact');
    await ok(sa('PATCH', '/api/platform/settings', { contactEmail: contact }));
    expect(mailsTo(next)).toHaveLength(1); // Contact us used to fall back to the support address
  });
});
