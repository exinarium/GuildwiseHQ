import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAIR_CODE_RE } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { HeldRecord } from '../src/policy/held.ts';
import { readAudit } from '../src/window/audit.ts';
import { approvalsPair, approvalsPort } from '../src/window/cli.ts';
import { DeviceStore, readPort } from '../src/window/pairing.ts';
import { type ApprovalsWindow, startApprovalsWindow } from '../src/window/server.ts';
import {
  AGENT_A,
  authed,
  type Browser,
  change,
  type Env,
  freePort,
  http,
  makeEnv,
  NOT_OFFERED,
  newBrowser,
  ORG_A,
  ORG_B,
  occupy,
  post,
  REPO,
  sign,
  signIn,
  startEnv,
} from './window-helpers.ts';

/**
 * The approvals page's security contract (DESIGN "Approvals window" [B1, B2, B3, R2-B1, R2-S1, S1]), over real HTTP on
 * 127.0.0.1 with temp policy dirs.
 */

const open: ApprovalsWindow[] = [];
afterEach(async () => {
  while (open.length) await (open.pop() as ApprovalsWindow).close();
});
async function up(e: Env): Promise<ApprovalsWindow> {
  const w = await startEnv(e);
  open.push(w);
  return w;
}

/** Pairs a browser the way a person does: the page asks, the terminal confirms. */
async function pair(e: Env, b: Browser): Promise<string> {
  const r = await post(e.port, '/api/pair', { spki: b.spki });
  expect(r.status).toBe(200);
  const code = r.json().code as string;
  await approvalsPair(
    { dir: e.dir, instance: 'uat', now: () => e.clock.t, out: () => {}, ask: async () => 'yes' },
    code,
  );
  return code;
}

async function session(e: Env, b: Browser): Promise<string> {
  const r = await signIn(e.port, b, (e.deps.instance as string) ?? 'default');
  expect(r.status).toBe(200);
  return r.json().token as string;
}

function heldItem(e: Env, over: Partial<HeldRecord> = {}): HeldRecord {
  const at = new Date(e.clock.t).toISOString();
  const r: HeldRecord = {
    id: 'abc123def0',
    kind: 'deploy.exec',
    pairing: '/data/p1',
    summary: 'Publish acme-website to production',
    detail: 'deploy acme-website\ncommit 1234567',
    commandHash: 'c'.repeat(64),
    createdAt: at,
    expiresAt: new Date(e.clock.t + 3_600_000).toISOString(),
    replay: { type: 'command', body: {} },
    pin: { base: 'a'.repeat(64), bound: 'b'.repeat(64) },
    state: 'held',
    ...over,
  };
  e.held.put(r);
  return r;
}

describe('binding [B1]', () => {
  it('binds 127.0.0.1 and ::1 on the stored port and answers on both', async () => {
    const e = await makeEnv();
    const w = await up(e);
    expect(w.windowError).toBeUndefined();
    expect(w.port).toBe(e.port);
    expect(w.addresses).toEqual(['127.0.0.1', '::1']);
    expect((await http(e.port, '/')).status).toBe(200);
    expect((await http(e.port, '/', { address: '::1' })).status).toBe(200);
  });

  it('first start picks a port in the range and stores it', async () => {
    const e = await makeEnv();
    const p = await freePort();
    writeFileSync(join(e.dir, 'window', 'port'), 'not a port\n');
    const w = await startApprovalsWindow({ ...e.deps, portRange: [p, p] });
    open.push(w);
    expect(w.port).toBe(p);
    expect(readPort(e.dir)).toBe(p);
    expect(statSync(join(e.dir, 'window', 'port')).mode & 0o777).toBe(0o600);
  });

  for (const host of ['127.0.0.1', '::1'])
    it(`refuses to start and sets windowError when ${host} on the port is taken`, async () => {
      const e = await makeEnv();
      const squat = await occupy(host, e.port);
      try {
        const w = await up(e);
        expect(w.windowError).toBe(`another program uses port ${e.port}`);
        expect(w.addresses).toEqual([]);
        expect(e.log.warn).toHaveBeenCalledWith(
          `approvals page not started: another program uses port ${e.port}`,
        );
        // nothing stays bound on the other address either
        const other = await occupy(host === '::1' ? '127.0.0.1' : '::1', e.port);
        await other.close();
        // the port is never re-picked
        expect(readPort(e.dir)).toBe(e.port);
      } finally {
        await squat.close();
      }
    });
});

describe('every request', () => {
  it('Host must be exactly 127.0.0.1:<port> (421 otherwise, localhost too)', async () => {
    const e = await makeEnv();
    await up(e);
    for (const host of [`localhost:${e.port}`, 'evil.example', `[::1]:${e.port}`, '127.0.0.1', `127.0.0.1:1`])
      expect((await http(e.port, '/', { headers: { host } })).status, host).toBe(421);
    expect(
      (await http(e.port, '/api/challenge', { headers: { host: `evil.example:${e.port}` } })).status,
    ).toBe(421);
  });

  it('non-GET: a bad or missing Origin, a cross-site fetch or a form post gets 403', async () => {
    const e = await makeEnv();
    await up(e);
    const b = await newBrowser();
    const body = JSON.stringify({ spki: b.spki });
    const good = {
      origin: `http://127.0.0.1:${e.port}`,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    };
    const cases: Array<Record<string, string>> = [
      { ...good, origin: 'http://evil.example' },
      { ...good, origin: `http://localhost:${e.port}` },
      { 'content-type': 'application/json' },
      { ...good, 'sec-fetch-site': 'cross-site' },
      { ...good, 'sec-fetch-site': 'same-site' },
      { ...good, 'content-type': 'application/x-www-form-urlencoded' },
      { ...good, 'content-type': 'text/plain' },
      { ...good, 'content-type': 'multipart/form-data; boundary=x' },
    ];
    for (const headers of cases) {
      for (const path of ['/api/pair', '/api/session', '/api/change']) {
        const r = await http(e.port, path, { method: 'POST', headers, body });
        expect(r.status, `${path} ${JSON.stringify(headers)}`).toBe(403);
      }
    }
    expect(new DeviceStore(e.dir).pending()).toEqual([]);
    expect((await http(e.port, '/api/pair', { method: 'POST', headers: good, body })).status).toBe(200);
  });

  it('security headers on every response and never a CORS header', async () => {
    const e = await makeEnv();
    await up(e);
    const responses = [
      await http(e.port, '/'),
      await http(e.port, '/window.js'),
      await http(e.port, '/api/state'),
      await http(e.port, '/', { headers: { host: 'evil.example' } }),
      await http(e.port, '/api/pair', {
        method: 'OPTIONS',
        headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
      }),
    ];
    for (const r of responses) {
      expect(r.headers['content-security-policy']).toBe(
        "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
  });
});

describe('without a session [B3]', () => {
  it('only the sign-in page, its static files and the sign-in calls answer; everything else is 401', async () => {
    const e = await makeEnv();
    await up(e);
    for (const p of [
      '/',
      '/window.js',
      '/window.css',
      '/tokens.css',
      '/logo-light.svg',
      '/logo-dark.svg',
      '/favicon.svg',
      '/geist-latin.woff2',
      '/geist-latin-ext.woff2',
      '/api/hello',
      '/api/challenge',
    ])
      expect((await http(e.port, p)).status, p).toBe(200);
    for (const p of ['/api/state', '/api/devices', '/nope', '/api/state?x=1', '/../policy.json'])
      expect((await http(e.port, p)).status, p).toBe(401);
    expect((await http(e.port, '/api/state', { headers: { authorization: 'Bearer abc' } })).status).toBe(401);
    expect((await post(e.port, '/api/change', { action: 'devops.grant', orgId: ORG_A })).status).toBe(401);
    expect(e.policy.get().devops.agents).toEqual({});
  });
});

describe('pairing and sessions [B1, B2]', () => {
  it('pairs through the terminal, then signs in with a fresh challenge', async () => {
    const e = await makeEnv();
    await up(e);
    const b = await newBrowser();
    const r = await post(e.port, '/api/pair', { spki: b.spki }, { 'user-agent': 'Firefox 140' });
    const j = r.json();
    expect(j.code).toMatch(PAIR_CODE_RE);
    expect(j.fingerprint).toBe(b.keyHash.slice(0, 8));
    expect(j.command).toBe(`/home/guildwise-runner-uat/.local/bin/guildwise-runner approvals pair ${j.code}`);
    const pending = join(e.dir, 'window', 'pending', `${j.code}.json`);
    expect(statSync(pending).mode & 0o777).toBe(0o600);
    // not paired yet
    expect((await signIn(e.port, b)).status).toBe(401);
    const out: string[] = [];
    const asked: string[] = [];
    await approvalsPair(
      {
        dir: e.dir,
        instance: 'uat',
        now: () => e.clock.t,
        out: (l) => out.push(l),
        ask: async (q) => {
          asked.push(q);
          return 'yes';
        },
      },
      String(j.code).toLowerCase(),
    );
    expect(out.join('\n')).toContain(`fingerprint ${b.keyHash.slice(0, 8)}`);
    expect(out.join('\n')).toContain('The browser says it is: ');
    expect(out.join('\n')).toContain('Firefox 140');
    expect(out.join('\n')).toMatch(/asked to pair \d+ (seconds|minutes) ago/);
    expect(out.join('\n')).toContain('Never one that came from the website, an e-mail, a chat or an agent');
    expect(asked).toEqual([
      `Did you click "Pair this browser" on this computer in the last few minutes, and does that page show fingerprint ${b.keyHash.slice(0, 8)}? If so, type "yes" to pair it with uat: `,
    ]);
    expect(statSync(join(e.dir, 'window', 'devices.json')).mode & 0o777).toBe(0o600);
    const token = await session(e, b);
    const st = await authed(e.port, token, '/api/state');
    expect(st.status).toBe(200);
    // the token is never stored on disk
    for (const f of readdirSync(join(e.dir, 'window')))
      if (f !== 'pending') expect(readFileSync(join(e.dir, 'window', f), 'utf8')).not.toContain(token);
  });

  it('pairing needs a terminal, and anything but "yes" pairs nothing', async () => {
    const e = await makeEnv();
    await up(e);
    const b = await newBrowser();
    const code = (await post(e.port, '/api/pair', { spki: b.spki })).json().code as string;
    await expect(
      approvalsPair({ dir: e.dir, instance: 'uat', now: () => e.clock.t, out: () => {} }, code),
    ).rejects.toThrow(/terminal/);
    await expect(
      approvalsPair(
        { dir: e.dir, instance: 'uat', now: () => e.clock.t, out: () => {}, ask: async () => 'y' },
        code,
      ),
    ).rejects.toThrow(/not paired/);
    expect(new DeviceStore(e.dir).devices()).toEqual([]);
    expect((await signIn(e.port, b)).status).toBe(401);
  });

  it('a nonce is single-use and expires after 60 seconds', async () => {
    const e = await makeEnv();
    await up(e);
    const b = await newBrowser();
    await pair(e, b);
    const nonce = (await http(e.port, '/api/challenge')).json().nonce as string;
    // self-checking: <expiry>.<32 random bytes>.<mac> under a key only this process holds
    expect(nonce).toMatch(/^\d+\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{32}$/);
    const sig = await sign(b, `gw-approvals|uat|${e.port}|${nonce}`);
    expect((await post(e.port, '/api/session', { keyHash: b.keyHash, nonce, sig })).status).toBe(200);
    expect((await post(e.port, '/api/session', { keyHash: b.keyHash, nonce, sig })).status).toBe(401);
    const late = (await http(e.port, '/api/challenge')).json().nonce as string;
    e.clock.t += 61_000;
    const sig2 = await sign(b, `gw-approvals|uat|${e.port}|${late}`);
    expect((await post(e.port, '/api/session', { keyHash: b.keyHash, nonce: late, sig: sig2 })).status).toBe(
      401,
    );
    // a nonce the runner never issued
    const made = Buffer.alloc(32, 7).toString('base64url');
    const sig3 = await sign(b, `gw-approvals|uat|${e.port}|${made}`);
    expect((await post(e.port, '/api/session', { keyHash: b.keyHash, nonce: made, sig: sig3 })).status).toBe(
      401,
    );
  });

  it("instance A's key is refused by instance B, even with A's devices.json copied over", async () => {
    const a = await makeEnv({ instance: 'uat' });
    const bEnv = await makeEnv({ instance: 'prod' });
    await up(a);
    await up(bEnv);
    const b = await newBrowser();
    await pair(a, b);
    expect((await signIn(a.port, b, 'uat')).status).toBe(200);
    // B never paired this browser
    expect((await signIn(bEnv.port, b, 'prod')).status).toBe(401);
    // a signature over A's text (instance uat, A's port) for B's nonce
    writeFileSync(
      join(bEnv.dir, 'window', 'devices.json'),
      readFileSync(join(a.dir, 'window', 'devices.json')),
    );
    const nonce = (await http(bEnv.port, '/api/challenge')).json().nonce as string;
    const sig = await sign(b, `gw-approvals|uat|${a.port}|${nonce}`);
    expect((await post(bEnv.port, '/api/session', { keyHash: b.keyHash, nonce, sig })).status).toBe(401);
  });

  it('a session token dies with the runner restart', async () => {
    const e = await makeEnv();
    const w = await up(e);
    const b = await newBrowser();
    await pair(e, b);
    const token = await session(e, b);
    expect((await authed(e.port, token, '/api/state')).status).toBe(200);
    await w.close();
    open.splice(open.indexOf(w), 1);
    await up(e);
    expect((await authed(e.port, token, '/api/state')).status).toBe(401);
    // the browser itself signs in again silently
    expect((await signIn(e.port, b)).status).toBe(200);
  });

  it('a copied devices.json entry without the private key gets no session', async () => {
    const e = await makeEnv();
    await up(e);
    const victim = await newBrowser();
    await pair(e, victim);
    const thief = await newBrowser();
    expect((await signIn(e.port, thief, 'uat', { keyHash: victim.keyHash })).status).toBe(401);
    expect((await signIn(e.port, victim)).status).toBe(200);
  });

  it('a session ends after 30 idle minutes and when the browser is forgotten', async () => {
    const e = await makeEnv();
    await up(e);
    const b = await newBrowser();
    await pair(e, b);
    let token = await session(e, b);
    e.clock.t += 29 * 60_000;
    expect((await authed(e.port, token, '/api/state')).status).toBe(200);
    e.clock.t += 31 * 60_000;
    expect((await authed(e.port, token, '/api/state')).status).toBe(401);
    token = await session(e, b);
    new DeviceStore(e.dir).forget(b.keyHash.slice(0, 8));
    expect((await authed(e.port, token, '/api/state')).status).toBe(401);
  });

  it('[R2-B1] after `approvals port <new>` the paired key gets 401, devices.json is empty and an audit line is written', async () => {
    const e = await makeEnv();
    await up(e);
    const b = await newBrowser();
    await pair(e, b);
    const token = await session(e, b);
    const next = await freePort();
    await expect(
      approvalsPort({ dir: e.dir, instance: 'uat', now: () => e.clock.t, out: () => {} }, String(next)),
    ).rejects.toThrow(/terminal/);
    await approvalsPort(
      { dir: e.dir, instance: 'uat', now: () => e.clock.t, out: () => {}, ask: async () => 'yes' },
      String(next),
    );
    expect(new DeviceStore(e.dir).devices()).toEqual([]);
    expect(readPort(e.dir)).toBe(next);
    const line = readAudit(e.dir).find((l) => l.action === 'port');
    expect(line).toMatchObject({
      target: `port ${next}`,
      before: { port: e.port, devices: 1 },
      after: { port: next },
    });
    // the running page drops the session at once; the moved page knows no browser
    expect((await authed(e.port, token, '/api/state')).status).toBe(401);
    const moved = await makeEnv({ dir: e.dir, port: next });
    await up(moved);
    expect((await signIn(next, b)).status).toBe(401);
  });

  it('[R2-S1] a pair body over 1 KB gets 413; an 11th request drops the oldest; codes are unique and never from the client', async () => {
    const e = await makeEnv();
    await up(e);
    const b = await newBrowser();
    expect((await post(e.port, '/api/pair', { spki: b.spki, pad: 'x'.repeat(1100) })).status).toBe(413);
    expect((await post(e.port, '/api/pair', { spki: b.spki, code: 'AAAA-AA' })).status).toBe(400);
    expect(
      (await post(e.port, '/api/pair', { spki: 'bm90IGEga2V5IGF0IGFsbCBidXQgbG9uZyBlbm91Z2g=' })).status,
    ).toBe(400);
    const codes: string[] = [];
    for (let i = 0; i < 11; i++) {
      e.clock.t += 1000;
      const r = await post(e.port, '/api/pair', { spki: (await newBrowser()).spki });
      expect(r.status).toBe(200);
      codes.push(r.json().code as string);
    }
    expect(new Set(codes).size).toBe(11);
    for (const c of codes) expect(c).toMatch(PAIR_CODE_RE);
    const waiting = new DeviceStore(e.dir, () => e.clock.t).pending().map((p) => p.code);
    expect(waiting).toHaveLength(10);
    expect(waiting).not.toContain(codes[0]);
    expect(waiting).toContain(codes[10]);
    // and a waiting request expires after 10 minutes
    e.clock.t += 10 * 60_000 + 1;
    expect(new DeviceStore(e.dir, () => e.clock.t).pending()).toEqual([]);
  });
});

describe('what the page may change [S1]', () => {
  async function signedIn(o: { setupDone?: boolean } = {}) {
    const e = await makeEnv(o);
    await up(e);
    const b = await newBrowser();
    await pair(e, b);
    return { e, b, token: await session(e, b) };
  }

  it('refuses every read-only field and anything off the list (403, logged, nothing written)', async () => {
    const { e, token } = await signedIn();
    const before = readFileSync(e.policy.file, 'utf8');
    const refused = [
      { action: 'docker', value: 'host' },
      { action: 'acceptRootEquivalent', value: true },
      { action: 'allowUnsignedUpdatesFrom', origin: 'https://evil.example' },
      { action: 'updates.allowUnsigned', origin: 'https://evil.example' },
      { action: 'signingKeys', keyId: 'ABCDEF0123456789' },
      { action: 'signing.addKey', keyId: 'ABCDEF0123456789', autoSign: true },
      { action: 'release.sign' },
      { action: 'ceo.fullPower', on: true },
      { action: 'ceo.turn' },
      { action: 'installRegistries', host: 'evil.example' },
      { action: 'installNetworkConfig', on: true },
      { action: 'allowDocker', on: true },
      { action: 'runnerUser', name: 'root' },
      { action: 'setupDone', on: true },
      { action: 'devopsAgentRequests', mode: 'ask' },
      { action: 'held.approveAll' },
      { action: 'policy.write', policy: {} },
      { action: 'devops.grant', orgId: ORG_A, agentId: AGENT_A },
      { action: 'devops.grant', orgId: ORG_A, docker: 'host' },
      { action: 'repo.scripts', url: REPO, allow: true, extra: 1 },
      {},
      [],
      '"devops.grant"',
    ];
    for (const body of refused) {
      const r = await change(e.port, token, body);
      expect(r.status, JSON.stringify(body)).toBe(403);
    }
    expect(readFileSync(e.policy.file, 'utf8')).toBe(before);
    expect(readAudit(e.dir).filter((l) => l.action === 'refused').length).toBe(refused.length);
  });

  it('DevOps grant and revoke only for an offered organization with a helper', async () => {
    const { e, b, token } = await signedIn();
    expect((await change(e.port, token, { action: 'devops.grant', orgId: NOT_OFFERED })).status).toBe(403);
    expect((await change(e.port, token, { action: 'devops.grant', orgId: ORG_B })).status).toBe(409);
    expect((await change(e.port, token, { action: 'devops.grant', orgId: ORG_A })).status).toBe(200);
    expect(e.policy.get().devops.agents).toEqual({ [ORG_A]: AGENT_A });
    expect(statSync(e.policy.file).mode & 0o777).toBe(0o600);
    const line = readAudit(e.dir).find((l) => l.action === 'devops.grant');
    expect(line).toMatchObject({
      device: b.keyHash.slice(0, 12),
      target: ORG_A,
      before: null,
      after: AGENT_A,
    });
    expect((await change(e.port, token, { action: 'devops.revoke', orgId: ORG_A })).status).toBe(200);
    expect(e.policy.get().devops.agents).toEqual({});
  });

  it('the other writable settings write what the CLI writes, each with an audit line', async () => {
    const { e, b, token } = await signedIn();
    const ok = async (body: unknown) => expect((await change(e.port, token, body)).status).toBe(200);
    await ok({ action: 'devops.requests', mode: 'auto' });
    await ok({ action: 'repo.scripts', url: REPO, allow: true });
    expect(
      (await change(e.port, token, { action: 'repo.scripts', url: 'https://github.com/evil/x', allow: true }))
        .status,
    ).toBe(403);
    await ok({ action: 'deploy.mode', mode: 'off' });
    await ok({ action: 'deploy.pinCommit', on: true });
    await ok({ action: 'formatter.pin', hash: 'd'.repeat(64), add: true });
    const p = e.policy.get();
    expect(p.devopsRequests).toBe('auto');
    expect(p.installScripts).toEqual({ 'github.com/acme/website': true });
    expect(p.deploy).toBe('off');
    expect(p.deployPinCommit).toBe(true);
    expect(p.formatterPins).toEqual(['d'.repeat(64)]);
    const lines = readAudit(e.dir);
    for (const a of ['devops.requests', 'repo.scripts', 'deploy.mode', 'deploy.pinCommit', 'formatter.pin'])
      expect(lines.find((l) => l.action === a)?.device, a).toBe(b.keyHash.slice(0, 12));
    // never a token, nonce or pairing code in the audit log or the runner log
    const text = readFileSync(join(e.dir, 'window', 'audit.log'), 'utf8');
    expect(text).not.toContain(token);
    expect(JSON.stringify(e.log.info.mock.calls)).not.toContain(token);
  });

  it('removing a remembered vault online location only narrows; an unknown one is 404', async () => {
    const { e, b, token } = await signedIn();
    e.policy.write({
      ...e.policy.get(),
      vaultRemotes: [{ vaultId: 'g', remote: 'git.example/acme/vault' }],
    });
    expect(
      (await change(e.port, token, { action: 'vault.forget', vaultId: 'g', remote: 'git.example/other' }))
        .status,
    ).toBe(404);
    expect(
      (
        await change(e.port, token, {
          action: 'vault.forget',
          vaultId: 'g',
          remote: 'git.example/acme/vault',
        })
      ).status,
    ).toBe(200);
    expect(e.policy.get().vaultRemotes).toEqual([]);
    expect(readAudit(e.dir).find((l) => l.action === 'vault.forget')?.device).toBe(b.keyHash.slice(0, 12));
    // adding one is not on the list: only a held vault set-up that you approve adds it
    expect(
      (await change(e.port, token, { action: 'vault.remember', vaultId: 'g', remote: 'git.example/x' }))
        .status,
    ).toBe(403);
  });

  it('passkey trust takes a pending offer; remove takes a trusted one', async () => {
    const { e, token } = await signedIn();
    e.passkeys.addOffer(
      {
        passkeyId: '0190a000-0000-7000-8000-0000000000cc',
        credentialId: 'cred_abc123',
        publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE',
        alg: -7,
        rpId: 'uat.example.com',
        origin: 'https://uat.example.com',
        name: 'Laptop',
        createdAt: new Date(e.clock.t).toISOString(),
      },
      '/data/p1',
      'https://uat.example.com',
    );
    expect((await change(e.port, token, { action: 'passkey.trust', credentialId: 'nope' })).status).toBe(404);
    expect(
      (await change(e.port, token, { action: 'passkey.trust', credentialId: 'cred_abc123' })).status,
    ).toBe(200);
    expect(e.policy.get().passkeys.map((k) => k.credentialId)).toEqual(['cred_abc123']);
    expect(e.passkeys.offers()).toEqual([]);
    expect(
      (await change(e.port, token, { action: 'passkey.remove', credentialId: 'cred_abc123' })).status,
    ).toBe(200);
    expect(e.policy.get().passkeys).toEqual([]);
  });

  it('held items: one at a time through the decide hook, with "also pin" for deploys', async () => {
    const { e, token } = await signedIn();
    const r = heldItem(e);
    const st = (await authed(e.port, token, '/api/state')).json() as {
      waiting: Array<Record<string, unknown>>;
    };
    expect(st.waiting).toMatchObject([
      {
        id: r.id,
        what: 'Publish an app',
        canPin: true,
        command: `/home/guildwise-runner-uat/.local/bin/guildwise-runner approve ${r.id}`,
      },
    ]);
    expect((await change(e.port, token, { action: 'held.approve', id: r.id, pin: true })).status).toBe(200);
    expect(e.held.get(r.id)).toMatchObject({ state: 'approved', decidedBy: 'local', pinned: true });
    expect(e.policy.get().deployPins).toEqual(['a'.repeat(64)]);
    expect((await change(e.port, token, { action: 'held.approve', id: r.id })).status).toBe(404);
    const d = heldItem(e, { id: 'den1ed0000', kind: 'devops.task', pin: undefined });
    expect((await change(e.port, token, { action: 'held.approve', id: d.id, pin: true })).status).toBe(400);
    expect((await change(e.port, token, { action: 'held.deny', id: d.id })).status).toBe(200);
    expect(e.held.get(d.id)?.state).toBe('denied');
    expect(readAudit(e.dir).map((l) => l.action)).toEqual(
      expect.arrayContaining(['held.approve', 'held.deny']),
    );
  });

  it('approve respects "setup pending" and leaves release.sign to the terminal', async () => {
    const { e, token } = await signedIn({ setupDone: false });
    const r = heldItem(e);
    const res = await change(e.port, token, { action: 'held.approve', id: r.id });
    expect(res.status).toBe(409);
    expect(String(res.json().error)).toContain('guildwise-runner setup');
    expect(e.held.get(r.id)?.state).toBe('held');
    e.policy.update((p) => ({ ...p, setupDone: true }));
    const s = heldItem(e, { id: 'sign000001', kind: 'release.sign', pin: undefined });
    expect((await change(e.port, token, { action: 'held.approve', id: s.id })).status).toBe(409);
    expect(e.held.get(s.id)?.state).toBe('held');
  });
});

describe('header', () => {
  it('names the instance and the server host; a non-prod instance is warning-coloured', async () => {
    const uat = await makeEnv({ instance: 'uat' });
    const prod = await makeEnv({ instance: 'prod' });
    const single = await makeEnv({ instance: null });
    await up(uat);
    await up(prod);
    await up(single);
    expect((await http(uat.port, '/api/hello')).json()).toEqual({
      instance: 'uat',
      warn: true,
      serverHost: 'uat.example.com',
      port: uat.port,
    });
    expect((await http(prod.port, '/api/hello')).json()).toMatchObject({ instance: 'prod', warn: false });
    expect((await http(single.port, '/api/hello')).json()).toMatchObject({
      instance: 'default',
      warn: false,
    });
  });
});

describe('approvals CLI', () => {
  it('registers pair, devices, forget and port; forget removes one browser or all, with audit lines', async () => {
    const { Command } = await import('commander');
    const { registerApprovalsCommands, approvalsDevices, approvalsForget } = await import(
      '../src/window/cli.ts'
    );
    const program = new Command();
    registerApprovalsCommands(program);
    const a = program.commands.find((c) => c.name() === 'approvals');
    expect(a?.commands.map((c) => c.name())).toEqual(['pair', 'devices', 'forget', 'port']);

    const e = await makeEnv();
    await up(e);
    const b1 = await newBrowser();
    const b2 = await newBrowser();
    await pair(e, b1);
    await pair(e, b2);
    const out: string[] = [];
    const d = { dir: e.dir, instance: 'uat', now: () => e.clock.t, out: (l: string) => out.push(l) };
    approvalsDevices(d);
    expect(out.join('\n')).toContain(b1.keyHash.slice(0, 8));
    expect(out.join('\n')).toContain(`http://127.0.0.1:${e.port}/`);
    expect(() => approvalsForget(d, 'zz', false)).toThrow(/use:/);
    approvalsForget(d, b1.keyHash.slice(0, 8), false);
    expect(new DeviceStore(e.dir).devices().map((x) => x.keyHash)).toEqual([b2.keyHash]);
    expect((await signIn(e.port, b1)).status).toBe(401);
    approvalsForget(d, undefined, true);
    expect(new DeviceStore(e.dir).devices()).toEqual([]);
    const actions = readAudit(e.dir).map((l) => l.action);
    expect(actions.filter((x) => x === 'pair')).toHaveLength(2);
    expect(actions.filter((x) => x === 'forget')).toHaveLength(2);
    // a pairing code never reaches the audit log
    for (const l of readAudit(e.dir))
      expect(JSON.stringify(l)).not.toMatch(/[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}/);
  });
});

describe('review nits: nonces, port pick, a moved page (zero known vulnerabilities)', () => {
  it('a flood of challenges pushes no real challenge out, and a forged nonce is refused', async () => {
    const e = await makeEnv();
    await up(e);
    const b = await newBrowser();
    await pair(e, b);
    const real = (await http(e.port, '/api/challenge')).json().nonce as string;
    for (let i = 0; i < 300; i++) await http(e.port, '/api/challenge');
    const sig = await sign(b, `gw-approvals|uat|${e.port}|${real}`);
    expect((await post(e.port, '/api/session', { keyHash: b.keyHash, nonce: real, sig })).status).toBe(200);
    const [exp, rnd] = real.split('.');
    const forged = `${Number(exp) + 3_600_000}.${rnd}.${'A'.repeat(32)}`;
    const sig2 = await sign(b, `gw-approvals|uat|${e.port}|${forged}`);
    expect(
      (await post(e.port, '/api/session', { keyHash: b.keyHash, nonce: forged, sig: sig2 })).status,
    ).toBe(401);
  });

  it('a fresh port pick (port file lost) forgets every paired browser and writes an audit line', async () => {
    const e = await makeEnv();
    const w = await up(e);
    const b = await newBrowser();
    await pair(e, b);
    await w.close();
    open.splice(open.indexOf(w), 1);
    const p = await freePort();
    writeFileSync(join(e.dir, 'window', 'port'), 'garbage\n');
    const w2 = await startApprovalsWindow({ ...e.deps, portRange: [p, p] });
    open.push(w2);
    expect(w2.port).toBe(p);
    expect(new DeviceStore(e.dir).devices()).toEqual([]);
    expect(readAudit(e.dir).find((l) => l.action === 'port-picked')).toMatchObject({
      before: { devices: 1 },
    });
    expect((await signIn(p, b)).status).toBe(401);
  });

  it('a port that cannot be kept serves nothing (no page answering 503 until restart)', async () => {
    const e = await makeEnv();
    rmSync(join(e.dir, 'window', 'port'));
    mkdirSync(join(e.dir, 'window', 'port'));
    const p = await freePort();
    const w = await startApprovalsWindow({ ...e.deps, portRange: [p, p] });
    open.push(w);
    expect(w.windowError).toMatch(/could not keep port/);
    await expect(http(p, '/')).rejects.toThrow();
  });

  it('after `approvals port`, the old page pairs nothing until the restart', async () => {
    const e = await makeEnv();
    await up(e);
    const b = await newBrowser();
    writeFileSync(join(e.dir, 'window', 'port'), `${await freePort()}\n`);
    expect((await post(e.port, '/api/pair', { spki: b.spki })).status).toBe(409);
  });
});

describe('a repository address with a password (zero known vulnerabilities)', () => {
  it('is refused by the page, never written to the policy or the audit log', async () => {
    const e = await makeEnv();
    await up(e);
    const b = await newBrowser();
    await pair(e, b);
    const token = (await signIn(e.port, b)).json().token as string;
    const url = 'https://alice:s3cret-PW@github.com/acme/website';
    const r = await change(e.port, token, { action: 'repo.scripts', url, allow: true });
    expect(r.status).toBe(400);
    expect(e.policy.get().installScripts).toEqual({});
    const text = (() => {
      try {
        return readFileSync(join(e.dir, 'window', 'audit.log'), 'utf8');
      } catch {
        return '';
      }
    })();
    expect(text).not.toContain('s3cret-PW');
    expect(JSON.stringify([e.log.info.mock.calls, e.log.warn.mock.calls])).not.toContain('s3cret-PW');
  });
});

describe('review S4: under WSL the page shows the wsl -d shape', () => {
  it('without a cli given, the pair command comes from the distro setup stored, never sudo -u', async () => {
    const e = await makeEnv();
    e.policy.write({
      ...e.policy.get(),
      runnerUser: { mode: 'dedicated', name: 'guildwise-runner', wslDistro: 'guildwise-runner' },
    });
    const { cli: _cli, ...deps } = e.deps;
    const w = await startApprovalsWindow(deps);
    open.push(w);
    const b = await newBrowser();
    const r = await post(e.port, '/api/pair', { spki: b.spki });
    expect(r.status).toBe(200);
    const command = String(r.json().command);
    expect(command).toMatch(
      /^wsl -d guildwise-runner (-u guildwise-runner(-[a-z0-9-]+)? )?-- \/\S+\/guildwise-runner approvals pair [A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$/,
    );
    expect(command).not.toContain('sudo');
  });
});
