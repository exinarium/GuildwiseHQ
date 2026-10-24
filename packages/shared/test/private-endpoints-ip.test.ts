import { describe, expect, it } from 'vitest';
import {
  classifyIp,
  endpointListed,
  isForbiddenEndpointHost,
  isLoopbackHost,
  isPrivateEndpointHost,
  orgCredentialEndpointProblem,
} from '../src/models/private-endpoints.ts';

describe('IP classification (security review finding 7)', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['0:0:0:0:0:ffff:7f00:1', 'loopback'],
    ['::ffff:a9fe:a9fe', 'forbidden'],
    ['::ffff:169.254.169.254', 'forbidden'],
    ['::ffff:0:a9fe:a9fe', 'forbidden'],
    ['::ffff:a00:1', 'private'],
    ['::ffff:c0a8:101', 'private'],
    ['::a9fe:a9fe', 'forbidden'],
    ['::10.0.0.1', 'private'],
    ['64:ff9b::a9fe:a9fe', 'forbidden'],
    ['64:ff9b::7f00:1', 'private'],
    ['64:ff9b::a00:1', 'private'],
    ['64:ff9b::808:808', 'public'],
    ['2002:a9fe:a9fe::1', 'forbidden'],
    ['2002:7f00:1::', 'private'],
    ['2002:c0a8:101::1', 'private'],
    ['2002:808:808::1', 'public'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'private'],
    ['fec0::1', 'private'],
    ['fd00::5', 'private'],
    ['fe80::1', 'forbidden'],
    ['ff02::1', 'forbidden'],
    ['::', 'forbidden'],
    ['::ffff:8.8.8.8', 'public'],
    ['2606:4700::1111', 'public'],
    ['8.8.8.8', 'public'],
    ['100.64.0.1', 'private'],
    ['169.254.169.254', 'forbidden'],
  ])('%s is %s', (ip, cls) => {
    expect(classifyIp(ip)).toBe(cls);
  });

  it('names are not literals', () => {
    expect(classifyIp('example.com')).toBeUndefined();
    expect(classifyIp('1.2.3')).toBeUndefined();
    expect(classifyIp('999.1.1.1')).toBeUndefined();
  });

  it('*.localhost is always loopback', () => {
    for (const h of ['localhost', 'a.localhost', 'x.y.localhost', 'LOCALHOST.', 'evil.localhost.']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    expect(isLoopbackHost('localhost.evil.com')).toBe(false);
    expect(isLoopbackHost('::ffff:7f00:1')).toBe(true);
    expect(isLoopbackHost('2002:7f00:1::')).toBe(false);
  });

  it('the forbidden and private predicates see through the hex forms', () => {
    expect(isForbiddenEndpointHost('::ffff:a9fe:a9fe')).toBe(true);
    expect(isPrivateEndpointHost('::ffff:c0a8:101')).toBe(true);
    expect(isPrivateEndpointHost('8.8.8.8')).toBe(false);
  });

  it('a listing matches an IPv6 literal however it is written', () => {
    expect(endpointListed('fd00:0:0:0:0:0:0:5', 80, ['[fd00::5]:80'])).toBe(true);
    expect(endpointListed('fd00::6', 80, ['[fd00::5]:80'])).toBe(false);
  });
});

describe('orgCredentialEndpointProblem (security review finding 6)', () => {
  it('accepts https to a public host', () => {
    expect(orgCredentialEndpointProblem('https://api.example.com/v1', [])).toBeUndefined();
    expect(orgCredentialEndpointProblem('https://8.8.8.8/v1', [])).toBeUndefined();
  });
  it('refuses plain http to a public host', () => {
    expect(orgCredentialEndpointProblem('http://api.example.com/v1', [])).toMatch(/https/);
  });
  it('refuses loopback in every spelling, even over https', () => {
    for (const u of [
      'https://127.0.0.1:8443',
      'http://localhost:11434',
      'https://x.localhost',
      'http://[::1]:80',
      'http://[::ffff:7f00:1]:80',
      'http://[::ffff:127.0.0.1]:80',
    ])
      expect(orgCredentialEndpointProblem(u, []), u).toBeTruthy();
  });
  it('refuses private addresses unless the owner listed that exact host:port', () => {
    expect(orgCredentialEndpointProblem('http://192.168.1.12:11434', [])).toBeTruthy();
    expect(orgCredentialEndpointProblem('http://192.168.1.12:11434', ['192.168.1.12:11434'])).toBeUndefined();
    expect(orgCredentialEndpointProblem('http://192.168.1.12:11435', ['192.168.1.12:11434'])).toBeTruthy();
  });
  it('a listed loopback entry opens loopback, an unlisted one does not', () => {
    expect(orgCredentialEndpointProblem('http://127.0.0.1:11434', ['127.0.0.1:11434'])).toBeUndefined();
    expect(orgCredentialEndpointProblem('http://127.0.0.1:11435', ['127.0.0.1:11434'])).toBeTruthy();
  });
  it('metadata and link-local are never allowed, listed or not', () => {
    for (const u of [
      'https://169.254.169.254',
      'http://metadata.google.internal',
      'https://[::ffff:a9fe:a9fe]',
      'http://[fe80::1]',
    ])
      expect(orgCredentialEndpointProblem(u, ['169.254.169.254:443', '169.254.169.254:80']), u).toBeTruthy();
  });
  it('a bad URL or scheme is a problem', () => {
    expect(orgCredentialEndpointProblem('nope', [])).toBeTruthy();
    expect(orgCredentialEndpointProblem('ftp://x.example.com', [])).toBeTruthy();
  });
});

describe('backend URLs go through the same checks (finding 6)', async () => {
  const { validateBackendFields, backendEndpointProblem } = await import('../src/models/backends.ts');
  const gw = (baseUrl: string) => ({ baseUrl, apiKey: 'k' });
  it('refuses metadata for every credential', () => {
    expect(validateBackendFields('gateway', gw('http://169.254.169.254/v1'))).toMatch(/metadata/);
    expect(validateBackendFields('gateway', gw('https://[::ffff:a9fe:a9fe]/v1'))).toMatch(/metadata/);
  });
  it('an organization gateway must be https to a public address', () => {
    const org = { orgSourced: true, endpoints: [] as string[] };
    expect(validateBackendFields('gateway', gw('https://llm.example.com'), org)).toBeNull();
    expect(validateBackendFields('gateway', gw('http://llm.example.com'), org)).toMatch(/https/);
    expect(validateBackendFields('gateway', gw('https://127.0.0.1:4000'), org)).toBeTruthy();
    expect(backendEndpointProblem('gateway', gw('http://10.0.0.5:4000'), org)).toBeTruthy();
    expect(
      backendEndpointProblem('gateway', gw('http://10.0.0.5:4000'), {
        orgSourced: true,
        endpoints: ['10.0.0.5:4000'],
      }),
    ).toBeNull();
  });
  it('the workstation own gateway keeps loopback', () => {
    expect(validateBackendFields('gateway', gw('http://127.0.0.1:4000'), { endpoints: [] })).toBeNull();
    expect(validateBackendFields('gateway', gw('http://192.168.1.9:4000'), { endpoints: [] })).toBeTruthy();
  });
});
