import { RUNNER_TOKEN_PREFIX } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { PASSWORD, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('POST /api/auth/password', () => {
  it('changes the password, keeps the current session and signs the others out', async () => {
    const email = uniqueEmail('pw');
    await w.t.createUser(email);
    const a = await w.t.login(email);
    const b = await w.t.login(email);
    const NEW = 'a-brand-new-passphrase';
    const res = await w.t.req('POST', '/api/auth/password', {
      cookie: a,
      body: { current: PASSWORD, new: NEW },
    });
    expect(res.status).toBe(200);
    expect((await w.t.req('GET', '/api/auth/me', { cookie: a })).status).toBe(200);
    expect((await w.t.req('GET', '/api/auth/me', { cookie: b })).status).toBe(401);
    expect((await w.t.req('POST', '/api/auth/login', { body: { email, password: PASSWORD } })).status).toBe(
      401,
    );
    expect((await w.t.req('POST', '/api/auth/login', { body: { email, password: NEW } })).status).toBe(200);
    expect((await q(`SELECT type FROM events WHERE type='PasswordChanged'`)).length).toBeGreaterThan(0);
  });

  it('rejects a wrong current password, a short new one, and anonymous callers', async () => {
    const email = uniqueEmail('pw2');
    await w.t.createUser(email);
    const c = await w.t.login(email);
    const wrong = await w.t.req('POST', '/api/auth/password', {
      cookie: c,
      body: { current: 'nope-nope-nope', new: 'long-enough-password' },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('wrong_password');
    expect(
      (await w.t.req('POST', '/api/auth/password', { cookie: c, body: { current: PASSWORD, new: 'short' } }))
        .status,
    ).toBe(400);
    expect(
      (
        await w.t.req('POST', '/api/auth/password', {
          body: { current: PASSWORD, new: 'long-enough-password' },
        })
      ).status,
    ).toBe(401);
    expect((await w.t.req('GET', '/api/auth/me', { cookie: c })).status).toBe(200);
  });
});

describe('runner token rotation', () => {
  it('issues a new token over the socket; it replaces the old one on first use', async () => {
    const r = await w.connectRunner();
    r.send('token.rotate');
    const rotated = await r.waitFor('token.rotated');
    expect(rotated.token.startsWith(RUNNER_TOKEN_PREFIX)).toBe(true);
    expect(rotated.token).not.toBe(w.runnerToken);
    // Not yet active: the old token still works, the hash column is unchanged.
    const before = (await q('SELECT token_hash FROM workstations WHERE id=$1', [w.workstationId]))[0]!
      .token_hash;
    expect(await q('SELECT 1 FROM runner_token_rotations')).toHaveLength(1);
    expect(JSON.stringify(await q('SELECT * FROM runner_token_rotations'))).not.toContain(rotated.token);
    const stillOld = await FakeRunner.connect(w.baseUrl, w.runnerToken);
    stillOld.hello();
    await stillOld.waitFor('welcome');
    stillOld.close();

    // First connection with the new token promotes it and retires the old one.
    const next = await FakeRunner.connect(w.baseUrl, rotated.token);
    next.hello();
    await next.waitFor('welcome');
    expect(
      (await q('SELECT token_hash FROM workstations WHERE id=$1', [w.workstationId]))[0]!.token_hash,
    ).not.toBe(before);
    expect(await q('SELECT 1 FROM runner_token_rotations')).toHaveLength(0);
    expect((await q(`SELECT 1 FROM events WHERE type='WorkstationTokenRotated'`)).length).toBe(1);
    const old = await FakeRunner.connect(w.baseUrl, w.runnerToken);
    expect((await old.waitClosed()).code).toBe(4401);
    // A rebuild keeps the rotated hash.
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect((await q('SELECT 1 FROM workstations WHERE token_hash <> $1', [before])).length).toBe(1);
    next.close();
    r.close();
  });
});
