import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOG_REDACT, redactUrl } from '../src/app.ts';
import { describeSecuritySettings } from '../src/auth/security-settings.ts';
import { configWarnings, withConfig } from '../src/config.ts';
import { createTestApp, ORIGIN, PASSWORD, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';
import { messageText, waitForMessages } from './helpers/mailpit.ts';

/**
 * R13: secrets never reach a log line. Boot, a 500, sign-in (password and code) and the reset flow are logged through
 * the real server logger into a captured stream; none of the secret values appears, and `err.code` stays visible.
 */
const SECRET_KEY = 'boot-secret-key-value-0123456789abcdef';
const TWO_FACTOR_KEY = 'boot-two-factor-key-value-0123456789abc';
const SMTP_PASSWORD = 'smtp-pass-value-77';
const lines: string[] = [];
const logged = () => lines.join('');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    env: { AOM_SECRET_KEY: SECRET_KEY, AOM_TWO_FACTOR_KEY: TWO_FACTOR_KEY, LOG_LEVEL: 'info' },
    logStream: { write: (l: string) => void lines.push(l) },
  });
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('boot', () => {
  it('neither the boot lines nor a whole-config dump carry a key, a connection string or the environment', async () => {
    const ctx = t.app.ctx;
    // what start.ts logs at boot
    ctx.log.info(await describeSecuritySettings(ctx), 'security settings');
    for (const w of configWarnings(ctx.config)) ctx.log.warn(w);
    // the mistake R13 guards against: someone logs the config object (also nested)
    const smtp = `smtp://mailer:${SMTP_PASSWORD}@mail.example:587`;
    const config = withConfig(ctx.config, {
      smtpUrl: smtp,
      anthropicApiKey: 'anthropic-key-value',
      videoWorkerToken: 'video-token-value',
      inbound: { ...ctx.config.inbound, secret: 'inbound-secret-value' },
    });
    ctx.log.info({ config }, 'config');
    ctx.log.info(config, 'config at the top level');
    const out = logged();
    expect(out).toContain('security settings');
    for (const secret of [
      SECRET_KEY,
      TWO_FACTOR_KEY,
      SMTP_PASSWORD,
      ctx.config.databaseUrl,
      'anthropic-key-value',
      'video-token-value',
      'inbound-secret-value',
    ])
      expect(out).not.toContain(secret);
    expect(out).not.toContain('"env"');
  });
});

describe('requests', () => {
  it('a 500 keeps err.code, never the request body or secret fields of the error', async () => {
    const email = uniqueEmail('boom');
    const pool = t.app.ctx.pool;
    const real = pool.query.bind(pool);
    // the first query of the sign-in fails as a driver error with secrets attached
    (pool as { query: unknown }).query = async () => {
      (pool as { query: unknown }).query = real;
      throw Object.assign(new Error('connection lost'), {
        code: 'E_BOOM_57P01',
        databaseUrl: t.app.ctx.config.databaseUrl,
        password: 'err-password-value',
        token: 'err-token-value',
      });
    };
    const r = await t.req('POST', '/api/auth/login', { body: { email, password: 'body-password-value-1' } });
    (pool as { query: unknown }).query = real;
    expect(r.status).toBe(500);
    const out = logged();
    expect(out).toContain('E_BOOM_57P01');
    for (const secret of ['body-password-value-1', 'err-password-value', 'err-token-value'])
      expect(out).not.toContain(secret);
    expect(out).not.toContain(t.app.ctx.config.databaseUrl);
  });

  it('sign-in with password and code, and the whole reset flow, log no password, code or link token', async () => {
    const root = await t.superAdminSession();
    const code = await t.totpCode(root.id);
    const r1 = await t.req('POST', '/api/auth/login', { body: { email: root.email, password: PASSWORD } });
    const r2 = await t.req('POST', '/api/auth/login/2fa', { body: { challenge: r1.body.challenge, code } });
    expect(r2.status).toBe(200);

    const u = await t.userSession(uniqueEmail('reset'));
    await t.req('POST', '/api/auth/password-reset/request', { body: { email: u.email } });
    const [mail] = await waitForMessages(u.email, 1);
    const m = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(await messageText(mail?.ID as string));
    const token = m?.[1] as string;
    expect(token).toBeTruthy();
    expect((await t.req('GET', `/api/auth/password-reset/${token}`)).status).toBe(200);
    await t.req('GET', `/reset-password/${token}`);
    const NEW = 'a-new-password-for-logs-9';
    expect(
      (await t.req('POST', '/api/auth/password-reset/confirm', { body: { token, password: NEW } })).status,
    ).toBe(200);

    const out = logged();
    expect(out).toContain('/api/auth/password-reset/[redacted]');
    expect(out).toContain('/api/auth/password-reset/confirm');
    for (const secret of [PASSWORD, NEW, token, r1.body.challenge]) expect(out).not.toContain(secret);
    expect(out).not.toMatch(new RegExp(`"code":"${code}"`));
  });
});

describe('redaction rules', () => {
  it('redactUrl hides reset, verification and invitation tokens but keeps the fixed endpoints', () => {
    expect(redactUrl('/api/auth/password-reset/abc123')).toBe('/api/auth/password-reset/[redacted]');
    expect(redactUrl('/api/auth/password-reset/request')).toBe('/api/auth/password-reset/request');
    expect(redactUrl('/api/auth/password-reset/confirm')).toBe('/api/auth/password-reset/confirm');
    expect(redactUrl('/api/auth/password-reset/requested-token')).toBe('/api/auth/password-reset/[redacted]');
    expect(redactUrl('/reset-password/abc123?x=1')).toBe('/reset-password/[redacted]?x=1');
    expect(redactUrl('/verify-email/abc123')).toBe('/verify-email/[redacted]');
    expect(redactUrl('/api/signup/verify-email/abc123')).toBe('/api/signup/verify-email/[redacted]');
    expect(redactUrl(`${ORIGIN}/invite/abc123`)).toBe(`${ORIGIN}/invite/[redacted]`);
    // the member reset route has no token in its path
    expect(redactUrl('/api/org/members/u1/reset-password')).toBe('/api/org/members/u1/reset-password');
  });

  it('LOG_REDACT hides the listed fields and headers, never err.code', () => {
    const out: string[] = [];
    const log = Fastify({
      logger: { level: 'info', redact: LOG_REDACT, stream: { write: (l: string) => void out.push(l) } },
    }).log;
    log.info(
      {
        req: {
          body: {
            password: 'p1',
            current: 'p2',
            new: 'p3',
            code: '123456',
            token: 't1',
            secret: 's1',
            apiKey: 'k1',
          },
          headers: { authorization: 'Bearer h1', cookie: 'aom_session=c1' },
        },
      },
      'request',
    );
    log.info(
      {
        user: {
          passwordHash: 'h2',
          refreshToken: 'r1',
          accessToken: 'a1',
          secretEnc: 'e1',
          privateKey: 'pk1',
        },
        cfg: {
          databaseUrl: 'postgres://x:dbpw@h/db',
          smtpUrl: 'smtp://x:smpw@h',
          secretKey: 'sk1',
          twoFactorKey: 'tk1',
        },
        config: { env: { AOM_SECRET_KEY: 'envsk' } },
      },
      'nested',
    );
    log.error({ err: { code: 'E_VISIBLE', message: 'x' } }, 'failed');
    const text = out.join('');
    for (const v of ['p1', 'p2', 'p3', '123456', 't1', 's1', 'k1', 'h1', 'c1', 'h2', 'r1', 'a1', 'e1', 'pk1'])
      expect(text).not.toContain(`"${v}"`);
    for (const v of ['dbpw', 'smpw', 'sk1', 'tk1', 'envsk', 'Bearer']) expect(text).not.toContain(v);
    expect(text).toContain('E_VISIBLE');
  });
});
