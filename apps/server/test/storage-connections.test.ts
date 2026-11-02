import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

// Storage connections (GWP-63): commands, routes and projection with a fake runner. The access and refresh token
// below exist only "on the workstation" (the fake runner): the server must never see them, and the sealed envelope
// of a typed connect (which stands in for the S3 secret key) must be wiped from the queue once answered.
const ACCESS = 'ACCESS-TOKEN-MARKER-7f3a91';
const REFRESH = 'REFRESH-TOKEN-MARKER-2c84be';
const SEALED = 'SEALED-S3-SECRET-MARKER-91d0aa';
const MARKERS = [ACCESS, REFRESH, SEALED];

const logLines: string[] = [];
let w: World;
let r: FakeRunner;
const api = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) });

beforeAll(async () => {
  w = await createWorld({
    logStream: { write: (l: string) => void logLines.push(l) },
    env: { AOM_FIRST_RUN_HIRE_CAP: 'false' },
  });
  r = await w.connectRunner({ capabilities: ['storage:1'] });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

async function create(kind: string, label = `${kind} store`) {
  const res = await ok<any>(
    api('POST', '/api/org/storage/connections', { kind, label, workstationId: w.workstationId }),
    201,
  );
  return res.connection as { id: string; kind: string; label: string; health: { state: string } };
}
const list = async () => (await ok<any>(api('GET', '/api/org/storage/connections'))).connections as any[];
const commandFor = (name: string, from: number) =>
  r.waitFor('command', (f: any) => f.command === name, 8000, from) as Promise<any>;

/** Every row of every table, as text. */
async function everything(): Promise<string> {
  const tables = await q<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname='public'`);
  const out: string[] = [];
  for (const t of tables) {
    const rows = await q(`SELECT row_to_json(x)::text AS j FROM "${t.tablename}" x`);
    out.push(...rows.map((x: any) => x.j));
  }
  return out.join('\n');
}

describe('storage connections', () => {
  it('adds, renames and removes a connection of each kind (AC1)', async () => {
    for (const kind of ['onedrive', 'google_drive', 's3', 'local', 'vault']) {
      const c = await create(kind);
      expect(c).toMatchObject({ kind, label: `${kind} store`, health: { state: 'pending' } });
      await ok(api('PATCH', `/api/org/storage/connections/${c.id}`, { label: `${kind} renamed` }));
      expect((await list()).find((x) => x.id === c.id)?.label).toBe(`${kind} renamed`);
      const from = r.received.length;
      const del = await api('DELETE', `/api/org/storage/connections/${c.id}`);
      expect(del.status).toBe(204);
      expect((await list()).some((x) => x.id === c.id)).toBe(false);
      const cmd = await commandFor('storage.remove', from);
      expect(cmd.payload).toEqual({ connectionId: c.id });
    }
  });

  it('refuses a workstation without the storage capability', async () => {
    await q(
      `UPDATE workstation_capabilities SET capabilities = array_remove(capabilities, 'storage:1') WHERE workstation_id=$1`,
      [w.workstationId],
    );
    const res = await api('POST', '/api/org/storage/connections', {
      kind: 's3',
      label: 'x',
      workstationId: w.workstationId,
    });
    expect(res.status).toBe(409);
    await q(
      `UPDATE workstation_capabilities SET capabilities = capabilities || 'storage:1' WHERE workstation_id=$1`,
      [w.workstationId],
    );
  });

  it('sign-in, test, needs re-authentication and reconnect keep every token off the server (AC2, AC5)', async () => {
    const c = await create('google_drive');
    // sign in: the runner answers with a device code, then finishes
    let from = r.received.length;
    const began = await ok<any>(api('POST', `/api/org/storage/connections/${c.id}/auth`, {}), 202);
    const cmd = await commandFor('storage.auth.begin', from);
    expect(cmd.payload).toMatchObject({
      connectionId: c.id,
      sessionId: began.sessionId,
      kind: 'google_drive',
    });
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: {
        prompt: {
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://example.test/device',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      },
    });
    await until(
      async () =>
        (await api('GET', `/api/org/storage/requests/${began.sessionId}`)).body?.request?.state ===
        'awaiting_user',
      5000,
      'device code shown',
    );
    r.send('storage.auth', { sessionId: began.sessionId, connectionId: c.id, state: 'done' });
    r.send('storage.report', {
      connections: [{ connectionId: c.id, state: 'connected', checkedAt: new Date().toISOString() }],
    });
    await until(
      async () => (await list()).find((x) => x.id === c.id)?.health.state === 'connected',
      5000,
      'connected',
    );

    // the token is "held" by the runner only: nothing the runner sends carries it, nothing is stored here
    // test connection
    from = r.received.length;
    const rid = randomUUID();
    await ok(api('POST', `/api/org/storage/connections/${c.id}/test`, { requestId: rid }), 202);
    const test = await commandFor('storage.test', from);
    r.send('command.result', {
      commandId: test.commandId,
      ok: true,
      result: {
        error: { code: 'auth_expired', message: 'Sign-in expired' },
        health: {
          connectionId: c.id,
          state: 'needs_reauth',
          errorCode: 'auth_expired',
          checkedAt: new Date().toISOString(),
        },
      },
    });
    r.send('storage.report', {
      connections: [
        {
          connectionId: c.id,
          state: 'needs_reauth',
          errorCode: 'auth_expired',
          message: 'Sign-in expired',
          checkedAt: new Date().toISOString(),
        },
      ],
    });
    await until(
      async () => (await api('GET', `/api/org/storage/requests/${rid}`)).body?.request?.state === 'failed',
      5000,
      'test failed',
    );
    const shown = (await list()).find((x) => x.id === c.id);
    expect(shown.health).toMatchObject({ state: 'needs_reauth', errorCode: 'auth_expired' });

    // reconnect: the same call as the first sign-in, the connection and its settings stay
    from = r.received.length;
    const again = await ok<any>(api('POST', `/api/org/storage/connections/${c.id}/auth`, {}), 202);
    expect(again.sessionId).not.toBe(began.sessionId);
    await commandFor('storage.auth.begin', from);
    r.send('storage.auth', { sessionId: again.sessionId, connectionId: c.id, state: 'done' });
    r.send('storage.report', {
      connections: [{ connectionId: c.id, state: 'connected', checkedAt: new Date().toISOString() }],
    });
    await until(
      async () => (await list()).find((x) => x.id === c.id)?.health.state === 'connected',
      5000,
      'reconnected',
    );

    // typed connect (S3): the sealed envelope is wiped from the queue once the runner has answered
    const s3 = await create('s3');
    from = r.received.length;
    const requestId = randomUUID();
    await ok(
      api('POST', `/api/org/storage/connections/${s3.id}/connect`, {
        requestId,
        envelope: { ciphertext: SEALED },
      }),
      202,
    );
    const conn = await commandFor('storage.connect', from);
    expect(JSON.stringify(conn.payload)).toContain(SEALED);
    r.send('command.result', {
      commandId: conn.commandId,
      ok: true,
      result: { health: { connectionId: s3.id, state: 'connected', checkedAt: new Date().toISOString() } },
    });
    await until(
      async () =>
        (await api('GET', `/api/org/storage/requests/${requestId}`)).body?.request?.state === 'done',
      5000,
      'connect done',
    );

    // the scan: every table, the log lines and every API answer
    const dump = await everything();
    const answers = JSON.stringify([
      await list(),
      (await api('GET', `/api/org/storage/requests/${began.sessionId}`)).body,
      (await api('GET', `/api/org/storage/requests/${rid}`)).body,
      (await api('GET', `/api/org/storage/requests/${requestId}`)).body,
    ]);
    for (const m of MARKERS) {
      expect(dump, `table dump holds ${m}`).not.toContain(m);
      expect(logLines.join('\n'), `log holds ${m}`).not.toContain(m);
      expect(answers, `API holds ${m}`).not.toContain(m);
    }
  });

  it('removing a connection while the workstation is offline still delivers the delete at the next connection (AC6)', async () => {
    const c = await create('onedrive');
    r.ws.close();
    await until(async () => !(await list()).find((x) => x.id === c.id)?.workstation.online, 5000, 'offline');
    expect((await list()).find((x) => x.id === c.id)?.health.state).toBe('runner_offline');
    expect((await api('DELETE', `/api/org/storage/connections/${c.id}`)).status).toBe(204);
    r = await w.connectRunner({ capabilities: ['storage:1'] });
    const cmd = await commandFor('storage.remove', 0);
    expect(cmd.payload).toEqual({ connectionId: c.id });
  });

  it('keeps storage_connection_health and storage_requests over a projection rebuild', async () => {
    const c = await create('local', 'Rebuild me');
    r.send('storage.report', {
      connections: [{ connectionId: c.id, state: 'connected', checkedAt: new Date().toISOString() }],
    });
    await until(
      async () => (await list()).find((x) => x.id === c.id)?.health.state === 'connected',
      5000,
      'connected',
    );
    const rid = randomUUID();
    await ok(api('POST', `/api/org/storage/connections/${c.id}/test`, { requestId: rid }), 202);
    const before = {
      health: await q('SELECT connection_id, state FROM storage_connection_health ORDER BY connection_id'),
      requests: await q('SELECT id, op, state FROM storage_requests ORDER BY id'),
    };
    expect(before.health.length).toBeGreaterThan(0);
    expect(before.requests.length).toBeGreaterThan(0);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(
      await q('SELECT connection_id, state FROM storage_connection_health ORDER BY connection_id'),
    ).toEqual(before.health);
    expect(await q('SELECT id, op, state FROM storage_requests ORDER BY id')).toEqual(before.requests);
    expect((await list()).find((x) => x.id === c.id)?.label).toBe('Rebuild me');
  });
});
