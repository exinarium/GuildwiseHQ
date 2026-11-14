import { randomUUID } from 'node:crypto';
import { APP_INTEGRATIONS_CAPABILITY, INTEGRATION_ENVELOPE_ALG } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendAppSync } from '../src/commands/org-apps.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, until, type World } from './helpers/world.ts';

/**
 * Automated apps (Settings > Automated apps): Owner only, the server relays sealed envelopes and keeps metadata only, the
 * integration exists only after a runner verified the key, and removal reaches every workstation that holds it.
 */
let w: World;
let r1: FakeRunner;
let orgId: string;
let admin: { id: string; cookie: string; email: string };
let member: { id: string; cookie: string; email: string };
let outsider: { id: string; cookie: string; email: string };
const KEY1 = { keyId: 'aaaaaaaaaaaaaaaa', publicKey: 'AAAA1' };
// What a browser would post: ciphertext only. The marker lets the test grep every row for it.
const CT = 'Q0lQSEVSVEVYVC1PRi1USEUtUEVNLTEyMzQ1Njc4OTA=';
const FAKE_PEM_BODY = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun';

const as = (u: { cookie: string }) => ({ cookie: u.cookie, headers: { 'x-aom-org': orgId } });
const call = (u: { cookie: string }, method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { ...as(u), ...(body !== undefined ? { body } : {}) });

const envelope = () => ({
  v: 1,
  alg: INTEGRATION_ENVELOPE_ALG,
  keyId: KEY1.keyId,
  wrappedKey: 'd3JhcHBlZA==',
  iv: 'aXY=',
  ct: CT,
});
const addBody = (over: Record<string, unknown> = {}) => ({
  requestId: randomUUID(),
  provider: 'github-app',
  label: 'Guild bot',
  host: 'github.com',
  appRef: '4242',
  installationId: '777',
  shares: [{ workstationId: w.workstationId, ref: randomUUID(), keyId: KEY1.keyId, envelope: envelope() }],
  ...over,
});
const IDENTITY = {
  provider: 'github-app',
  host: 'github.com',
  appId: '4242',
  appSlug: 'guild-bot',
  appName: 'Guild Bot',
  installationId: '777',
  account: 'acme',
  accountType: 'Organization',
  repositorySelection: 'selected',
  botLogin: 'guild-bot[bot]',
  botUserId: '99001',
  commitName: 'guild-bot[bot]',
  commitEmail: '99001+guild-bot[bot]@users.noreply.github.com',
  permissions: { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' },
  missingPermissions: [],
};

const commandsOf = (type: string, from = 0) =>
  r1.received.slice(from).filter((f) => f.type === 'command' && f.command === type) as any[];

async function poll(rid: string, until_: (s: string) => boolean) {
  let last: any;
  await until(
    async () => {
      last = (await call(w.owner, 'GET', `/api/org/apps/requests/${rid}`)).body;
      return until_(last.state);
    },
    5000,
    'request state',
  );
  return last;
}

/** Everything persisted or answered that could hold key material. */
async function persistedText(): Promise<string> {
  const parts = await Promise.all([
    q(`SELECT payload::text AS t FROM events`),
    q(`SELECT row_to_json(x)::text AS t FROM org_app_integrations x`),
    q(`SELECT row_to_json(x)::text AS t FROM org_app_integration_workstations x`),
    q(`SELECT row_to_json(x)::text AS t FROM app_integration_requests x`),
    q(`SELECT payload::text AS t FROM runner_commands WHERE type LIKE 'app.%' AND status <> 'pending'`),
  ]);
  return parts
    .flat()
    .map((r) => String(r.t))
    .join('\n');
}

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
  admin = await w.t.userSession(uniqueEmail('admin'));
  member = await w.t.userSession(uniqueEmail('member'));
  outsider = await w.t.userSession(uniqueEmail('outsider'));
  await w.t.addOrgMember(orgId, admin.id, 'admin');
  await w.t.addOrgMember(orgId, member.id, 'member');
  r1 = await w.connectRunner({ hello: false });
  r1.hello({ capabilities: [APP_INTEGRATIONS_CAPABILITY], sudoKey: KEY1 });
  await r1.waitFor('welcome');
  await w.t.app.ctx.notifier.flush();
});
afterAll(async () => {
  r1.close();
  await w.t.close();
  await closeAdminPool();
});

describe('automated apps: who may manage them', () => {
  it('an Admin and a member get 403 on every write route, a non-member is refused, and only the Owner sees targets', async () => {
    const id = randomUUID();
    for (const u of [admin, member]) {
      expect((await call(u, 'POST', '/api/org/apps', addBody())).status).toBe(403);
      expect((await call(u, 'PATCH', `/api/org/apps/${id}`, { label: 'x' })).status).toBe(403);
      expect((await call(u, 'POST', `/api/org/apps/${id}/test`)).status).toBe(403);
      expect((await call(u, 'DELETE', `/api/org/apps/${id}`)).status).toBe(403);
      const list = (await call(u, 'GET', '/api/org/apps')).body;
      expect(list.canManage).toBe(false);
      expect(list.targets).toBeUndefined();
    }
    const out = await call(outsider, 'POST', '/api/org/apps', addBody());
    expect([403, 404]).toContain(out.status);
    const own = (await call(w.owner, 'GET', '/api/org/apps')).body;
    expect(own.canManage).toBe(true);
    expect(own.targets.map((t: { id: string }) => t.id)).toContain(w.workstationId);
  });

  it('refuses a body that carries the private key in the clear, or an unknown field', async () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${FAKE_PEM_BODY}\n-----END RSA PRIVATE KEY-----`;
    const r = await call(w.owner, 'POST', '/api/org/apps', { ...addBody(), privateKey: pem });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('plaintext_key_refused');
    expect(JSON.stringify(r.body)).not.toContain(FAKE_PEM_BODY);
    expect((await call(w.owner, 'POST', '/api/org/apps', { ...addBody(), privateKey: 'x' })).status).toBe(
      400,
    );
  });

  it('the workstation Integrations routes send a GitHub App to the organization page', async () => {
    const r = await call(w.owner, 'POST', `/api/workstations/${w.workstationId}/integrations/test`, {
      requestId: randomUUID(),
      kind: 'github-app',
      instance: '4242:777',
    });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toContain('manage_in_org');
  });
});

describe('automated apps: add, fail, remove', () => {
  it('a failed verify on every workstation leaves no integration and no event', async () => {
    const from = r1.received.length;
    const body = addBody();
    const res = await call(w.owner, 'POST', '/api/org/apps', body);
    expect(res.status).toBe(202);
    const c = await r1.waitFor('command', (x) => x.command === 'app.connect', 5000, from);
    expect(c.payload).toMatchObject({ orgId, appRef: '4242', installationId: '777', envelope: { ct: CT } });
    r1.send('command.result', {
      commandId: c.commandId,
      ok: true,
      result: { ok: false, code: 'jwt_rejected', message: 'GitHub refused the app key or App ID.' },
    });
    const done = await poll(body.requestId, (s) => s !== 'pending');
    expect(done.state).toBe('failed');
    expect(done.results[0]).toMatchObject({
      workstationId: w.workstationId,
      ok: false,
      code: 'jwt_rejected',
    });
    expect(await q(`SELECT 1 FROM org_app_integrations WHERE org_id=$1`, [orgId])).toEqual([]);
    expect(await q(`SELECT 1 FROM events WHERE type LIKE 'OrgAppIntegration%'`)).toEqual([]);
    expect((await q(`SELECT payload FROM runner_commands WHERE id=$1`, [c.commandId]))[0]?.payload).toEqual(
      {},
    );
  });

  it('the first verified share creates the integration; nothing persisted or answered holds the envelope or key', async () => {
    const from = r1.received.length;
    const body = addBody();
    const add = await call(w.owner, 'POST', '/api/org/apps', body);
    const c = await r1.waitFor('command', (x) => x.command === 'app.connect', 5000, from);
    r1.send('command.result', {
      commandId: c.commandId,
      ok: true,
      result: { ok: true, instance: '4242:777', identity: IDENTITY },
    });
    const done = await poll(body.requestId, (s) => s !== 'pending');
    expect(done.state).toBe('done');
    expect(done.identity).toMatchObject({ botLogin: 'guild-bot[bot]', commitEmail: IDENTITY.commitEmail });
    const list = await call(member, 'GET', '/api/org/apps');
    const app = list.body.apps[0];
    expect(app).toMatchObject({
      label: 'Guild bot',
      botLogin: 'guild-bot[bot]',
      commitEmail: IDENTITY.commitEmail,
    });
    expect(app.workstations).toBeUndefined();
    const own = await call(w.owner, 'GET', '/api/org/apps');
    expect(own.body.apps[0].workstations.map((x: { id: string }) => x.id)).toEqual([w.workstationId]);
    // AC3: no row, event, finished command or API answer holds the ciphertext or any key text
    const text = [
      await persistedText(),
      ...[add.body, list.body, own.body, done].map((x) => JSON.stringify(x)),
    ].join('\n');
    expect(text).not.toContain(CT);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain(FAKE_PEM_BODY);
    // a second add of the same installation is refused
    expect((await call(w.owner, 'POST', '/api/org/apps', addBody())).status).toBe(409);
  });

  it('an answer with an unknown field (a token) is not trusted and nothing of it is kept', async () => {
    const from = r1.received.length;
    const body = addBody({ installationId: '778' });
    await call(w.owner, 'POST', '/api/org/apps', body);
    const c = await r1.waitFor('command', (x) => x.command === 'app.connect', 5000, from);
    r1.send('command.result', {
      commandId: c.commandId,
      ok: true,
      result: { ok: true, instance: '4242:778', identity: IDENTITY, token: 'ghs_leakedtoken000000000000' },
    });
    const done = await poll(body.requestId, (s) => s !== 'pending');
    expect(done.state).toBe('failed');
    expect(await persistedText()).not.toContain('ghs_leakedtoken');
  });

  it('rename and test are the Owner’s; remove sends app.remove and the app leaves the list', async () => {
    const id = (await call(w.owner, 'GET', '/api/org/apps')).body.apps[0].id as string;
    expect((await call(w.owner, 'PATCH', `/api/org/apps/${id}`, { label: 'Release bot' })).status).toBe(200);
    const from = r1.received.length;
    const t = await call(w.owner, 'POST', `/api/org/apps/${id}/test`);
    expect(t.status).toBe(202);
    const tc = await r1.waitFor('command', (x) => x.command === 'app.test', 5000, from);
    expect(tc.payload).toMatchObject({ instance: '4242:777' });
    const del = await call(w.owner, 'DELETE', `/api/org/apps/${id}`);
    expect(del.status).toBe(202);
    const rc = await r1.waitFor('command', (x) => x.command === 'app.remove', 5000, from);
    expect(rc.payload).toMatchObject({ orgId, integrationId: id, instance: '4242:777' });
    expect((await call(w.owner, 'GET', '/api/org/apps')).body.apps).toEqual([]);
    expect(await q(`SELECT expires_at FROM runner_commands WHERE id=$1`, [rc.commandId])).toEqual([
      { expires_at: null },
    ]);
    expect(commandsOf('app.remove', from)).toHaveLength(1);
    expect(await q(`SELECT 1 FROM events WHERE type='OrgAppIntegrationRemoved'`)).toHaveLength(1);
  });
});

describe('automated apps: app.sync and offline removal', () => {
  const syncRows = () =>
    q(
      `SELECT id, status, last_error, payload FROM runner_commands
        WHERE workstation_id=$1 AND type='app.sync' ORDER BY created_at, id`,
      [w.workstationId],
    );
  const reconnect = async () => {
    r1.close();
    await r1.waitClosed().catch(() => undefined);
    r1 = await w.connectRunner({ hello: false });
    r1.hello({ capabilities: [APP_INTEGRATIONS_CAPABILITY], sudoKey: KEY1 });
    await r1.waitFor('welcome');
    await w.t.app.ctx.notifier.flush();
  };
  let appId = '';

  it('skips app.sync while this workstation owes an answer to a share, and syncs once it is answered', async () => {
    const from = r1.received.length;
    const body = addBody({ installationId: '900' });
    expect((await call(w.owner, 'POST', '/api/org/apps', body)).status).toBe(202);
    const c = await r1.waitFor('command', (x) => x.command === 'app.connect', 5000, from);
    const before = (await syncRows()).length;
    await sendAppSync(w.t.app.ctx, w.workstationId);
    expect(await syncRows()).toHaveLength(before);
    r1.send('command.result', {
      commandId: c.commandId,
      ok: true,
      result: { ok: true, instance: '4242:900', identity: { ...IDENTITY, installationId: '900' } },
    });
    await poll(body.requestId, (s) => s !== 'pending');
    appId = (await call(w.owner, 'GET', '/api/org/apps')).body.apps[0].id as string;
    await sendAppSync(w.t.app.ctx, w.workstationId);
    expect(await syncRows()).toHaveLength(before + 1);
  });

  it('queues app.sync after welcome with the apps of the projection and replaces an older pending one', async () => {
    r1.close();
    await r1.waitClosed().catch(() => undefined);
    await sendAppSync(w.t.app.ctx, w.workstationId); // queued while the runner is away
    const stale = (await syncRows()).at(-1) as { id: string; status: string };
    expect(stale.status).toBe('pending');
    const from = 0;
    r1 = await w.connectRunner({ hello: false });
    r1.hello({ capabilities: [APP_INTEGRATIONS_CAPABILITY], sudoKey: KEY1 });
    await r1.waitFor('welcome');
    await w.t.app.ctx.notifier.flush();
    const sync = await r1.waitFor(
      'command',
      (x) => x.command === 'app.sync' && x.commandId !== stale.id,
      5000,
      from,
    );
    expect(sync.payload.orgIds).toContain(orgId);
    expect(sync.payload.apps).toEqual([{ orgId, integrationId: appId, instance: '4242:900' }]);
    const replaced = (await q(`SELECT status, last_error FROM runner_commands WHERE id=$1`, [stale.id]))[0];
    expect(replaced).toEqual({ status: 'failed', last_error: 'replaced' });
  });

  it('does not queue app.sync for a runner without the capability', async () => {
    const before = (await syncRows()).length;
    r1.close();
    await r1.waitClosed().catch(() => undefined);
    r1 = await w.connectRunner({ hello: false });
    r1.hello({ capabilities: [], sudoKey: KEY1 });
    await r1.waitFor('welcome');
    await w.t.app.ctx.notifier.flush();
    expect(await syncRows()).toHaveLength(before);
    await reconnect();
  });

  it('removing an app while the workstation is offline queues app.remove without expiry; it arrives on reconnect', async () => {
    r1.close();
    await r1.waitClosed().catch(() => undefined);
    expect((await call(w.owner, 'DELETE', `/api/org/apps/${appId}`)).status).toBe(202);
    const queued = await q(
      `SELECT id, status, expires_at, payload FROM runner_commands
        WHERE workstation_id=$1 AND type='app.remove' AND payload->>'integrationId'=$2`,
      [w.workstationId, appId],
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: 'pending', expires_at: null });
    expect(queued[0]?.payload).toMatchObject({ orgId, integrationId: appId, instance: '4242:900' });
    r1 = await w.connectRunner({ hello: false });
    r1.hello({ capabilities: [APP_INTEGRATIONS_CAPABILITY], sudoKey: KEY1 });
    await r1.waitFor('welcome');
    await w.t.app.ctx.notifier.flush();
    // an unacknowledged app.remove of an earlier test is delivered again too: wait for this one by id
    const rc = await r1.waitFor('command', (x) => x.commandId === queued[0]?.id, 5000, 0);
    expect(rc.command).toBe('app.remove');
    // the sync after this welcome no longer lists the removed app
    // welcome goes out before the server queues app.sync: wait for the new row
    type SyncRow = { id: string; status: string; payload: { apps: unknown[] } };
    await until(
      async () => ((await syncRows()).at(-1) as SyncRow).payload.apps?.length === 0,
      5000,
      'app.sync after welcome',
    );
    const latest = (await syncRows()).at(-1) as SyncRow;
    const sync = await r1.waitFor('command', (x) => x.commandId === latest.id, 5000, 0);
    expect(sync.payload.apps).toEqual([]);
    // the older sync that still listed the app was replaced, so it can no longer be delivered
    expect((await syncRows()).filter((x: any) => x.status === 'pending' && x.id !== latest.id)).toEqual([]);
  });
});
