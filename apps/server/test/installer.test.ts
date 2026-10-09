import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

let t: TestApp;
let dir: string;
let tgz: Buffer;
let user: { id: string; cookie: string };
const path = (url: string) => new URL(url).pathname + new URL(url).search;
const pair = (code: string, name = 'Laptop') =>
  t.req('POST', '/api/runner/pair', {
    body: { code, name, platform: 'linux', hostname: 'h', runnerVersion: '0.1.0' },
  });
const codeIn = (script: string) => /PAIRING_CODE='([^']+)'/.exec(script)?.[1] ?? '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'release-'));
  tgz = randomBytes(2048);
  writeFileSync(join(dir, 'aom-runner-0.1.0.tgz'), randomBytes(100));
  writeFileSync(join(dir, 'aom-runner-0.10.2.tgz'), tgz);
  writeFileSync(join(dir, 'aom-runner-0.9.0.tgz'), randomBytes(100));
  writeFileSync(join(dir, 'notes.txt'), 'not a release');
  t = await createTestApp({ env: { AOM_RUNNER_RELEASE_DIR: dir } });
  user = await t.userSession(uniqueEmail('inst'));
});
afterAll(async () => {
  await t.close();
  rmSync(dir, { recursive: true, force: true });
  await closeAdminPool();
});

describe('the runner release', () => {
  it('serves the newest version with its sha256, the tarball and the checksum file', async () => {
    const info = await ok<any>(t.req('GET', '/api/runner/release'));
    expect(info).toMatchObject({
      version: '0.10.2',
      sha256: createHash('sha256').update(tgz).digest('hex'),
      size: 2048,
      url: 'http://aom.test/api/runner/release/aom-runner-0.10.2.tgz',
    });
    const file = await t.app.inject({ method: 'GET', url: '/api/runner/release/aom-runner-0.10.2.tgz' });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/gzip');
    expect(file.rawPayload.equals(tgz)).toBe(true);
    const sum = await t.app.inject({
      method: 'GET',
      url: '/api/runner/release/aom-runner-0.10.2.tgz.sha256',
    });
    expect(sum.body).toBe(`${info.sha256}  aom-runner-0.10.2.tgz\n`);
  });

  it('404s an unknown version and anything that is not a release name', async () => {
    expect((await t.req('GET', '/api/runner/release/aom-runner-9.9.9.tgz')).status).toBe(404);
    expect((await t.req('GET', '/api/runner/release/..%2Fsecret')).status).toBe(404);
    expect((await t.req('GET', '/api/runner/release/notes.txt')).status).toBe(404);
  });

  it('says so when the server has no release', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'norelease-'));
    const t2 = await createTestApp({ env: { AOM_RUNNER_RELEASE_DIR: empty }, reset: false });
    try {
      const r = await t2.req('GET', '/api/runner/release');
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('no_release');
    } finally {
      await t2.close();
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('an install session', () => {
  it('needs a signed-in user and a known system', async () => {
    expect((await t.req('POST', '/api/workstations/installers', { body: { os: 'linux' } })).status).toBe(401);
    expect(
      (await t.req('POST', '/api/workstations/installers', { cookie: user.cookie, body: { os: 'beos' } }))
        .status,
    ).toBe(400);
  });

  it('makes a 30-minute link and a one-line command per system', async () => {
    for (const os of ['linux', 'macos', 'windows'] as const) {
      const s = await ok<any>(
        t.req('POST', '/api/workstations/installers', { cookie: user.cookie, body: { os, name: 'Desk' } }),
        201,
      );
      const ttl = new Date(s.expiresAt).getTime() - t.clock.now().getTime();
      expect(ttl).toBeGreaterThan(29 * 60_000);
      expect(ttl).toBeLessThanOrEqual(30 * 60_000);
      expect(s.release).toMatchObject({ version: '0.10.2' });
      expect(s.oneLiner).toContain('http://aom.test/install/');
      expect(s.oneLiner.startsWith(os === 'windows' ? '[Net.ServicePointManager]' : 'curl -fsSL ')).toBe(true);
      expect(s.oneLiner.endsWith(os === 'windows' ? '| iex' : '| bash')).toBe(true);
      expect(s.downloadUrl).toContain('?download=1');
      expect(s.fileName).toMatch(os === 'windows' ? /\.ps1$/ : /\.sh$/);
    }
  });

  it('serves the script behind the link with a fresh one-time code that pairs exactly once', async () => {
    const s = await ok<any>(
      t.req('POST', '/api/workstations/installers', {
        cookie: user.cookie,
        body: { os: 'linux', name: "Pieter's $(id) box" },
      }),
      201,
    );
    const url = /'([^']+)'/.exec(s.oneLiner)?.[1] as string;
    const res = await t.app.inject({ method: 'GET', url: path(url) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/x-shellscript');
    expect(res.headers['cache-control']).toBe('no-store');
    const script = res.body;
    expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(script).toContain("SERVER_URL='http://aom.test'");
    expect(script).toContain(`RELEASE_VERSION='0.10.2'`);
    expect(script).toContain("DEFAULT_NAME='Pieter'\\''s $(id) box'");
    const code = codeIn(script);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    // no long-lived secret: the session cookie, the user's email and id are nowhere in it
    expect(script).not.toContain(user.cookie.split('=')[1] ?? 'x');
    expect(script).not.toContain(user.id);
    expect(script).not.toMatch(/inst-?\d*@/);
    // the code is stored only as a hash
    expect(JSON.stringify(await q('SELECT code_hash FROM pairing_codes'))).not.toContain(
      code.replace('-', ''),
    );
    // fetching again mints another code and retires the first: only the newest copy can pair
    const again = await t.app.inject({ method: 'GET', url: path(url) });
    const code2 = codeIn(again.body);
    expect(code2).not.toBe(code);
    expect((await pair(code)).status).toBe(401);
    const paired = await pair(code2, "Pieter's box");
    expect(paired.status).toBe(200);
    expect((await pair(code2)).status).toBe(401);
    // a later fetch still serves the script (a re-run upgrades or repairs) but its code cannot pair
    const third = await t.app.inject({ method: 'GET', url: path(url) });
    expect(third.statusCode).toBe(200);
    expect((await pair(codeIn(third.body))).status).toBe(401);
    // the wizard sees the workstation its code created
    const st = await ok<any>(t.req('GET', `/api/workstations/installers/${s.id}`, { cookie: user.cookie }));
    expect(st).toMatchObject({
      state: 'paired',
      workstationId: paired.body.workstationId,
      workstationName: "Pieter's box",
    });
  });

  it('the download link sets a file name; the Windows links serve PowerShell', async () => {
    const s = await ok<any>(
      t.req('POST', '/api/workstations/installers', { cookie: user.cookie, body: { os: 'windows' } }),
      201,
    );
    const dl = await t.app.inject({ method: 'GET', url: path(s.downloadUrl) });
    expect(dl.headers['content-disposition']).toBe('attachment; filename="install-guildwise-hq.ps1"');
    expect(dl.body).toContain("$ServerUrl = 'http://aom.test'");
    const token = /\/install\/([^/]+)\//.exec(s.downloadUrl)?.[1];
    const lin = await t.app.inject({ method: 'GET', url: `/install/${token}/install-linux-wsl.sh` });
    expect(lin.statusCode).toBe(200);
    expect(lin.body).toContain('main "$@"');
    expect((await t.app.inject({ method: 'GET', url: `/install/${token}/evil.sh` })).statusCode).toBe(404);
  });

  it('the link stops working after 30 minutes; a bad token is a 404', async () => {
    const s = await ok<any>(
      t.req('POST', '/api/workstations/installers', { cookie: user.cookie, body: { os: 'linux' } }),
      201,
    );
    const url = path(/'([^']+)'/.exec(s.oneLiner)?.[1] as string);
    expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(200);
    t.clock.advance(31 * 60_000);
    expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(404);
    expect(
      (await t.app.inject({ method: 'GET', url: '/install/not-a-real-token-0123456789/install.sh' }))
        .statusCode,
    ).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/install/short/install.sh' })).statusCode).toBe(400);
    const st = await ok<any>(t.req('GET', `/api/workstations/installers/${s.id}`, { cookie: user.cookie }));
    expect(st.state).toBe('expired');
  });

  it('starting over retires earlier unused codes, so the wizard never runs into the code limit', async () => {
    for (let i = 0; i < 6; i++) {
      const s = await ok<any>(
        t.req('POST', '/api/workstations/installers', {
          cookie: user.cookie,
          body: { os: i % 2 ? 'linux' : 'macos' },
        }),
        201,
      );
      // every second attempt fails without ever pairing: its code must not count against the limit either
      if (i % 2) {
        const token = /\/install\/([^/]+)\//.exec(s.oneLiner)?.[1];
        await t.app.inject({
          method: 'POST',
          url: `/install/${token}/progress`,
          payload: { step: 'summary', status: 'done', detail: 'failed: x' },
        });
      }
    }
    const open = await q(
      `SELECT count(*)::int AS n FROM pairing_codes WHERE used_at IS NULL AND expires_at > $1`,
      [t.clock.now()],
    );
    expect(open[0]?.n).toBeLessThanOrEqual(1);
  });
});

describe('progress', () => {
  it('follows waiting, running, paired, checking and done', async () => {
    const other = await t.userSession(uniqueEmail('inst-other'));
    const s = await ok<any>(
      t.req('POST', '/api/workstations/installers', { cookie: user.cookie, body: { os: 'linux' } }),
      201,
    );
    const token = /\/install\/([^/]+)\//.exec(s.oneLiner)?.[1] as string;
    const status = async () =>
      ok<any>(t.req('GET', `/api/workstations/installers/${s.id}`, { cookie: user.cookie }));
    const report = (body: unknown) =>
      t.app.inject({ method: 'POST', url: `/install/${token}/progress`, payload: body as object });
    expect((await status()).state).toBe('waiting');

    expect((await report({ step: 'installer', status: 'start', detail: 'linux' })).statusCode).toBe(200);
    expect((await status()).state).toBe('running');
    await report({ step: 'Installing Node 22', status: 'ok', detail: 'Node v22 installed' });
    await report({ step: 'Paired', status: 'ok', detail: 'Laptop' });
    expect((await status()).state).toBe('paired');
    await report({ step: 'doctor:node', status: 'ok', detail: 'v22.23.2' });
    await report({ step: 'doctor:docker', status: 'warn', detail: 'not found (optional)' });
    const mid = await status();
    expect(mid.state).toBe('checking');
    expect(mid.doctor.map((d: any) => [d.step, d.status])).toEqual([
      ['node', 'ok'],
      ['docker', 'warn'],
    ]);
    expect(mid.steps.map((x: any) => x.step)).toEqual(['installer', 'Installing Node 22', 'Paired']);
    await report({ step: 'summary', status: 'done', detail: 'success' });
    const end = await status();
    expect(end).toMatchObject({ state: 'done', result: 'success' });

    // only the owner follows it
    expect(
      (await t.req('GET', `/api/workstations/installers/${s.id}`, { cookie: other.cookie })).status,
    ).toBe(404);
  });

  it('records a failure and rejects bad reports', async () => {
    const s = await ok<any>(
      t.req('POST', '/api/workstations/installers', { cookie: user.cookie, body: { os: 'macos' } }),
      201,
    );
    const token = /\/install\/([^/]+)\//.exec(s.oneLiner)?.[1] as string;
    const report = (body: unknown, tok = token) =>
      t.app.inject({ method: 'POST', url: `/install/${tok}/progress`, payload: body as object });
    await report({ step: 'Homebrew', status: 'fail', detail: 'x'.repeat(400) });
    await report({ step: 'summary', status: 'done', detail: 'failed: Homebrew' });
    const st = await ok<any>(t.req('GET', `/api/workstations/installers/${s.id}`, { cookie: user.cookie }));
    expect(st).toMatchObject({ state: 'done', result: 'failed' });
    expect(st.steps.find((x: any) => x.step === 'Homebrew').status).toBe('fail');
    expect((await report({ step: '', status: 'ok' })).statusCode).toBe(400);
    expect((await report({ step: 'x', status: 'bogus' })).statusCode).toBe(400);
    expect((await report({ step: 'x', status: 'ok', detail: 'y'.repeat(401) })).statusCode).toBe(400);
    expect((await report({ step: 'x', status: 'ok' }, 'unknown-token-0123456789')).statusCode).toBe(404);
  });
});
