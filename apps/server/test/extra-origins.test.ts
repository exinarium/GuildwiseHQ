import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkOrigin, checkWsOrigin } from '../src/auth/origin-check.ts';
import { loadConfig, parseExtraOrigins } from '../src/config.ts';
import { createTestApp, ORIGIN, PASSWORD, type TestApp, uniqueEmail } from './helpers/app.ts';

const post = (origin: string | undefined) =>
  ({
    method: 'POST',
    url: '/api/auth/login',
    headers: origin === undefined ? {} : { origin },
  }) as unknown as FastifyRequest;

describe('AOM_EXTRA_ORIGINS parsing', () => {
  it('is empty by default', () => {
    expect(loadConfig({ ...process.env, AOM_EXTRA_ORIGINS: undefined }).extraOrigins).toEqual([]);
    expect(parseExtraOrigins('')).toEqual([]);
  });

  it('normalises exact origins: case, default ports, trailing slash, duplicates', () => {
    expect(
      parseExtraOrigins(' HTTP://192.168.1.10:4700/ , https://UAT.example.com:443,https://uat.example.com '),
    ).toEqual(['http://192.168.1.10:4700', 'https://uat.example.com']);
  });

  it.each([
    '*',
    'https://*.example.com',
    'ftp://host',
    'not a url',
    'http://host/path',
    'http://u:p@host',
    'http://host?x=1',
    'null',
  ])('refuses %s at boot', (bad) => {
    expect(() => loadConfig({ ...process.env, AOM_EXTRA_ORIGINS: `http://ok.example:1, ${bad}` })).toThrow(
      /AOM_EXTRA_ORIGINS/,
    );
  });
});

describe('origin checks with extra origins', () => {
  const cfg = loadConfig({
    ...process.env,
    AOM_PUBLIC_ORIGIN: 'https://aom.example.com/',
    AOM_EXTRA_ORIGINS: 'http://192.168.1.10:4700',
  });

  it('accepts the public origin and each extra origin, nothing else', () => {
    expect(() => checkOrigin(cfg, post('https://aom.example.com'))).not.toThrow();
    expect(() => checkOrigin(cfg, post('http://192.168.1.10:4700'))).not.toThrow();
    for (const o of [
      undefined,
      'null',
      '*',
      'http://192.168.1.10',
      'http://192.168.1.10:4700/',
      'http://evil.example',
    ])
      expect(() => checkOrigin(cfg, post(o))).toThrow(/Origin/);
  });

  it('applies the same list to WebSocket upgrades', () => {
    expect(checkWsOrigin(cfg, 'http://192.168.1.10:4700')).toBe(true);
    expect(checkWsOrigin(cfg, 'https://aom.example.com')).toBe(true);
    expect(checkWsOrigin(cfg, 'http://192.168.1.15:4700')).toBe(false);
    expect(checkWsOrigin(cfg, undefined)).toBe(false);
  });

  it('without the variable only the public origin passes (unchanged behaviour)', () => {
    const plain = loadConfig({ ...process.env, AOM_EXTRA_ORIGINS: undefined });
    expect(checkWsOrigin(plain, 'http://192.168.1.10:4700')).toBe(false);
    expect(checkWsOrigin(plain, plain.publicOrigin)).toBe(true);
  });
});

describe('extra origins through the app', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ env: { AOM_EXTRA_ORIGINS: 'http://192.168.1.10:4700' } });
  });
  afterAll(async () => t.close());

  it('lets a request from the extra origin log in; an unlisted origin still gets 403', async () => {
    const email = uniqueEmail();
    await t.createUser(email);
    const login = (origin: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin },
        payload: { email, password: PASSWORD },
      });
    expect((await login('http://192.168.1.10:4700')).statusCode).toBe(200);
    expect((await login(ORIGIN)).statusCode).toBe(200);
    expect((await login('http://192.168.1.16:4700')).statusCode).toBe(403);
  });
});
