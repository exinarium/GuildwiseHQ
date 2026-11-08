import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import {
  describeTrustProxy,
  fastifyTrustProxy,
  parseTrustProxy,
  TRUST_PROXY_DEFAULT,
  type TrustProxy,
  trustProxyWarning,
} from '../src/trust-proxy.ts';
import { createTestApp } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';

const LOOPBACK = ['127.0.0.0/8', '::1/128'];

describe('parseTrustProxy: accepted forms', () => {
  it('unset or empty is the default: loopback only', () => {
    for (const v of [undefined, '', '   ']) {
      const t = parseTrustProxy(v);
      expect(t).toEqual({ kind: 'addresses', addresses: LOOPBACK, isDefault: true });
    }
  });

  it('false, 0 and none never trust the header (case-insensitive)', () => {
    for (const v of ['false', 'FALSE', ' False ', '0', 'none', 'None'])
      expect(parseTrustProxy(v)).toEqual({ kind: 'off' });
  });

  it('a whole number from 1 to 32 is a hop count', () => {
    expect(parseTrustProxy('1')).toEqual({ kind: 'hops', hops: 1 });
    expect(parseTrustProxy('2')).toEqual({ kind: 'hops', hops: 2 });
    expect(parseTrustProxy(' 32 ')).toEqual({ kind: 'hops', hops: 32 });
  });

  it('true trusts every hop', () => {
    expect(parseTrustProxy('true')).toEqual({ kind: 'all' });
    expect(parseTrustProxy('TRUE')).toEqual({ kind: 'all' });
  });

  it('single addresses and CIDR ranges, IPv4 and IPv6', () => {
    expect(parseTrustProxy('10.0.0.5')).toEqual({ kind: 'addresses', addresses: ['10.0.0.5'] });
    expect(parseTrustProxy('10.0.0.0/8')).toEqual({ kind: 'addresses', addresses: ['10.0.0.0/8'] });
    expect(parseTrustProxy('::1')).toEqual({ kind: 'addresses', addresses: ['::1'] });
    expect(parseTrustProxy('fd00::/8')).toEqual({ kind: 'addresses', addresses: ['fd00::/8'] });
    expect(parseTrustProxy('172.18.0.0/016')).toEqual({ kind: 'addresses', addresses: ['172.18.0.0/16'] });
  });

  it('a mixed list is trimmed, empty entries skipped and duplicates removed', () => {
    expect(parseTrustProxy('10.0.0.0/8, 2001:db8::1 ,192.168.1.1,,10.0.0.0/8')).toEqual({
      kind: 'addresses',
      addresses: ['10.0.0.0/8', '2001:db8::1', '192.168.1.1'],
    });
  });

  it('expands the names loopback, linklocal and uniquelocal', () => {
    expect(parseTrustProxy('loopback,uniquelocal').kind).toBe('addresses');
    expect((parseTrustProxy('loopback,uniquelocal') as any).addresses).toEqual([
      '127.0.0.0/8',
      '::1/128',
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      'fc00::/7',
    ]);
    expect((parseTrustProxy('LinkLocal, 10.0.0.0/8') as any).addresses).toEqual([
      '169.254.0.0/16',
      'fe80::/10',
      '10.0.0.0/8',
    ]);
    // a name that overlaps an explicit entry does not duplicate it
    expect((parseTrustProxy('127.0.0.0/8,loopback') as any).addresses).toEqual(LOOPBACK);
  });

  it('an explicit list is not marked as the default', () => {
    expect((parseTrustProxy('loopback') as any).isDefault).toBeUndefined();
  });
});

describe('parseTrustProxy: invalid values stop the boot', () => {
  const invalid = [
    '-1',
    '+2',
    '33',
    '1000',
    '1.5',
    'abc',
    'yes',
    '10.0.0.0/33',
    '::1/129',
    '10.0.0.0/',
    '10.0.0.0/8/8',
    '10.0.0.0/255.0.0.0',
    'fe80::1%eth0',
    '*',
    ',',
    ' , ',
    '10.0.0.1,true',
    '10.0.0.1,1',
    '10.0.0.1,false',
    '999.0.0.1',
    'example.com',
  ];
  for (const v of invalid)
    it(`rejects ${JSON.stringify(v)} with a message naming the variable and the accepted forms`, () => {
      expect(() => parseTrustProxy(v)).toThrow(/AOM_TRUST_PROXY/);
      expect(() => parseTrustProxy(v)).toThrow(/hop count from 1 to 32/);
      expect(() => parseTrustProxy(v)).toThrow(/CIDR/);
    });
});

describe('loadConfig reads AOM_TRUST_PROXY', () => {
  it('defaults to loopback only when the variable is not set', () => {
    expect(loadConfig({ ...process.env, AOM_TRUST_PROXY: undefined }).trustProxy).toEqual(
      TRUST_PROXY_DEFAULT,
    );
  });

  it('parses a set value', () => {
    expect(loadConfig({ ...process.env, AOM_TRUST_PROXY: '2' }).trustProxy).toEqual({
      kind: 'hops',
      hops: 2,
    });
    expect(loadConfig({ ...process.env, AOM_TRUST_PROXY: 'none' }).trustProxy).toEqual({ kind: 'off' });
  });

  it('throws at startup on an invalid value, never falling back to trusting all', () => {
    expect(() => loadConfig({ ...process.env, AOM_TRUST_PROXY: 'everything' })).toThrow(/AOM_TRUST_PROXY/);
  });
});

describe('fastifyTrustProxy', () => {
  it('maps off to false, all to true and a list to a copy of the array', () => {
    expect(fastifyTrustProxy({ kind: 'off' })).toBe(false);
    expect(fastifyTrustProxy({ kind: 'all' })).toBe(true);
    const list = fastifyTrustProxy(TRUST_PROXY_DEFAULT);
    expect(list).toEqual(LOOPBACK);
    expect(list).not.toBe((TRUST_PROXY_DEFAULT as any).addresses);
  });

  it('maps a hop count to a function, never to a number (Fastify reads a number as "trust nobody")', () => {
    const fn = fastifyTrustProxy({ kind: 'hops', hops: 2 });
    expect(typeof fn).toBe('function');
    const trust = fn as (a: string, i: number) => boolean;
    expect([trust('x', 0), trust('x', 1), trust('x', 2)]).toEqual([true, true, false]);
  });
});

describe('describeTrustProxy and the warning for true', () => {
  it('describes each form for the startup log', () => {
    expect(describeTrustProxy(TRUST_PROXY_DEFAULT)).toBe('loopback only (default)');
    expect(describeTrustProxy({ kind: 'off' })).toContain('ignored');
    expect(describeTrustProxy({ kind: 'hops', hops: 1 })).toBe('1 hop');
    expect(describeTrustProxy({ kind: 'hops', hops: 3 })).toBe('3 hops');
    expect(describeTrustProxy({ kind: 'all' })).toBe('every hop');
    expect(describeTrustProxy(parseTrustProxy('10.0.0.0/8,::1'))).toBe('10.0.0.0/8, ::1');
  });

  it('warns only for true', () => {
    expect(trustProxyWarning({ kind: 'all' })).toMatch(/AOM_TRUST_PROXY=true/);
    for (const t of [TRUST_PROXY_DEFAULT, { kind: 'off' }, { kind: 'hops', hops: 1 }] as TrustProxy[])
      expect(trustProxyWarning(t)).toBeUndefined();
  });
});

/** What `req.ip` resolves to for a request from `remoteAddress` carrying `xff`, under setting `raw`. */
async function resolvedIp(raw: string | undefined, remoteAddress: string, xff?: string): Promise<string> {
  const app = Fastify({ trustProxy: fastifyTrustProxy(parseTrustProxy(raw)) });
  app.get('/ip', async (req) => ({ ip: req.ip }));
  try {
    const r = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress,
      headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    });
    return r.json().ip;
  } finally {
    await app.close();
  }
}

describe('client address resolution', () => {
  it('default: a forged header from a non-loopback peer is ignored', async () => {
    expect(await resolvedIp(undefined, '203.0.113.7', '198.51.100.1')).toBe('203.0.113.7');
    expect(await resolvedIp(undefined, '2001:db8::7', '198.51.100.1')).toBe('2001:db8::7');
  });

  it('default: the header is honoured from 127.0.0.1, ::1 and an IPv4-mapped loopback peer', async () => {
    expect(await resolvedIp(undefined, '127.0.0.1', '198.51.100.1')).toBe('198.51.100.1');
    expect(await resolvedIp(undefined, '::1', '198.51.100.1')).toBe('198.51.100.1');
    expect(await resolvedIp(undefined, '::ffff:127.0.0.1', '198.51.100.1')).toBe('198.51.100.1');
  });

  it('default: a spoofed entry left of the loopback proxy entry is ignored', async () => {
    expect(await resolvedIp(undefined, '127.0.0.1', '6.6.6.6, 198.51.100.1')).toBe('198.51.100.1');
  });

  it('hop count 1: the rightmost entry; spoofed entries further left are ignored', async () => {
    expect(await resolvedIp('1', '10.0.0.2', '198.51.100.1')).toBe('198.51.100.1');
    expect(await resolvedIp('1', '10.0.0.2', '6.6.6.6, 198.51.100.1')).toBe('198.51.100.1');
  });

  it('hop count 2: the second entry from the right; spoofed entries further left are ignored', async () => {
    expect(await resolvedIp('2', '10.0.0.2', '6.6.6.6, 198.51.100.1, 10.0.0.3')).toBe('198.51.100.1');
    expect(await resolvedIp('2', '10.0.0.2', '7.7.7.7, 6.6.6.6, 198.51.100.1, 10.0.0.3')).toBe(
      '198.51.100.1',
    );
  });

  it('hop count: no header gives the socket address', async () => {
    expect(await resolvedIp('1', '10.0.0.2')).toBe('10.0.0.2');
  });

  it('IPv4 list: honoured only from a peer in the list', async () => {
    expect(await resolvedIp('10.0.0.0/8', '10.1.2.3', '198.51.100.1')).toBe('198.51.100.1');
    expect(await resolvedIp('10.0.0.0/8', '203.0.113.7', '198.51.100.1')).toBe('203.0.113.7');
    expect(await resolvedIp('10.0.0.0/8', '::ffff:10.1.2.3', '198.51.100.1')).toBe('198.51.100.1');
    expect(await resolvedIp('192.168.1.1', '192.168.1.1', '198.51.100.1')).toBe('198.51.100.1');
    expect(await resolvedIp('192.168.1.1', '192.168.1.2', '198.51.100.1')).toBe('192.168.1.2');
  });

  it('IPv6 list: honoured only from a peer in the list', async () => {
    expect(await resolvedIp('fd00::/8', 'fd00::5', '2001:db8::99')).toBe('2001:db8::99');
    expect(await resolvedIp('fd00::/8', '2001:db8::5', '2001:db8::99')).toBe('2001:db8::5');
  });

  it('a list skips trusted hops in the chain and stops at the first untrusted one', async () => {
    expect(await resolvedIp('10.0.0.0/8', '10.0.0.2', '6.6.6.6, 198.51.100.1, 10.0.0.9')).toBe(
      '198.51.100.1',
    );
  });

  it('the bundled Compose value trusts a private proxy container but not a public peer', async () => {
    expect(await resolvedIp('loopback,uniquelocal', '172.18.0.4', '198.51.100.1')).toBe('198.51.100.1');
    expect(await resolvedIp('loopback,uniquelocal', '203.0.113.7', '198.51.100.1')).toBe('203.0.113.7');
  });

  it('off (false or 0): never honoured, even from loopback', async () => {
    expect(await resolvedIp('false', '127.0.0.1', '198.51.100.1')).toBe('127.0.0.1');
    expect(await resolvedIp('0', '::1', '198.51.100.1')).toBe('::1');
  });

  it('true: the old behaviour, every hop is trusted', async () => {
    expect(await resolvedIp('true', '203.0.113.7', '198.51.100.1')).toBe('198.51.100.1');
    expect(await resolvedIp('true', '203.0.113.7', '6.6.6.6, 198.51.100.1')).toBe('6.6.6.6');
  });
});

describe('createApp', () => {
  afterAll(async () => {
    await closeAdminPool();
  });

  async function startupLines(env: Record<string, string>): Promise<any[]> {
    const lines: string[] = [];
    const t = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      logStream: { write: (l: string) => void lines.push(l) },
    });
    try {
      return lines.map((l) => JSON.parse(l));
    } finally {
      await t.close();
    }
  }

  it('logs a warning at startup when AOM_TRUST_PROXY=true', async () => {
    const lines = await startupLines({ AOM_TRUST_PROXY: 'true' });
    const warn = lines.find((l) => l.level === 40 && String(l.msg).includes('AOM_TRUST_PROXY'));
    expect(warn).toBeDefined();
  });

  it('logs no warning by default and names what is trusted', async () => {
    const lines = await startupLines({});
    expect(lines.some((l) => l.level === 40 && String(l.msg).includes('AOM_TRUST_PROXY'))).toBe(false);
    expect(lines.find((l) => l.msg === 'trusted proxy')?.trustProxy).toBe('loopback only (default)');
  });

  it('does not start with an invalid value', async () => {
    await expect(createTestApp({ env: { AOM_TRUST_PROXY: '10.0.0.0/33' } })).rejects.toThrow(
      /AOM_TRUST_PROXY/,
    );
  });
});
