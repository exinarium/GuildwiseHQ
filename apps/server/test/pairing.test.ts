import { PAIRING_CODE_PATTERN } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, pairWorkstation, REPO_SSH, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('pairing codes', () => {
  it('issues a Crockford XXXX-XXXX code, stored only as a hash, valid for 10 minutes', async () => {
    const { t, owner } = w;
    const r = await t.req('POST', '/api/workstations/pairing-codes', { cookie: owner.cookie });
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(PAIRING_CODE_PATTERN);
    const ttl = new Date(r.body.expiresAt).getTime() - t.clock.now().getTime();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
    const rows = await q('SELECT code_hash FROM pairing_codes');
    expect(JSON.stringify(rows)).not.toContain(r.body.code.replace('-', ''));
  });

  it('pairs once: returns an aomr_ token and the code cannot be reused', async () => {
    const { t, owner } = w;
    const { code } = await ok<{ code: string }>(
      t.req('POST', '/api/workstations/pairing-codes', { cookie: owner.cookie }),
      201,
    );
    const body = {
      code: code.toLowerCase(),
      name: 'Laptop',
      platform: 'linux',
      hostname: 'h',
      runnerVersion: '1.0.0',
    };
    const first = await t.req('POST', '/api/runner/pair', { body }); // no Origin header needed
    expect(first.status).toBe(200);
    expect(first.body.runnerToken).toMatch(/^aomr_/);
    const row = await q('SELECT token_hash FROM workstations WHERE id=$1', [first.body.workstationId]);
    expect(row[0]!.token_hash).not.toContain(first.body.runnerToken);
    expect((await t.req('POST', '/api/runner/pair', { body })).status).toBe(401);
  });

  it('rejects unknown and expired codes', async () => {
    const { t, owner } = w;
    const body = { code: 'ZZZZ-ZZZZ', name: 'x', platform: 'linux', hostname: 'h', runnerVersion: '1' };
    expect((await t.req('POST', '/api/runner/pair', { body })).status).toBe(401);
    const { code } = await ok<{ code: string }>(
      t.req('POST', '/api/workstations/pairing-codes', { cookie: owner.cookie }),
      201,
    );
    t.clock.advance(10 * 60_000 + 1000);
    try {
      expect((await t.req('POST', '/api/runner/pair', { body: { ...body, code } })).status).toBe(401);
    } finally {
      t.clock.setOffset(0);
    }
  });

  it('enforces 5 attempts per code and at most 3 active codes per user', async () => {
    const { t } = w;
    const s2 = await t.userSession(uniqueEmail('pairer'));
    const codes: string[] = [];
    for (let i = 0; i < 3; i++)
      codes.push(
        (
          await ok<{ code: string }>(
            t.req('POST', '/api/workstations/pairing-codes', { cookie: s2.cookie }),
            201,
          )
        ).code,
      );
    expect((await t.req('POST', '/api/workstations/pairing-codes', { cookie: s2.cookie })).status).toBe(429);
    await q(`UPDATE pairing_codes SET attempts = 5 WHERE user_id=$1`, [s2.id]);
    const r = await t.req('POST', '/api/runner/pair', {
      body: { code: codes[0], name: 'x', platform: 'linux', hostname: 'h', runnerVersion: '1' },
    });
    expect(r.status).toBe(401);
    expect(await q('SELECT 1 FROM workstations WHERE user_id=$1', [s2.id])).toHaveLength(0);
  });
});

describe('runner websocket auth', () => {
  it('welcomes a paired runner after hello and records presence and repos', async () => {
    const r = await w.connectRunner();
    const welcome = await r.waitFor('welcome');
    expect(welcome.workstationId).toBe(w.workstationId);
    expect(welcome.heartbeatSec).toBe(15);
    const list = await ok<any>(w.t.req('GET', '/api/workstations', { cookie: w.owner.cookie }));
    const ws = list.workstations.find((x: any) => x.id === w.workstationId);
    expect(ws.connected).toBe(true);
    expect(ws.runtimes[0].id).toBe('mock');
    expect(ws.repos).toHaveLength(1); // git@ remote matched https project repo
    expect(ws.repos[0].localPath).toBe('/tmp/toy');
    r.close();
  });

  it('closes 4401 for a missing or bad token', async () => {
    const none = await FakeRunner.connect(w.baseUrl, null);
    expect((await none.waitClosed()).code).toBe(4401);
    const bad = await FakeRunner.connect(w.baseUrl, 'aomr_not-a-real-token');
    expect((await bad.waitClosed()).code).toBe(4401);
    const wrongPrefix = await FakeRunner.connect(w.baseUrl, 'nope');
    expect((await wrongPrefix.waitClosed()).code).toBe(4401);
  });

  it('a second connection supersedes the first (4409)', async () => {
    const a = await w.connectRunner();
    const b = await w.connectRunner();
    expect((await a.waitClosed()).code).toBe(4409);
    await b.waitFor('welcome');
    b.close();
  });

  it('unlinking closes the socket with 4403 and later connects get 4403', async () => {
    const { t, owner } = w;
    const p = await pairWorkstation(t, owner, 'ToUnlink');
    const r = await FakeRunner.connect(w.baseUrl, p.runnerToken);
    r.hello();
    await r.waitFor('welcome');
    const res = await t.req('POST', `/api/workstations/${p.workstationId}/unlink`, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect((await r.waitClosed()).code).toBe(4403);
    const again = await FakeRunner.connect(w.baseUrl, p.runnerToken);
    expect((await again.waitClosed()).code).toBe(4403);
    const list = await ok<any>(t.req('GET', '/api/workstations', { cookie: owner.cookie }));
    expect(list.workstations.find((x: any) => x.id === p.workstationId)).toBeUndefined();
  });

  it('matches repos by normalized remote URL', async () => {
    const r = await FakeRunner.connect(w.baseUrl, w.runnerToken);
    r.hello({
      repos: [
        { remoteUrl: 'https://GitHub.com/acme/TOY/', localPath: '/a', headBranch: 'main' },
        { remoteUrl: 'git@github.com:acme/other.git', localPath: '/b', headBranch: 'main' },
      ],
    });
    await r.waitFor('welcome');
    const rows = await q('SELECT local_path FROM workstation_repos WHERE workstation_id=$1', [
      w.workstationId,
    ]);
    expect(rows.map((x) => x.local_path)).toEqual(['/a']);
    // a later repos.report re-matches
    r.send('repos.report', { repos: [{ remoteUrl: REPO_SSH, localPath: '/c', headBranch: 'main' }] });
    await r.barrier();
    expect(
      (await q('SELECT local_path FROM workstation_repos WHERE workstation_id=$1', [w.workstationId]))[0]!
        .local_path,
    ).toBe('/c');
    r.close();
  });
});
