import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AppCommandResultSchema, AppIdentitySchema } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { summarizeToolInput } from '../src/adapters/claude-stream-parser.ts';
import { AppTokenBroker, REFRESH_MARGIN_MS, scopeKey } from '../src/apps/broker.ts';
import { classifyGitHubError, parseAppPrivateKey, signAppJwt } from '../src/apps/github-app.ts';
import { AppKeyStore, pemSecrets } from '../src/apps/store.ts';
import { AppTokenError, type StoredApp } from '../src/apps/types.ts';
import { AuditLog } from '../src/integrations/audit-log.ts';
import { AutomatedAppIntegration } from '../src/integrations/automated-app.ts';
import { buildIntegrationAdapters } from '../src/integrations/index.ts';
import type { AdapterEnv } from '../src/integrations/types.ts';
import { createLogger } from '../src/log.ts';
import { redactSecrets } from '../src/redact.ts';
import { redact, unregisterSecret } from '../src/secrets/redact.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

// Generated per run: no private key is ever committed.
const { privateKey: KEY_OBJ, publicKey: PUB } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM_PKCS1 = KEY_OBJ.export({ type: 'pkcs1', format: 'pem' }).toString();
const PEM_PKCS8 = KEY_OBJ.export({ type: 'pkcs8', format: 'pem' }).toString();
const sealKey = () => Buffer.alloc(32, 9);
const MIN = 60_000;
const T0 = Date.parse('2026-11-14T12:00:00Z');

afterEach(() => {
  for (const s of pemSecrets(PEM_PKCS1)) unregisterSecret(s);
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A recorded-shape GitHub: GET /app, GET /app/installations[/id], POST access_tokens, GET /users/<slug>[bot]. */
function fakeGitHub(
  opts: {
    clock?: () => number;
    installations?: Array<{ id: number; login: string }>;
    app?: (req: Request) => Response | undefined;
    mint?: (n: number) => Response | undefined;
    installation?: () => Response | undefined;
  } = {},
) {
  const calls: Array<{ method: string; path: string; auth: string; body?: unknown }> = [];
  let mints = 0;
  const clock = opts.clock ?? (() => T0);
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const auth = String((init.headers as Record<string, string>).Authorization ?? '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, auth, body });
    if (u.pathname === '/app') return opts.app?.(new Request(url)) ?? json(200, { id: 4242, slug: 'guild-bot', name: 'Guild Bot' });
    if (u.pathname === '/app/installations')
      return json(
        200,
        (opts.installations ?? [{ id: 777, login: 'acme' }]).map((i) => ({
          id: i.id,
          account: { login: i.login, type: 'Organization' },
          suspended_at: null,
        })),
      );
    if (u.pathname === '/app/installations/777')
      return (
        opts.installation?.() ??
        json(200, {
          id: 777,
          account: { login: 'acme', type: 'Organization' },
          repository_selection: 'selected',
          permissions: { contents: 'write', pull_requests: 'write', metadata: 'read', issues: 'read' },
          suspended_at: null,
        })
      );
    if (u.pathname === '/app/installations/777/access_tokens' && method === 'POST') {
      mints++;
      const r = opts.mint?.(mints);
      if (r) return r;
      return json(201, { token: `ghs_testtoken${String(mints).padStart(20, '0')}`, expires_at: new Date(clock() + 60 * MIN).toISOString() });
    }
    if (u.pathname === '/users/guild-bot%5Bbot%5D' || u.pathname === '/users/guild-bot[bot]')
      return json(200, { login: 'guild-bot[bot]', id: 99001 });
    return json(404, { message: 'Not Found' });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls, mints: () => mints };
}

function env(fetchImpl: typeof fetch, now: () => number = () => T0): AdapterEnv & { dir: string } {
  const dir = mkdtempSync(join(tmp(), 'apps-'));
  return {
    dir,
    paths: { secrets: join(dir, 'secrets'), logs: join(dir, 'logs') } as AdapterEnv['paths'],
    fetch: fetchImpl,
    now: () => new Date(now()),
    sealKey,
    touchRecheck: () => {},
  } as unknown as AdapterEnv & { dir: string };
}

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

// ------------------------------------------------------------------------------------------------ JWT and key

describe('GitHub App JWT', () => {
  it('is RS256 with iat backdated 60 s, a 10-minute life and the App ID as a number', () => {
    const now = 1_800_000_000;
    const jwt = signAppJwt('4242', parseAppPrivateKey(PEM_PKCS1), now);
    const [h, c, s] = jwt.split('.') as [string, string, string];
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decode(c);
    expect(claims).toEqual({ iat: now - 60, exp: now + 540, iss: 4242 });
    expect(claims.exp - claims.iat).toBe(600);
    const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(PUB, Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
  });

  it('puts a client ID into iss as a string', () => {
    const jwt = signAppJwt('Iv23liAbCdEf', parseAppPrivateKey(PEM_PKCS8), 100);
    expect(decode(jwt.split('.')[1] as string).iss).toBe('Iv23liAbCdEf');
  });

  it('reads PKCS#1 and PKCS#8 keys and refuses non-RSA or short keys without quoting them', () => {
    expect(parseAppPrivateKey(PEM_PKCS1).asymmetricKeyType).toBe('rsa');
    expect(parseAppPrivateKey(PEM_PKCS8).asymmetricKeyType).toBe('rsa');
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const short = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    for (const bad of [ec, short, 'not a key']) {
      try {
        parseAppPrivateKey(bad);
        expect.unreachable();
      } catch (err) {
        expect((err as AppTokenError).code).toBe('key_invalid');
        expect((err as Error).message).not.toContain('PRIVATE');
      }
    }
  });
});

describe('GitHub error classification', () => {
  const a = (status: number, message = '', headers: Record<string, string> = {}) => ({
    status,
    body: { message },
    headers: new Headers(headers),
  });
  it.each([
    [a(401, 'A JSON web token could not be decoded'), 'app', 'jwt_rejected'],
    [a(404), 'app', 'app_not_found'],
    [a(404), 'installation', 'installation_not_found'],
    [a(403, 'This installation has been suspended'), 'mint', 'installation_suspended'],
    [a(422, 'The permissions requested are not granted to this installation.'), 'mint', 'permission_missing'],
    [a(422, 'There is at least one repository that does not exist or is not accessible'), 'mint', 'repository_not_accessible'],
    [a(403, 'rate limit', { 'x-ratelimit-remaining': '0', 'retry-after': '30' }), 'mint', 'rate_limited'],
    [a(502), 'mint', 'unreachable'],
    [a(401, 'Bad credentials'), 'user', 'token_rejected'],
    [a(418), 'app', 'unexpected'],
  ] as const)('%#: %o in %s is %s', (ans, phase, code) => {
    expect(classifyGitHubError(ans, phase).code).toBe(code);
  });
  it('keeps the retry-after of a rate limit', () => {
    expect(classifyGitHubError(a(429, '', { 'retry-after': '30' }), 'mint').opts.retryAfterMs).toBe(30_000);
  });
});

// ------------------------------------------------------------------------------------------------ adapter

describe('AutomatedAppIntegration connect', () => {
  it('verifies with GitHub, mints a least-privilege token, resolves the bot and stores the key sealed', async () => {
    const gh = fakeGitHub();
    const e = env(gh.fetch);
    const app = new AutomatedAppIntegration('github-app', e);
    const r = await app.connectApp({ host: 'github.com', appRef: '4242', installationId: '777', privateKey: PEM_PKCS1 });
    expect(r.ok).toBe(true);
    expect(r.instance).toBe('4242:777');
    expect(r.identity).toMatchObject({
      botLogin: 'guild-bot[bot]',
      commitName: 'guild-bot[bot]',
      commitEmail: '99001+guild-bot[bot]@users.noreply.github.com',
      account: 'acme',
      missingPermissions: ['issues'],
    });
    expect(AppCommandResultSchema.safeParse(r).success).toBe(true);
    const mint = gh.calls.find((c) => c.method === 'POST');
    expect(mint?.body).toEqual({ permissions: { metadata: 'read' } });
    expect(await app.instances()).toEqual(['4242:777']);
    const files = walk(e.dir).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(files).not.toContain('BEGIN');
    for (const line of pemSecrets(PEM_PKCS1).slice(3)) expect(files).not.toContain(line);
    expect(files).not.toContain('ghs_');
    const st = await app.status('4242:777');
    expect(st).toMatchObject({ state: 'connected', account: 'guild-bot[bot]', method: 'app_key', missingScopes: ['issues'] });
  });

  it('uses the GHES noreply host and API base', async () => {
    const gh = fakeGitHub();
    const seen: string[] = [];
    const f = ((url: string, init?: RequestInit) => {
      seen.push(url);
      return gh.fetch(url.replace('https://ghe.acme.io/api/v3', 'https://api.github.com'), init);
    }) as unknown as typeof fetch;
    const r = await new AutomatedAppIntegration('github-app', env(f)).connectApp({
      host: 'ghe.acme.io',
      appRef: '4242',
      installationId: '777',
      privateKey: PEM_PKCS1,
    });
    expect(r.identity?.commitEmail).toBe('99001+guild-bot[bot]@users.noreply.ghe.acme.io');
    expect(seen[0]).toMatch(/^https:\/\/ghe\.acme\.io\/api\/v3\//);
  });

  it.each([
    ['a wrong key', { app: () => json(401, { message: 'A JSON web token could not be decoded' }) }, 'jwt_rejected'],
    ['a wrong App ID', { app: () => json(404, { message: 'Not Found' }) }, 'app_not_found'],
    ['an uninstalled app', { installation: () => json(404, { message: 'Not Found' }) }, 'installation_not_found'],
  ] as const)('%s stores nothing and returns a typed, non-secret error', async (_n, o, code) => {
    const e = env(fakeGitHub(o).fetch);
    const app = new AutomatedAppIntegration('github-app', e);
    const r = await app.connectApp({ host: 'github.com', appRef: '4242', installationId: '777', privateKey: PEM_PKCS1 });
    expect(r).toMatchObject({ ok: false, code });
    expect(JSON.stringify(r)).not.toContain('PRIVATE');
    expect(await app.instances()).toEqual([]);
    expect(redact(PEM_PKCS1)).toBe(PEM_PKCS1); // not left in the registry
    const out = await app.connect('4242:777', 'app_key', { privateKey: PEM_PKCS1 });
    expect(out).toMatchObject({ code: 'refused' });
  });

  it('asks to choose when the app has several installations, and uses the only one otherwise', async () => {
    const many = fakeGitHub({ installations: [{ id: 777, login: 'acme' }, { id: 778, login: 'other' }] });
    const r = await new AutomatedAppIntegration('github-app', env(many.fetch)).connectApp({
      host: 'github.com',
      appRef: '4242',
      privateKey: PEM_PKCS1,
    });
    expect(r).toMatchObject({ ok: false, code: 'choose_installation' });
    expect(r.installations?.map((i) => i.account)).toEqual(['acme', 'other']);
    const one = await new AutomatedAppIntegration('github-app', env(fakeGitHub().fetch)).connectApp({
      host: 'github.com',
      appRef: '4242',
      privateKey: PEM_PKCS1,
    });
    expect(one).toMatchObject({ ok: true, instance: '4242:777' });
  });

  it('refuses a key that belongs to another app or installation than expected', async () => {
    const r = await new AutomatedAppIntegration('github-app', env(fakeGitHub().fetch)).connectApp(
      { host: 'github.com', appRef: '4242', installationId: '777', privateKey: PEM_PKCS1 },
      { expect: '5555:777' },
    );
    expect(r).toMatchObject({ ok: false, code: 'app_mismatch' });
  });

  it('remove deletes the sealed key and the file, and unregisters the key', async () => {
    const e = env(fakeGitHub().fetch);
    const app = new AutomatedAppIntegration('github-app', e);
    await app.connectApp({ host: 'github.com', appRef: '4242', installationId: '777', privateKey: PEM_PKCS1 });
    expect(redact(PEM_PKCS1)).toBe('***');
    await app.remove('4242:777');
    expect(await app.instances()).toEqual([]);
    expect(walk(e.dir).filter((f) => f.endsWith('app-integrations.json'))).toEqual([]);
    expect(redact(PEM_PKCS1)).toBe(PEM_PKCS1);
    expect((await app.status('4242:777')).state).toBe('not_connected');
  });

  it('is registered in the integration adapter list', () => {
    const adapters = buildIntegrationAdapters(env(fakeGitHub().fetch));
    expect(adapters.get('github-app')).toBeInstanceOf(AutomatedAppIntegration);
  });

  it('the provider interface module names no GitHub type', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'apps', 'types.ts'), 'utf8');
    expect(src).not.toMatch(/github/i);
    const broker = readFileSync(join(import.meta.dirname, '..', 'src', 'apps', 'broker.ts'), 'utf8');
    expect(broker).not.toMatch(/from 'node:fs'|github-app/);
  });
});

// ------------------------------------------------------------------------------------------------ broker

async function connected(clock: { t: number }, o: Parameters<typeof fakeGitHub>[0] = {}) {
  const gh = fakeGitHub({ clock: () => clock.t, ...o });
  const e = env(gh.fetch, () => clock.t);
  const app = new AutomatedAppIntegration('github-app', e);
  const r = await app.connectApp({ host: 'github.com', appRef: '4242', installationId: '777', privateKey: PEM_PKCS1 });
  expect(r.ok).toBe(true);
  const broker = new AppTokenBroker({
    store: new AppKeyStore(e.paths.secrets, sealKey),
    fetch: gh.fetch,
    now: () => clock.t,
    unregisterDelayMs: 0,
  });
  const before = gh.mints();
  return { gh, e, app, broker, mintsSince: () => gh.mints() - before };
}

describe('AppTokenBroker', () => {
  it('returns the cached token while more than 10 minutes remain and mints a new one at minute 55', async () => {
    const clock = { t: T0 };
    const { broker, mintsSince } = await connected(clock);
    const a = await broker.getAccessToken('4242:777');
    expect(mintsSince()).toBe(1);
    clock.t = T0 + 49 * MIN;
    expect((await broker.getAccessToken('4242:777')).token).toBe(a.token);
    expect(mintsSince()).toBe(1);
    clock.t = T0 + 55 * MIN;
    const b = await broker.getAccessToken('4242:777');
    expect(b.token).not.toBe(a.token);
    expect(mintsSince()).toBe(2);
    expect(b.expiresAt - clock.t).toBeGreaterThan(REFRESH_MARGIN_MS);
    expect(broker.health('4242:777').refreshedAt).toBe(clock.t);
  });

  it('two concurrent callers trigger exactly one mint', async () => {
    const { broker, mintsSince } = await connected({ t: T0 });
    const [x, y] = await Promise.all([broker.getAccessToken('4242:777'), broker.getAccessToken('4242:777')]);
    expect(x.token).toBe(y.token);
    expect(mintsSince()).toBe(1);
  });

  it('keys the cache by scope, with sorted repositories and permissions', async () => {
    expect(scopeKey('i', { repositories: ['b', 'a'], permissions: { issues: 'write', contents: 'read' } })).toBe(
      scopeKey('i', { repositories: ['a', 'b'], permissions: { contents: 'read', issues: 'write' } }),
    );
    const { broker, mintsSince, gh } = await connected({ t: T0 });
    await broker.getAccessToken('4242:777', { repositories: ['web'] });
    await broker.getAccessToken('4242:777', { repositories: ['api'] });
    expect(mintsSince()).toBe(2);
    expect(gh.calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({ repositories: ['api'] });
  });

  it('a 401 with a cached token re-mints exactly once and retries', async () => {
    const { broker, mintsSince } = await connected({ t: T0 });
    await broker.getAccessToken('4242:777');
    const used: string[] = [];
    const out = await broker.withToken('4242:777', undefined, async (t) => {
      used.push(t);
      return used.length === 1 ? { status: 401 } : { status: 200, value: 'ok' };
    });
    expect(out).toMatchObject({ status: 200 });
    expect(used).toHaveLength(2);
    expect(used[0]).not.toBe(used[1]);
    expect(mintsSince()).toBe(2);
  });

  it('a second 401 surfaces a typed error and turns the status into an error with the reason', async () => {
    const { broker, app, e } = await connected({ t: T0 });
    e.apps = broker;
    const err = await broker
      .withToken('4242:777', undefined, async () => ({ status: 401 }))
      .catch((x: unknown) => x as AppTokenError);
    expect(err).toBeInstanceOf(AppTokenError);
    expect((err as AppTokenError).code).toBe('token_rejected');
    expect(broker.health('4242:777').error?.code).toBe('token_rejected');
    const st = await app.status('4242:777');
    expect(st).toMatchObject({ state: 'refused', errorCode: 'token_rejected' });
    expect(st.detail).toMatch(/refused the access token/);
  });

  it('does not cache a failed mint, and holds back after a rate limit', async () => {
    let fail: Response | undefined;
    const clock = { t: T0 };
    const { broker, mintsSince } = await connected(clock, { mint: () => fail });
    fail = json(502, {});
    await expect(broker.getAccessToken('4242:777')).rejects.toMatchObject({ code: 'unreachable' });
    fail = undefined;
    await broker.getAccessToken('4242:777');
    expect(mintsSince()).toBe(2);
    fail = json(429, { message: 'slow down' }, { 'retry-after': '120' });
    await expect(broker.getAccessToken('4242:777', { repositories: ['x'] })).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(broker.getAccessToken('4242:777', { repositories: ['x'] })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(mintsSince()).toBe(3);
    fail = undefined;
    clock.t += 121_000;
    await broker.getAccessToken('4242:777', { repositories: ['x'] });
    expect(mintsSince()).toBe(4);
  });

  it('never writes a token to disk', async () => {
    const { broker, e } = await connected({ t: T0 });
    const t = await broker.getAccessToken('4242:777');
    for (const f of walk(e.dir)) expect(readFileSync(f, 'utf8')).not.toContain(t.token);
  });

  it('invalidate drops the cached tokens', async () => {
    const { broker, mintsSince } = await connected({ t: T0 });
    await broker.getAccessToken('4242:777');
    broker.invalidate('4242:777');
    await broker.getAccessToken('4242:777');
    expect(mintsSince()).toBe(2);
  });

  it('re-signs once with the server time on a clock skew refusal, then names the skew', async () => {
    const serverDate = new Date(T0 + 30 * MIN).toUTCString();
    let n = 0;
    const skewOnce = fakeGitHub({
      app: () => (++n === 1 ? json(401, { message: "'Expiration time' claim ('exp') is too far in the future" }, { date: serverDate }) : undefined),
    });
    const ok = await new AutomatedAppIntegration('github-app', env(skewOnce.fetch)).connectApp({
      host: 'github.com',
      appRef: '4242',
      installationId: '777',
      privateKey: PEM_PKCS1,
    });
    expect(ok.ok).toBe(true);
    const always = fakeGitHub({
      app: () => json(401, { message: "'Issued at' claim ('iat') must be an Integer" }, { date: serverDate }),
    });
    const bad = await new AutomatedAppIntegration('github-app', env(always.fetch)).connectApp({
      host: 'github.com',
      appRef: '4242',
      installationId: '777',
      privateKey: PEM_PKCS1,
    });
    expect(bad).toMatchObject({ ok: false, code: 'clock_skew' });
    expect(bad.message).toMatch(/about 30 minutes/);
  });
});

// ------------------------------------------------------------------------------------------------ store and redaction

describe('AppKeyStore and redaction', () => {
  const stored = (): StoredApp => ({
    provider: 'github-app',
    host: 'github.com',
    appRef: '4242',
    appId: '4242',
    installationId: '777',
    privateKey: PEM_PKCS1,
    identity: AppIdentitySchema.parse({
      provider: 'github-app',
      host: 'github.com',
      appId: '4242',
      appSlug: 'guild-bot',
      appName: 'Guild Bot',
      installationId: '777',
      account: 'acme',
      botLogin: 'guild-bot[bot]',
      botUserId: '99001',
      commitName: 'guild-bot[bot]',
      commitEmail: '99001+guild-bot[bot]@users.noreply.github.com',
      permissions: {},
      missingPermissions: [],
    }),
    refs: [],
    local: false,
    savedAt: new Date(T0).toISOString(),
  });

  it('keeps refs per organization and lists without the key', () => {
    const dir = join(mkdtempSync(join(tmp(), 'store-')), 'secrets');
    const s = new AppKeyStore(dir, sealKey);
    s.put('4242:777', stored());
    s.addRef('4242:777', { orgId: 'o1', integrationId: 'i1' });
    s.addRef('4242:777', { orgId: 'o2', integrationId: 'i2' });
    expect(s.list()[0]).not.toHaveProperty('privateKey');
    expect(s.dropRef('4242:777', { orgId: 'o1', integrationId: 'i1' })?.refs).toEqual([{ orgId: 'o2', integrationId: 'i2' }]);
    expect(readFileSync(join(dir, 'app-integrations.json'), 'utf8')).not.toContain('BEGIN');
  });

  it('masks the key, one line of it and a minted token in the logger, audit log and Claude activity summaries', async () => {
    const clock = { t: T0 };
    const { broker, e } = await connected(clock);
    const t = await broker.getAccessToken('4242:777');
    const oneLine = pemSecrets(PEM_PKCS1)[4] as string;
    const leak = `failed with key ${PEM_PKCS1} line ${oneLine} token ${t.token}`;

    const logFile = join(e.dir, 'logs', 'runner.log');
    createLogger(logFile, true).error(leak);
    const audit = join(e.dir, 'logs', 'integrations.jsonl');
    new AuditLog(audit).write({ kind: 'github-app', instance: '4242:777', op: 'test', via: 'cli', result: 'failed', detail: leak });
    const summary = summarizeToolInput('Bash', { command: `echo ${t.token} ${oneLine}` });

    for (const text of [readFileSync(logFile, 'utf8'), readFileSync(audit, 'utf8'), summary, redactSecrets(leak)]) {
      expect(text).not.toContain(t.token);
      expect(text).not.toContain(oneLine);
      expect(text).not.toContain('PRIVATE KEY-----\n');
      expect(text).toContain('***');
    }
  });

  it('the stream-parser redaction masks an unregistered PEM block by its shape', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(redactSecrets(`cat <<EOF\n${other}EOF`)).not.toContain('PRIVATE KEY');
  });
});
