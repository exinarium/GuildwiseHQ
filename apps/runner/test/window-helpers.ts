import { createHash, webcrypto } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { HeldStore } from '../src/policy/held.ts';
import { PasskeyStore } from '../src/policy/passkey-store.ts';
import { PolicyStore } from '../src/policy/store.ts';
import type { WindowOffers } from '../src/window/api.ts';
import { writePort } from '../src/window/pairing.ts';
import { type ApprovalsWindowDeps, startApprovalsWindow } from '../src/window/server.ts';

/** Fixtures and a browser stand-in (Node's WebCrypto) for the approvals page tests. Real HTTP on 127.0.0.1. */

export const ORG_A = '0190a000-0000-7000-8000-00000000000a';
export const AGENT_A = '0190a000-0000-7000-8000-0000000000aa';
export const ORG_B = '0190a000-0000-7000-8000-00000000000b';
export const NOT_OFFERED = '0190a000-0000-7000-8000-0000000000ff';
export const REPO = 'https://github.com/acme/website';

export const offersFixture = (): WindowOffers => ({
  orgs: [
    { orgId: ORG_A, orgName: 'Acme Law', role: 'Owner', devopsAgentId: AGENT_A, devopsAgentName: 'Dana' },
    { orgId: ORG_B, orgName: 'Smith & Co', role: 'Member' },
  ],
  repos: [{ url: REPO, name: 'acme-website' }],
});

/** A port free on both 127.0.0.1 and ::1 right now (the OS picks it; never the live runner's). */
export async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const p = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen({ host: '127.0.0.1', port: 0 }, () => {
        const a = s.address();
        s.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
      });
    });
    const v6ok = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.listen({ host: '::1', port: p, ipv6Only: true }, () => s.close(() => resolve(true)));
    });
    if (v6ok) return p;
  }
  throw new Error('no free port');
}

/** Holds a port on one address (another program squatting). */
export function occupy(host: string, port: number): Promise<{ close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen({ host, port, ipv6Only: host === '::1' }, () =>
      resolve({ close: () => new Promise((r) => s.close(() => r())) }),
    );
  });
}

export interface Env {
  dir: string;
  port: number;
  policy: PolicyStore;
  held: HeldStore;
  passkeys: PasskeyStore;
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  clock: { t: number };
  deps: ApprovalsWindowDeps;
}

export async function makeEnv(
  o: { instance?: string | null; dir?: string; port?: number; setupDone?: boolean } = {},
): Promise<Env> {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'aom-window-'));
  const port = o.port ?? (await freePort());
  writePort(dir, port);
  const policy = new PolicyStore(dir);
  if (!o.dir) policy.write({ ...policy.get(), setupDone: o.setupDone ?? true });
  const held = new HeldStore(dir);
  const passkeys = new PasskeyStore(dir);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const clock = { t: Date.parse('2026-11-21T10:00:00Z') };
  const deps: ApprovalsWindowDeps = {
    instance: o.instance === undefined ? 'uat' : o.instance,
    serverOrigins: ['https://uat.example.com'],
    version: '1.10.0',
    status: () => ({
      connected: { 'https://uat.example.com': true },
      shifts: [{ title: 'Builder on "Add a contact form"' }],
      runnerUser: 'guildwise-runner-uat',
    }),
    held,
    policy,
    passkeys,
    offers: offersFixture,
    log,
    decide: (id, state, extra) => held.decide(id, state, 'local', extra),
    dir,
    cli: '/home/guildwise-runner-uat/.local/bin/guildwise-runner',
    now: () => clock.t,
  };
  return { dir, port, policy, held, passkeys, log, clock, deps };
}

export async function startEnv(e: Env) {
  return startApprovalsWindow(e.deps);
}

export interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: () => Record<string, unknown>;
}

/** A raw HTTP request (any Host, any headers), to 127.0.0.1 unless `address` says otherwise. */
export function http(
  port: number,
  path: string,
  o: { method?: string; headers?: Record<string, string>; body?: string | Buffer; address?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) };
    const req = request(
      { host: o.address ?? '127.0.0.1', port, path, method: o.method ?? 'GET', headers, setHost: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      },
    );
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** A same-origin JSON POST, as the page's fetch sends it. */
export function post(port: number, path: string, body: unknown, extra: Record<string, string> = {}) {
  return http(port, path, {
    method: 'POST',
    headers: {
      origin: `http://127.0.0.1:${port}`,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      ...extra,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** A browser: a non-extractable ECDSA P-256 key, as window.js makes it. */
export interface Browser {
  privateKey: webcrypto.CryptoKey;
  spki: string;
  keyHash: string;
}

export async function newBrowser(): Promise<Browser> {
  const kp = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ])) as webcrypto.CryptoKeyPair;
  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', kp.publicKey));
  return {
    privateKey: kp.privateKey,
    spki: spki.toString('base64'),
    keyHash: createHash('sha256').update(spki).digest('hex'),
  };
}

export async function sign(b: Browser, text: string): Promise<string> {
  const sig = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    b.privateKey,
    Buffer.from(text),
  );
  return Buffer.from(sig).toString('base64');
}

export async function challenge(port: number): Promise<string> {
  const r = await http(port, '/api/challenge');
  return r.json().nonce as string;
}

/** Signs in like the page: challenge, signature, session. Returns the response. */
export async function signIn(port: number, b: Browser, instance = 'uat', o: { keyHash?: string } = {}) {
  const nonce = await challenge(port);
  const sig = await sign(b, `gw-approvals|${instance}|${port}|${nonce}`);
  return post(port, '/api/session', { keyHash: o.keyHash ?? b.keyHash, nonce, sig });
}

export const authed = (port: number, token: string, path: string) =>
  http(port, path, { headers: { authorization: `Bearer ${token}` } });

export const change = (port: number, token: string, body: unknown) =>
  post(port, '/api/change', body, { authorization: `Bearer ${token}` });
