import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { type AomApp, createApp } from '../../src/app.ts';
import { hashPassword } from '../../src/auth/password.ts';
import { registerBuiltins } from '../../src/catalogue/boot.ts';
import { createClock } from '../../src/clock.ts';
import { loadConfig } from '../../src/config.ts';
import { resetDb } from './db.ts';

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
  login(email: string, password?: string): Promise<string>;
  /** createUser + login. */
  userSession(
    email: string,
    role?: 'admin' | 'member',
  ): Promise<{ id: string; cookie: string; email: string }>;
  close(): Promise<void>;
}

export async function createTestApp(
  opts: { env?: Record<string, string>; reset?: boolean; builtins?: boolean; listen?: boolean } = {},
): Promise<TestApp> {
  if (opts.reset !== false) await resetDb();
  const config = loadConfig({ ...process.env, ...opts.env });
  const clock = createClock();
  const app = await createApp(config, {
    clock,
    logger: process.env.TEST_LOG ? true : false,
    background: false,
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
    ]);
    return userId;
  };
  const login: TestApp['login'] = async (email, password = PASSWORD) => {
    const r = await req('POST', '/api/auth/login', { body: { email, password } });
    if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.cookie;
  };
  return {
    app,
    clock,
    req,
    createUser,
    login,
    async userSession(email, role = 'member') {
      const id = await createUser(email, role);
      return { id, email, cookie: await login(email) };
    },
    close: () => app.close(),
  };
}

export const uniqueEmail = (prefix = 'u') => `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
