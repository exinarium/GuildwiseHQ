import { randomUUID } from 'node:crypto';
import { NO_LIMITS, streamId } from '@aom/shared';
import { type AomApp, createApp } from '../../src/app.ts';
import type { AnthropicLike } from '../../src/assistant/service.ts';
import { hashPassword } from '../../src/auth/password.ts';
import { encryptSecret } from '../../src/auth/secrets.ts';
import { generateTotpSecret, totpCode, totpStep } from '../../src/auth/totp.ts';
import type { WriterClient } from '../../src/blog/writer/client.ts';
import { registerBuiltins } from '../../src/catalogue/boot.ts';
import { createClock } from '../../src/clock.ts';
import { loadConfig } from '../../src/config.ts';
import { q, resetDb } from './db.ts';

export const ORIGIN = 'http://aom.test';
export const PASSWORD = 'correct-horse-battery';
let cachedHash: Promise<string> | null = null;
const passwordHash = () => (cachedHash ??= hashPassword(PASSWORD));

export interface TestApp {
  app: AomApp;
  clock: ReturnType<typeof createClock>;
  /** Fastify `inject` with Origin and JSON headers applied; pass `cookie` to act as a user. */
  req(
    method: string,
    url: string,
    opts?: { cookie?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{
    status: number;
    body: any;
    headers: Record<string, any>;
    cookie?: string;
  }>;
  /** Creates a user straight through the event store (fast) and returns its id. */
  createUser(email: string, role?: 'admin' | 'member', displayName?: string): Promise<string>;
  /** A super admin account (the CLI's `superadmin:create`, straight through the event store). */
  createSuperAdmin(email: string, displayName?: string): Promise<string>;
  /** Switches two-factor login on for a user straight through the stores (no QR dance); returns the TOTP secret. */
  enableTwoFactor(userId: string): Promise<string>;
  /** A valid TOTP code for the user's secret, never one the server has already accepted. */
  totpCode(userId: string): Promise<string>;
  /** A super admin (account, two-factor on) signed in, ready for the platform routes. */
  superAdminSession(email?: string): Promise<{ id: string; email: string; cookie: string }>;
  /** A new organization owned by `ownerUserId` (its id is NOT a user id, unlike the per-user org of `createUser`). */
  createOrg(
    ownerUserId: string,
    name?: string,
    over?: { status?: 'trial' | 'active' | 'suspended' | 'cancelled' },
  ): Promise<string>;
  /** Adds an existing user to an organization as a member or admin (as an accepted invitation would). */
  addOrgMember(orgId: string, userId: string, role?: 'member' | 'admin', invitedBy?: string): Promise<void>;
  login(email: string, password?: string): Promise<string>;
  /** createUser + login. */
  userSession(
    email: string,
    role?: 'admin' | 'member',
  ): Promise<{ id: string; cookie: string; email: string }>;
  close(): Promise<void>;
}

export async function createTestApp(
  opts: {
    env?: Record<string, string>;
    reset?: boolean;
    builtins?: boolean;
    listen?: boolean;
    /** The landing-page assistant's Anthropic client (a fake; the real API is never called in tests). */
    assistantClient?: AnthropicLike | null;
    /** The blog writer's Anthropic client (a fake; the real API is never called in tests). */
    blogWriterClient?: WriterClient | null;
  } = {},
): Promise<TestApp> {
  if (opts.reset !== false) await resetDb();
  const config = loadConfig({ ...process.env, ...opts.env });
  const clock = createClock();
  const app = await createApp(config, {
    clock,
    logger: process.env.TEST_LOG ? true : false,
    background: false,
    assistantClient: opts.assistantClient ?? null,
    blogWriterClient: opts.blogWriterClient ?? null,
  });
  if (opts.builtins !== false) await registerBuiltins(app.ctx);
  if (opts.listen) await app.listen({ port: 0, host: '127.0.0.1' });
  await app.ready();

  const req: TestApp['req'] = async (method, url, o = {}) => {
    const headers: Record<string, string> = { origin: ORIGIN, ...(o.headers ?? {}) };
    if (o.cookie) headers.cookie = o.cookie;
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers,
      ...(o.body !== undefined ? { payload: o.body as object } : {}),
    });
    let body: any = res.body;
    try {
      body = res.body ? JSON.parse(res.body) : undefined;
    } catch {
      // not json
    }
    const sc = res.headers['set-cookie'];
    const raw = Array.isArray(sc) ? sc[0] : sc;
    return { status: res.statusCode, body, headers: res.headers, cookie: raw?.split(';')[0] };
  };

  const createUser: TestApp['createUser'] = async (
    email,
    role = 'member',
    displayName = email.split('@')[0] as string,
  ) => {
    const userId = randomUUID();
    const hash = await passwordHash();
    await app.ctx.store.append([
      {
        streamId: streamId.user(userId),
        event:
          role === 'admin'
            ? {
                type: 'UserBootstrapped',
                payload: { userId, email, displayName, passwordHash: hash, role: 'admin' },
              }
            : {
                type: 'InvitationAccepted',
                payload: { invitationId: randomUUID(), userId, email, displayName, passwordHash: hash, role },
              },
        actor: { kind: 'system', id: null },
        scope: { orgId: null, projectId: null, audience: 'admin' },
      },
      // Every user belongs to an organization (docs/design/organizations.md): the shape of the legacy migration,
      // an organization whose id is the user id and whose Owner is that user.
      {
        streamId: streamId.org(userId),
        event: {
          type: 'OrganizationCreated',
          payload: {
            orgId: userId,
            name: `${displayName}'s organization`,
            ownerUserId: userId,
            plan: 'founding',
            status: 'active',
            limits: NO_LIMITS,
            features: {},
            createdVia: 'cli',
          },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: userId, projectId: null, audience: 'org' },
      },
      {
        streamId: streamId.org(userId),
        event: {
          type: 'OrgMemberAdded',
          payload: { orgId: userId, userId, role: 'owner', via: 'bootstrap' },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: userId, projectId: null, audience: 'org' },
      },
      // BA routing is on for new organizations; the existing suites assert the direct flows, so test users start
      // with it off (tests of the routing turn it on through PUT /api/reporting).
      {
        streamId: streamId.user(userId),
        event: { type: 'ReportingPrefsChanged', payload: { userId, routeViaBa: false } },
        actor: { kind: 'system', id: null },
        scope: { orgId: userId, projectId: null, audience: 'org' },
      },
    ]);
    return userId;
  };
  const createSuperAdmin: TestApp['createSuperAdmin'] = async (email, displayName = 'Root') => {
    const userId = randomUUID();
    await app.ctx.store.append([
      {
        streamId: streamId.user(userId),
        event: {
          type: 'SuperAdminCreated',
          payload: { userId, email, displayName, passwordHash: await passwordHash() },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: null, projectId: null, audience: 'admin' },
      },
    ]);
    return userId;
  };
  const createOrg: TestApp['createOrg'] = async (ownerUserId, name = 'Second org', over = {}) => {
    const orgId = randomUUID();
    const scope = { orgId, projectId: null, audience: 'org' } as const;
    await app.ctx.store.append([
      {
        streamId: streamId.org(orgId),
        event: {
          type: 'OrganizationCreated',
          payload: {
            orgId,
            name,
            ownerUserId,
            plan: 'founding',
            status: over.status ?? 'active',
            limits: NO_LIMITS,
            features: {},
            createdVia: 'cli',
          },
        },
        actor: { kind: 'system', id: null },
        scope,
      },
      {
        streamId: streamId.org(orgId),
        event: {
          type: 'OrgMemberAdded',
          payload: { orgId, userId: ownerUserId, role: 'owner', via: 'bootstrap' },
        },
        actor: { kind: 'system', id: null },
        scope,
      },
    ]);
    await app.ctx.notifier.flush();
    return orgId;
  };
  const addOrgMember: TestApp['addOrgMember'] = async (orgId, userId, role = 'member', invitedBy) => {
    await app.ctx.store.append([
      {
        streamId: streamId.org(orgId),
        event: {
          type: 'OrgMemberAdded',
          payload: { orgId, userId, role, via: 'invitation', ...(invitedBy ? { invitedBy } : {}) },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId, projectId: null, audience: 'org' },
      },
    ]);
    // the DevOps engineer of the organization is hired by the membership hook, after commit
    await app.ctx.notifier.flush();
  };
  const secrets = new Map<string, string>();
  const lastStep = new Map<string, number>();
  const enableTwoFactor: TestApp['enableTwoFactor'] = async (userId) => {
    const secret = generateTotpSecret();
    await q(
      `INSERT INTO user_totp (user_id, secret_enc, confirmed_at, last_used_step, created_at) VALUES ($1,$2,now(),NULL,now())
       ON CONFLICT (user_id) DO UPDATE SET secret_enc=EXCLUDED.secret_enc, confirmed_at=now(), last_used_step=NULL`,
      [userId, await encryptSecret(app.ctx, secret)],
    );
    await app.ctx.store.append([
      {
        streamId: streamId.user(userId),
        event: { type: 'TwoFactorEnabled', payload: { userId } },
        actor: { kind: 'user', id: userId },
        scope: { orgId: null, projectId: null, audience: 'user', userId },
      },
    ]);
    secrets.set(userId, secret);
    lastStep.delete(userId);
    return secret;
  };
  const totpCodeOf: TestApp['totpCode'] = async (userId) => {
    const secret = secrets.get(userId);
    if (!secret) throw new Error('two-factor is not enabled for this user in the test');
    // the server accepts a step once, within one step of its clock: take the next free one, else move its clock
    let now = totpStep(clock.now());
    const used = lastStep.get(userId) ?? -1;
    if (used >= now + 1) {
      clock.advance(31_000);
      now = totpStep(clock.now());
    }
    const step = Math.max(now - 1, used + 1);
    lastStep.set(userId, step);
    return totpCode(secret, step);
  };
  const login: TestApp['login'] = async (email, password = PASSWORD) => {
    const r = await req('POST', '/api/auth/login', { body: { email, password } });
    if (r.status === 200 && r.body?.twoFactorRequired) {
      const u = (await q('SELECT id FROM users WHERE lower(email)=lower($1)', [email]))[0];
      const code = await totpCodeOf(u?.id as string);
      const r2 = await req('POST', '/api/auth/login/2fa', { body: { challenge: r.body.challenge, code } });
      if (r2.status !== 200 || !r2.cookie)
        throw new Error(`2fa login failed: ${r2.status} ${JSON.stringify(r2.body)}`);
      return r2.cookie;
    }
    if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.cookie;
  };
  return {
    app,
    clock,
    req,
    createUser,
    createSuperAdmin,
    enableTwoFactor,
    totpCode: totpCodeOf,
    async superAdminSession(email = uniqueEmail('root')) {
      const id = await createSuperAdmin(email);
      await enableTwoFactor(id);
      return { id, email, cookie: await login(email) };
    },
    createOrg,
    addOrgMember,
    login,
    async userSession(email, role = 'member') {
      const id = await createUser(email, role);
      return { id, email, cookie: await login(email) };
    },
    close: () => app.close(),
  };
}

export const uniqueEmail = (prefix = 'u') => `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
