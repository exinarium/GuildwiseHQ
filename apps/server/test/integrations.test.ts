import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOG_REDACT } from '../src/app.ts';
import { sweepIntegrations } from '../src/commands/integrations.ts';
import { rebuildProjections, unsavedCascadeTargets } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, MOCK_RUNTIME, ok, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
const KEY = { keyId: 'abcd1234abcd1234', publicKey: 'AAAA' };
// What the page sends: only this, never a value. The text is the marker the tests look for everywhere else.
const MARK = 'c2VjcmV0LXRva2VuLW1hcmtlcg';
const envelope = (keyId = KEY.keyId) => ({
  v: 1,
  alg: 'RSA-OAEP-256+A256GCM',
  keyId,
  wrappedKey: MARK,
  iv: 'aXY',
  ct: MARK,
});

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ hello: false });
  r.hello({ runtimes: MOCK_RUNTIME, sudoKey: KEY, integrationsVersion: 1 });
  await r.waitFor('welcome');
  await w.t.app.ctx.notifier.flush();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

// rows as loose objects (the helper's rows are typed strictly)
const qa = (sql: string, params?: unknown[]) => q(sql, params) as unknown as Promise<any[]>;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const base = () => `/api/workstations/${w.workstationId}/integrations`;
const settle = async () => {
  await r.barrier();
  await w.t.app.ctx.notifier.flush();
};
const nextCommand = (type: string, from: number) =>
  r.waitFor('command', (c) => c.command === type, 5000, from);
const answer = (commandId: string, result: unknown, ok_ = true) =>
  r.send('command.result', { commandId, ok: ok_, ...(ok_ ? { result } : { error: String(result) }) });
const status = (kind: string, state: string, extra: Record<string, unknown> = {}) => ({
  kind,
  instance: '',
  state,
  scope: 'workstation',
  checkedAt: new Date().toISOString(),
  ...extra,
});

describe('who may use the page', () => {
  it('another user gets 404 on every route; so does an org owner who is not the workstation owner', async () => {
    const other = await w.t.userSession(uniqueEmail('other'));
    const o = (method: string, url: string, body?: unknown) =>
      w.t.req(method, url, { cookie: other.cookie, body });
    const rid = randomUUID();
    expect((await o('GET', base())).status).toBe(404);
    expect((await o('GET', `${base()}/requests/${rid}`)).status).toBe(404);
    expect(
      (
        await o('POST', `${base()}/connect`, {
          requestId: rid,
          kind: 'jira',
          instance: '',
          method: 'token',
          envelope: envelope(),
        })
      ).status,
    ).toBe(404);
    expect(
      (await o('POST', `${base()}/sessions`, { kind: 'claude-code', instance: '', method: 'setup_token' }))
        .status,
    ).toBe(404);
    expect((await o('POST', `${base()}/test`, { requestId: rid, kind: 'jira', instance: '' })).status).toBe(
      404,
    );
    expect((await o('POST', `${base()}/remove`, { requestId: rid, kind: 'jira', instance: '' })).status).toBe(
      404,
    );
    // the chooser lists only the user's own
    expect((await ok<any>(o('GET', '/api/integrations/workstations'))).workstations).toEqual([]);
    expect((await w.t.req('GET', base())).status).toBe(401);
  });

  it('the chooser lists the owner workstation with the count that needs attention', async () => {
    r.send('integrations.report', {
      integrations: [status('jira', 'connected'), status('claude-code', 'expired')],
      registryVersion: 1,
    });
    await settle();
    const list = await ok<any>(owner('GET', '/api/integrations/workstations'));
    expect(list.workstations[0]).toMatchObject({
      id: w.workstationId,
      connected: true,
      needsAttention: 1,
      total: 2,
    });
  });
});

describe('reports and the page data', () => {
  it('stores the facts the runner reports with its key and policy, replacing the earlier report', async () => {
    r.send('integrations.report', {
      integrations: [
        status('jira', 'connected', { account: 'Pieter', site: 'https://acme.atlassian.net' }),
        status('github', 'not_connected', { instance: 'github.com', scope: 'machine' }),
      ],
      registryVersion: 1,
      policy: { allowWeb: true, primaryPairing: true, machineScopeFromWeb: 'primary' },
    });
    await settle();
    const page = await ok<any>(owner('GET', base()));
    expect(page.legacy).toBe(false);
    expect(page.key).toEqual(KEY);
    expect(page.runner).toMatchObject({
      connected: true,
      integrationsVersion: 1,
      policy: { allowWeb: true, primaryPairing: true },
    });
    expect(page.integrations.map((i: any) => i.kind).sort()).toEqual(['github', 'jira']);
    expect(page.integrations.find((i: any) => i.kind === 'jira')).toMatchObject({ account: 'Pieter' });
    expect(Date.parse(page.serverTime)).toBeGreaterThan(0);
  });

  it('the registry is served', async () => {
    const reg = await ok<any>(owner('GET', '/api/integrations/registry'));
    expect(reg.kinds.map((k: any) => k.id)).toContain('mcp');
  });
});

describe('connect: the server relays the envelope and forgets it', () => {
  it('queues the command with an expiry, answers 202, and empties the payload when the runner answers', async () => {
    const from = r.received.length;
    const requestId = randomUUID();
    const res = await owner('POST', `${base()}/connect`, {
      requestId,
      kind: 'jira',
      instance: '',
      method: 'token',
      envelope: envelope(),
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: requestId, state: 'pending' });
    const cmd = await nextCommand('integration.connect', from);
    expect(cmd.payload).toMatchObject({ requestId, kind: 'jira', method: 'token' });
    expect((cmd.payload as any).envelope.ct).toBe(MARK);
    const [row] = await qa(`SELECT payload, expires_at, status FROM runner_commands WHERE id=$1`, [
      cmd.commandId,
    ]);
    expect(row.expires_at).not.toBeNull();
    expect(JSON.stringify(row.payload)).toContain(MARK);

    // while waiting, the request is pollable
    expect((await ok<any>(owner('GET', `${base()}/requests/${requestId}`))).state).toBe('pending');

    answer(cmd.commandId, { status: status('jira', 'connected', { account: 'Pieter' }) });
    await settle();
    const [after] = await qa(`SELECT payload, status FROM runner_commands WHERE id=$1`, [cmd.commandId]);
    expect(after.payload).toEqual({});
    expect(after.status).toBe('done');
    const done = await ok<any>(owner('GET', `${base()}/requests/${requestId}`));
    expect(done).toMatchObject({
      state: 'done',
      error: null,
      status: { kind: 'jira', state: 'connected', account: 'Pieter' },
    });
    // the page now sees the new status without waiting for a report
    const page = await ok<any>(owner('GET', base()));
    expect(page.integrations.find((i: any) => i.kind === 'jira')).toMatchObject({ state: 'connected' });
    // the audit event holds who and what, never a value
    const ev = await qa(
      `SELECT payload FROM events WHERE type='WorkstationIntegrationConnected' ORDER BY seq DESC LIMIT 1`,
    );
    expect(ev[0].payload).toMatchObject({
      workstationId: w.workstationId,
      kind: 'jira',
      method: 'token',
      by: w.owner.id,
    });
    expect(JSON.stringify(ev[0].payload)).not.toContain(MARK);
  });

  it('a refusal from the runner is a failed request with its sentence, and is never retried', async () => {
    const from = r.received.length;
    const requestId = randomUUID();
    await owner('POST', `${base()}/connect`, {
      requestId,
      kind: 'bitbucket-cloud',
      instance: '',
      method: 'token',
      envelope: envelope(),
    });
    const cmd = await nextCommand('integration.connect', from);
    answer(cmd.commandId, {
      error: 'Bitbucket refused the token: missing scope write:pullrequest:bitbucket',
      code: 'refused',
    });
    await settle();
    expect(await ok<any>(owner('GET', `${base()}/requests/${requestId}`))).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('write:pullrequest:bitbucket'),
    });
    const [row] = await qa(`SELECT status, payload, attempts FROM runner_commands WHERE id=$1`, [
      cmd.commandId,
    ]);
    expect(row.status).toBe('done');
    expect(row.payload).toEqual({});
    // a reconnect does not deliver it again
    r.hello({ runtimes: MOCK_RUNTIME, sudoKey: KEY, integrationsVersion: 1 });
    await settle();
    expect(r.of('command').filter((c) => c.commandId === cmd.commandId).length).toBe(1);
  });

  it('a runner that errors (ok:false) also ends the request as failed', async () => {
    const from = r.received.length;
    const requestId = randomUUID();
    await owner('POST', `${base()}/connect`, {
      requestId,
      kind: 'gitlab',
      instance: 'gitlab.com',
      method: 'token',
      envelope: envelope(),
    });
    const cmd = await nextCommand('integration.connect', from);
    answer(cmd.commandId, 'boom', false);
    await settle();
    expect(await ok<any>(owner('GET', `${base()}/requests/${requestId}`))).toMatchObject({
      state: 'failed',
      error: 'boom',
    });
  });

  it('validates against the registry, the key and the runner', async () => {
    const rid = () => randomUUID();
    const bad = (body: Record<string, unknown>) =>
      owner('POST', `${base()}/connect`, { requestId: rid(), envelope: envelope(), ...body });
    expect((await bad({ kind: 'jira', instance: 'x', method: 'token' })).status).toBe(422);
    expect((await bad({ kind: 'jira', instance: '', method: 'nope' })).status).toBe(422);
    expect((await bad({ kind: 'claude-code', instance: '', method: 'setup_token' })).status).toBe(422); // interactive
    expect((await bad({ kind: 'claude-code', instance: '', method: 'default_login' })).status).toBe(422); // phase 2
    const changed = await bad({
      kind: 'jira',
      instance: '',
      method: 'token',
      envelope: envelope('ffffffffffffffff'),
    });
    expect(changed.status).toBe(409);
    expect(changed.body.code ?? changed.body.error?.code).toBe('runner_key_changed');
    // the body never echoes the envelope
    expect(JSON.stringify(changed.body)).not.toContain(MARK);
    // an envelope that is not the right shape is refused at the edge
    expect(
      (
        await owner('POST', `${base()}/connect`, {
          requestId: rid(),
          kind: 'jira',
          instance: '',
          method: 'token',
          envelope: { v: 1 },
        })
      ).status,
    ).toBe(400);
  });

  it('only the latest undelivered connect for a target is relayed: the earlier one is failed and emptied', async () => {
    const a = randomUUID();
    const [old] = await qa(
      `INSERT INTO runner_commands (workstation_id, type, payload, expires_at) VALUES ($1,'integration.connect',$2,now() + interval '5 minutes') RETURNING id`,
      [
        w.workstationId,
        JSON.stringify({
          requestId: a,
          kind: 'azure-devops',
          instance: 'acme',
          method: 'token',
          envelope: envelope(),
        }),
      ],
    );
    await qa(
      `INSERT INTO integration_requests (id, workstation_id, user_id, kind, instance, op, method, state, command_id, created_at, updated_at, expires_at)
       VALUES ($1,$2,$3,'azure-devops','acme','connect','token','pending',$4,now(),now(),now() + interval '1 hour')`,
      [a, w.workstationId, w.owner.id, old.id],
    );
    const from = r.received.length;
    const b = randomUUID();
    const second = await owner('POST', `${base()}/connect`, {
      requestId: b,
      kind: 'azure-devops',
      instance: 'acme',
      method: 'token',
      envelope: envelope(),
    });
    expect(second.status).toBe(202);
    const [dropped] = await qa(`SELECT status, payload FROM runner_commands WHERE id=$1`, [old.id]);
    expect(dropped).toMatchObject({ status: 'failed', payload: {} });
    expect(await ok<any>(owner('GET', `${base()}/requests/${a}`))).toMatchObject({ state: 'failed' });
    const cmd = await nextCommand('integration.connect', from);
    expect((cmd.payload as any).requestId).toBe(b);
    answer(cmd.commandId, { error: 'test cleanup' });
    await settle();
  });
});

describe('interactive sign-ins', () => {
  it('begin, prompt, paste (at most three, only while waiting), cancel and the connected end', async () => {
    const from = r.received.length;
    const started = await owner('POST', `${base()}/sessions`, {
      kind: 'claude-code',
      instance: '',
      method: 'setup_token',
    });
    expect(started.status).toBe(202);
    const sid = started.body.id as string;
    const begin = await nextCommand('integration.begin', from);
    expect(begin.payload).toMatchObject({ sessionId: sid, kind: 'claude-code', method: 'setup_token' });
    answer(begin.commandId, { accepted: true });
    await settle();

    // only one sign-in per kind and instance
    const again = await owner('POST', `${base()}/sessions`, {
      kind: 'claude-code',
      instance: '',
      method: 'setup_token',
    });
    expect(again.status).toBe(409);
    expect(again.body.code ?? again.body.error?.code).toBe('session_busy');

    // a paste before the CLI waits for it is refused
    const early = await owner('POST', `${base()}/sessions/${sid}/input`, { envelope: envelope() });
    expect(early.status).toBe(409);

    r.send('integration.session', {
      sessionId: sid,
      kind: 'claude-code',
      instance: '',
      state: 'awaiting_code',
      prompt: { url: 'https://claude.com/cai/oauth/authorize?x=1', urlHost: 'claude.com', inputKind: 'code' },
    });
    await settle();
    const poll = await ok<any>(owner('GET', `${base()}/requests/${sid}`));
    expect(poll).toMatchObject({
      state: 'awaiting_code',
      prompt: { urlHost: 'claude.com', inputKind: 'code' },
    });
    expect((await ok<any>(owner('GET', base()))).activeSessions.map((s: any) => s.id)).toContain(sid);
    // the runner acks the session message (terminal states must not be lost)
    expect(r.of('ack').length).toBeGreaterThan(0);

    // paste: relayed with an expiry; the runner says it wants another (wrong address)
    for (let n = 1; n <= 3; n++) {
      const f = r.received.length;
      const res = await owner('POST', `${base()}/sessions/${sid}/input`, { envelope: envelope() });
      expect(res.status, `paste ${n}`).toBe(202);
      const cmd = await nextCommand('integration.input', f);
      expect((cmd.payload as any).sessionId).toBe(sid);
      const [row] = await qa(`SELECT expires_at FROM runner_commands WHERE id=$1`, [cmd.commandId]);
      expect(row.expires_at).not.toBeNull();
      answer(cmd.commandId, { accepted: true });
      await settle();
      const [empty] = await qa(`SELECT payload FROM runner_commands WHERE id=$1`, [cmd.commandId]);
      expect(empty.payload).toEqual({});
      if (n < 3)
        r.send('integration.session', {
          sessionId: sid,
          kind: 'claude-code',
          instance: '',
          state: 'awaiting_code',
          error: 'That address did not match.',
        });
      await settle();
    }
    // a fourth paste is not accepted
    r.send('integration.session', {
      sessionId: sid,
      kind: 'claude-code',
      instance: '',
      state: 'awaiting_code',
    });
    await settle();
    expect((await owner('POST', `${base()}/sessions/${sid}/input`, { envelope: envelope() })).status).toBe(
      409,
    );

    // the runner finishes: connected with a status; the tile data and the audit event follow
    r.send('integration.session', {
      sessionId: sid,
      kind: 'claude-code',
      instance: '',
      state: 'connected',
      status: status('claude-code', 'connected', { method: 'setup_token' }),
    });
    await settle();
    expect(await ok<any>(owner('GET', `${base()}/requests/${sid}`))).toMatchObject({
      state: 'connected',
      status: { method: 'setup_token' },
    });
    expect(
      (await ok<any>(owner('GET', base()))).integrations.find((i: any) => i.kind === 'claude-code'),
    ).toMatchObject({ state: 'connected' });
    const started2 = await qa(
      `SELECT payload FROM events WHERE type='WorkstationIntegrationSignInStarted' ORDER BY seq DESC LIMIT 1`,
    );
    expect(started2[0].payload).toMatchObject({ kind: 'claude-code', method: 'setup_token', by: w.owner.id });
    // after the end a new one may start, and cancel is an answer
    const f = r.received.length;
    const second = await owner('POST', `${base()}/sessions`, {
      kind: 'claude-code',
      instance: '',
      method: 'setup_token',
    });
    expect(second.status).toBe(202);
    const cancel = await owner('POST', `${base()}/sessions/${second.body.id}/cancel`);
    expect(cancel.status).toBe(202);
    expect((await ok<any>(owner('GET', `${base()}/requests/${second.body.id}`))).state).toBe('cancelled');
    await nextCommand('integration.cancel', f);
  });

  it('a runner that refuses to begin ends the session as failed with its sentence', async () => {
    const f = r.received.length;
    const s = await owner('POST', `${base()}/sessions`, {
      kind: 'github',
      instance: 'github.com',
      method: 'device',
    });
    const begin = await nextCommand('integration.begin', f);
    answer(begin.commandId, { error: 'Turned off on this workstation.', code: 'allow_web_off' });
    await settle();
    expect(await ok<any>(owner('GET', `${base()}/requests/${s.body.id}`))).toMatchObject({
      state: 'failed',
      error: 'Turned off on this workstation.',
    });
  });
});

describe('test and remove', () => {
  it('relay a request and store the answer; remove records an audit event', async () => {
    const f = r.received.length;
    const requestId = randomUUID();
    await owner('POST', `${base()}/remove`, { requestId, kind: 'jira', instance: '' });
    const cmd = await nextCommand('integration.remove', f);
    answer(cmd.commandId, { status: status('jira', 'not_connected') });
    await settle();
    expect(await ok<any>(owner('GET', `${base()}/requests/${requestId}`))).toMatchObject({
      state: 'done',
      status: { state: 'not_connected' },
    });
    const ev = await qa(
      `SELECT payload FROM events WHERE type='WorkstationIntegrationRemoved' ORDER BY seq DESC LIMIT 1`,
    );
    expect(ev[0].payload).toMatchObject({ kind: 'jira', by: w.owner.id });
    const f2 = r.received.length;
    const t = randomUUID();
    await owner('POST', `${base()}/test`, { requestId: t, kind: 'jira', instance: '' });
    const tc = await nextCommand('integration.test', f2);
    answer(tc.commandId, { status: status('jira', 'refused', { detail: 'Jira answered 401' }) });
    await settle();
    expect((await ok<any>(owner('GET', `${base()}/requests/${t}`))).status).toMatchObject({
      state: 'refused',
    });
  });
});

describe('expiry', () => {
  it('a sealed command nobody collected is failed and emptied by the sweep, and its request expires', async () => {
    const requestId = randomUUID();
    // make the runner unable to answer: close the socket after the request is queued but before it is claimed is racy,
    // so insert the command directly the way the route does, with an expiry in the past
    const [cmd] = await qa(
      `INSERT INTO runner_commands (workstation_id, type, payload, expires_at, status) VALUES ($1,'integration.connect',$2,$3,'sent') RETURNING id`,
      [
        w.workstationId,
        JSON.stringify({ requestId, kind: 'jira', envelope: envelope() }),
        new Date(Date.now() - 60_000),
      ],
    );
    await qa(
      `INSERT INTO integration_requests (id, workstation_id, user_id, kind, instance, op, method, state, command_id, created_at, updated_at, expires_at)
       VALUES ($1,$2,$3,'jira','','connect','token','pending',$4,now(),now(),now() + interval '1 hour')`,
      [requestId, w.workstationId, w.owner.id, cmd.id],
    );
    await sweepIntegrations(w.t.app.ctx);
    const [after] = await qa(`SELECT status, payload FROM runner_commands WHERE id=$1`, [cmd.id]);
    expect(after).toMatchObject({ status: 'failed', payload: {} });
    expect(await ok<any>(owner('GET', `${base()}/requests/${requestId}`))).toMatchObject({
      state: 'expired',
    });
  });

  it('an expired command is never delivered', async () => {
    const [cmd] = await qa(
      `INSERT INTO runner_commands (workstation_id, type, payload, expires_at) VALUES ($1,'integration.input',$2,$3) RETURNING id`,
      [
        w.workstationId,
        JSON.stringify({ sessionId: randomUUID(), kind: 'mcp', instance: 'x', envelope: envelope() }),
        new Date(Date.now() - 1000),
      ],
    );
    const from = r.received.length;
    await w.t.app.ctx.services.gateway.deliverPending(w.workstationId);
    await settle();
    expect(
      r
        .of('command')
        .slice(from)
        .some((c) => c.commandId === cmd.id),
    ).toBe(false);
    await qa(`UPDATE runner_commands SET status='failed', payload='{}' WHERE id=$1`, [cmd.id]);
  });
});

describe('older runners', () => {
  it('the page shows statuses derived from the legacy reports, read-only; connecting says to update the runner', async () => {
    const wsId = w.workstationId;
    await qa(`UPDATE workstations SET integrations_version=NULL WHERE id=$1`, [wsId]);
    r.send('git.report', {
      connections: [
        {
          provider: 'github',
          host: 'github.com',
          state: 'connected',
          account: 'octo',
          method: 'cli',
          checkedAt: new Date().toISOString(),
        },
        {
          provider: 'bitbucket-cloud',
          host: 'bitbucket.org',
          state: 'not_connected',
          problem: 'token_refused',
          checkedAt: new Date().toISOString(),
          ssh: { defaultMethod: 'https', key: 'generated', publicKey: 'ssh-ed25519 AAAA test' },
        },
      ],
    });
    r.send('jira.report', {
      status: { state: 'connected', baseUrl: 'https://acme.atlassian.net', account: 'Pieter' },
    });
    r.send('mcp.servers', {
      servers: [
        { name: 'plugin_a_b', plugin: 'a', server: 'b', transport: 'http', authState: 'needs_sign_in' },
      ],
    });
    await settle();
    const page = await ok<any>(owner('GET', base()));
    expect(page.legacy).toBe(true);
    expect(page.runner.integrationsVersion).toBeNull();
    const by = (k: string) => page.integrations.filter((i: any) => i.kind === k);
    expect(by('github')[0]).toMatchObject({
      instance: 'github.com',
      state: 'connected',
      account: 'octo',
      scope: 'machine',
    });
    expect(by('bitbucket-cloud')[0]).toMatchObject({ state: 'refused' });
    expect(by('ssh')[0]).toMatchObject({
      instance: 'bitbucket-cloud@bitbucket.org',
      publicKey: 'ssh-ed25519 AAAA test',
    });
    expect(by('jira')[0]).toMatchObject({ state: 'connected', site: 'https://acme.atlassian.net' });
    expect(by('mcp')[0]).toMatchObject({ instance: 'plugin_a_b', state: 'needs_sign_in' });
    const refused = await owner('POST', `${base()}/connect`, {
      requestId: randomUUID(),
      kind: 'jira',
      instance: '',
      method: 'token',
      envelope: envelope(),
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code ?? refused.body.error?.code).toBe('runner_too_old');
    // a hello that announces the version puts it back
    r.hello({ runtimes: MOCK_RUNTIME, sudoKey: KEY, integrationsVersion: 1 });
    await settle();
    expect((await ok<any>(owner('GET', base()))).legacy).toBe(false);
  });
});

describe('no secret on the server side', () => {
  it('the envelope text appears in no event and in no log line; the redact paths cover the envelope', async () => {
    const events = await qa(`SELECT payload FROM events WHERE type LIKE 'WorkstationIntegration%'`);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(MARK);
    const requests = await qa(`SELECT * FROM integration_requests`);
    expect(JSON.stringify(requests)).not.toContain(MARK);
    // the logger with the app's redact options: a request body with an envelope is censored
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = Fastify({ logger: { level: 'info', redact: LOG_REDACT, stream } }).log;
    log.info({ req: { body: { envelope: envelope(), kind: 'jira' } } }, 'request');
    log.error({ err: { body: { envelope: envelope() } }, payload: { envelope: envelope() } }, 'failed');
    log.warn({ some: { envelope: envelope() } }, 'nested');
    expect(lines.join('')).not.toContain(MARK);
    expect(lines.join('')).toContain('[redacted]');
  });

  it('commands whose payload is emptied leave nothing behind', async () => {
    const left = await qa(
      `SELECT id FROM runner_commands WHERE type IN ('integration.connect','integration.input') AND status IN ('done','failed') AND payload::text LIKE $1`,
      [`%${MARK}%`],
    );
    expect(left).toEqual([]);
  });
});

describe('operational tables survive a rebuild', () => {
  it('workstation_integrations is saved and restored; nothing is left unsaved', async () => {
    expect(await unsavedCascadeTargets(w.t.app.ctx.pool)).toEqual([]);
    r.send('integrations.report', {
      integrations: [status('jira', 'connected', { account: 'Pieter' })],
      registryVersion: 1,
    });
    await settle();
    const before = await qa(`SELECT count(*)::int AS n FROM workstation_integrations`);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    const after = await qa(
      `SELECT count(*)::int AS n FROM workstation_integrations WHERE workstation_id=$1`,
      [w.workstationId],
    );
    expect(after[0].n).toBe(1);
    expect(before[0].n).toBeGreaterThan(0);
  });
});

describe('desk notices carry the workstation', () => {
  it('a claude_auth_expired item exposes data.workstationId for the deep link', async () => {
    r.send('runtimes.report', {
      runtimes: [{ id: 'claude-code', version: '2', available: false, capabilities: [], auth: 'expired' }],
    });
    await settle();
    await w.t.app.ctx.notifier.flush();
    const desk = await ok<any>(owner('GET', '/api/desk'));
    const item = desk.items.find((i: any) => i.subkind === 'claude_auth_expired');
    expect(item?.data?.workstationId).toBe(w.workstationId);
  });
});

describe('offline', () => {
  it('an offline workstation answers 409 workstation_offline', async () => {
    const r2w = await createWorld();
    const res = await r2w.t.req('POST', `/api/workstations/${r2w.workstationId}/integrations/connect`, {
      cookie: r2w.owner.cookie,
      body: { requestId: randomUUID(), kind: 'jira', instance: '', method: 'token', envelope: envelope() },
    });
    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe('workstation_offline');
    await r2w.t.close();
  });
});

describe('rate limits', () => {
  it('sign-in starts are limited per workstation (6 in 10 minutes)', async () => {
    const w2 = await createWorld({ env: { AOM_RATE_LIMIT: 'true' } });
    const r2 = await w2.connectRunner({ hello: false });
    r2.hello({ runtimes: MOCK_RUNTIME, sudoKey: KEY, integrationsVersion: 1 });
    await r2.waitFor('welcome');
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await w2.t.req('POST', `/api/workstations/${w2.workstationId}/integrations/sessions`, {
        cookie: w2.owner.cookie,
        body: { kind: 'claude-code', instance: '', method: 'setup_token' },
      });
      statuses.push(res.status);
    }
    expect(statuses[0]).toBe(202);
    expect(statuses[6]).toBe(429);
    r2.close();
    await w2.t.close();
  });
});
