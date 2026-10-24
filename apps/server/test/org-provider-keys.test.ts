import { randomUUID } from 'node:crypto';
import { BUILTIN_ROLES, PROVIDER_KEYS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateAllProviderCaps, evaluateProviderCap } from '../src/commands/org-provider-keys.ts';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { providerCapProblem, providerCapState } from '../src/provider-keys/caps.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { FakeRunner } from './helpers/fake-runner.ts';
import { shiftHelpers } from './helpers/shifts.ts';
import { createWorld, markOnline, pairWorkstation, until, type World } from './helpers/world.ts';

/**
 * Organization-wide provider keys with a monthly cap per provider (docs/ARCHITECTURE.md section 38.5): the server stores only the
 * ciphertexts sealed per workstation, relays them, and forgets each once its runner stored it; revocation removes them
 * everywhere; the cap counts the shift_costs of the organization's key, warns at 80%, stops new runs at 100%, and leaves a
 * workstation's own key alone. Isolation between organizations and roles, old runners, rebuild equality.
 */
let w: World;
let r1: FakeRunner;
let r2: FakeRunner;
let orgId: string;
let admin: { id: string; cookie: string; email: string };
let member: { id: string; cookie: string; email: string };
let outsider: { id: string; cookie: string; email: string };
let ws2: string;
let ws3: string;
const KEY1 = { keyId: 'aaaaaaaaaaaaaaaa', publicKey: 'AAAA1' };
const KEY2 = { keyId: 'bbbbbbbbbbbbbbbb', publicKey: 'BBBB2' };
const SECRET1 = 'U0VDUkVULUNJUEhFUlRFWFQtMQ==';
const SECRET2 = 'U0VDUkVULUNJUEhFUlRFWFQtMg==';

const ctx = () => w.t.app.ctx;
const as = (u: { cookie: string }) => ({ cookie: u.cookie, headers: { 'x-aom-org': orgId } });
const call = (u: { cookie: string }, method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { ...as(u), ...(body !== undefined ? { body } : {}) });
const asOwner = (method: string, url: string, body?: unknown) => call(w.owner, method, url, body);

const GEMINI_RUNTIMES = (orgIds: string[], source: 'org' | 'workstation' = 'org') => [
  { id: 'mock', version: '1', available: true, capabilities: ['shell', 'edit', 'web'] },
  {
    id: 'gemini',
    version: '0.65.0',
    available: true,
    capabilities: ['shell', 'edit', 'web'],
    authVia: 'key',
  },
  {
    id: 'direct-model',
    version: 'v',
    available: true,
    capabilities: ['skills'],
    keys: [
      {
        provider: 'google',
        source,
        ...(source === 'org' ? { orgKey: true, orgIds } : { orgKey: true, orgIds }),
      },
    ],
  },
];

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
  admin = await w.t.userSession(uniqueEmail('admin'));
  member = await w.t.userSession(uniqueEmail('member'));
  outsider = await w.t.userSession(uniqueEmail('outsider'));
  await w.t.addOrgMember(orgId, admin.id, 'admin');
  await w.t.addOrgMember(orgId, member.id, 'member');
  r1 = await w.connectRunner({ hello: false });
  r1.hello({
    runtimes: GEMINI_RUNTIMES([]) as never,
    capabilities: [PROVIDER_KEYS_CAPABILITY],
    sudoKey: KEY1,
  });
  await r1.waitFor('welcome');
  // the member's workstation: a second runner that also knows organization keys
  const m = await pairWorkstation(w.t, member, 'member-box');
  ws2 = m.workstationId;
  r2 = await FakeRunner.connect(w.baseUrl, m.runnerToken);
  r2.hello({ capabilities: [PROVIDER_KEYS_CAPABILITY], sudoKey: KEY2 });
  await r2.waitFor('welcome');
  // a third workstation (the member's) with an older runner that does not know organization keys
  const old = await pairWorkstation(w.t, member, 'old-box');
  ws3 = old.workstationId;
  const r3 = await FakeRunner.connect(w.baseUrl, old.runnerToken);
  r3.hello({ sudoKey: { keyId: 'cccccccccccccccc', publicKey: 'CCCC3' } });
  await r3.waitFor('welcome');
  await w.t.app.ctx.notifier.flush();
  r3.close();
});
afterAll(async () => {
  r1.close();
  r2.close();
  await w.t.close();
  await closeAdminPool();
});

const share = (workstationId: string, keyId: string, ciphertext: string) => ({
  workstationId,
  keyId,
  ciphertext,
});
const commandsOf = (r: FakeRunner, type: string, from = 0) =>
  r.received.slice(from).filter((f) => f.type === 'command' && f.command === type) as any[];

describe('setting an organization key', () => {
  it('stores one ciphertext per workstation, relays it with its organization, and forgets it once the runner stored it', async () => {
    const from1 = r1.received.length;
    const from2 = r2.received.length;
    const res = await call(admin, 'PUT', '/api/org/providers/openai', {
      detail: 'main account',
      models: [],
      shares: [share(w.workstationId, KEY1.keyId, SECRET1), share(ws2, KEY2.keyId, SECRET2)],
    });
    expect(res.status).toBe(202);
    const c1 = await r1.waitFor(
      'command',
      (c) => c.command === 'provider.key.set' && c.payload.source === 'org',
      5000,
      from1,
    );
    const c2 = await r2.waitFor(
      'command',
      (c) => c.command === 'provider.key.set' && c.payload.source === 'org',
      5000,
      from2,
    );
    expect(c1.payload).toMatchObject({
      provider: 'openai',
      source: 'org',
      orgId,
      keyId: KEY1.keyId,
      ciphertext: SECRET1,
    });
    // every runner gets the copy sealed for IT
    expect(c2.payload).toMatchObject({ keyId: KEY2.keyId, ciphertext: SECRET2 });
    const rows = await q(
      'SELECT workstation_id, key_id, ciphertext, status FROM org_provider_key_shares WHERE org_id=$1 ORDER BY key_id',
      [orgId],
    );
    expect(rows.map((x) => [x.workstation_id, x.status])).toEqual([
      [w.workstationId, 'queued'],
      [ws2, 'queued'],
    ]);
    // the facts are an event, the key never is
    expect(
      await q(
        `SELECT 1 FROM events WHERE payload::text LIKE '%${SECRET1}%' OR payload::text LIKE '%${SECRET2}%'`,
      ),
    ).toEqual([]);
    expect(
      (
        await q('SELECT configured, detail FROM org_providers WHERE org_id=$1 AND provider=$2', [
          orgId,
          'openai',
        ])
      )[0],
    ).toMatchObject({ configured: true, detail: 'main account' });

    r1.send('command.result', { commandId: c1.commandId, ok: true, result: { stored: true } });
    r2.send('command.result', {
      commandId: c2.commandId,
      ok: true,
      result: { stored: false, error: 'the key could not be decrypted: enter it again' },
    });
    await r1.barrier();
    await r2.barrier();
    await until(
      async () =>
        (await q(`SELECT 1 FROM org_provider_key_shares WHERE org_id=$1 AND ciphertext IS NOT NULL`, [orgId]))
          .length === 0,
    );
    const after = await q(
      'SELECT workstation_id, status, error, ciphertext FROM org_provider_key_shares WHERE org_id=$1',
      [orgId],
    );
    expect(after.find((x) => x.workstation_id === w.workstationId)).toMatchObject({
      status: 'stored',
      ciphertext: null,
    });
    expect(after.find((x) => x.workstation_id === ws2)).toMatchObject({
      status: 'failed',
      ciphertext: null,
      error: 'the key could not be decrypted: enter it again',
    });
    // the command queue forgot the sealed payloads too
    expect(
      await q(
        `SELECT 1 FROM runner_commands WHERE payload::text LIKE '%SECRET-CIPHERTEXT%' OR payload::text LIKE '%${SECRET1}%'`,
      ),
    ).toEqual([]);

    const page = (await call(admin, 'GET', '/api/org/providers')).body;
    const openai = page.providers.find((p: any) => p.provider === 'openai');
    expect(openai.configured).toBe(true);
    expect(openai.workstations.find((x: any) => x.workstationId === w.workstationId)).toMatchObject({
      status: 'stored',
      online: true,
      supported: true,
      canShare: true,
    });
    expect(openai.workstations.find((x: any) => x.workstationId === ws2)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/decrypted/),
    });
    expect(JSON.stringify(page)).not.toContain(SECRET1);
  });

  it('refuses a stale runner key, a runner that predates organization keys, and a workstation of someone outside the organization', async () => {
    const stale = await call(admin, 'PUT', '/api/org/providers/google', {
      models: [],
      shares: [share(w.workstationId, 'old', SECRET1)],
    });
    expect(stale.status).toBe(409);
    const old = await call(admin, 'PUT', '/api/org/providers/google', {
      models: [],
      shares: [share(ws3, 'cccccccccccccccc', SECRET1)],
    });
    expect(old.status).toBe(422);
    expect(old.body.error?.code ?? old.body.code).toBe('runner_too_old');
    const stranger = await pairWorkstation(w.t, outsider, 'stranger-box');
    const out = await call(admin, 'PUT', '/api/org/providers/google', {
      models: [],
      shares: [share(stranger.workstationId, KEY1.keyId, SECRET1)],
    });
    expect(out.status).toBe(404);
    expect(
      (await call(admin, 'GET', '/api/org/providers')).body.providers
        .find((p: any) => p.provider === 'google')
        .workstations.find((x: any) => x.workstationId === ws3).status,
    ).toBe('too_old');
  });

  it('is for the Owner and Admins only, and another organization sees nothing of it', async () => {
    expect((await call(member, 'GET', '/api/org/providers')).status).toBe(403);
    expect(
      (
        await call(member, 'PUT', '/api/org/providers/openai', {
          models: [],
          shares: [share(ws2, KEY2.keyId, SECRET2)],
        })
      ).status,
    ).toBe(403);
    expect((await call(member, 'PUT', '/api/org/providers/openai/cap', { monthlyUsd: 5 })).status).toBe(403);
    expect((await call(member, 'DELETE', '/api/org/providers/openai')).status).toBe(403);
    // someone who is not in the organization cannot address it at all
    expect([403, 404]).toContain((await call(outsider, 'GET', '/api/org/providers')).status);
    // the outsider's own organization has no such provider key
    const own = await w.t.req('GET', '/api/org/providers', { cookie: outsider.cookie });
    expect(own.status).toBe(200);
    expect(
      own.body.providers.every(
        (p: any) => !p.configured && p.workstations.every((x: any) => x.workstationId !== w.workstationId),
      ),
    ).toBe(true);
    expect(
      (
        await call(w.owner, 'PUT', '/api/org/providers/mistral', {
          models: [],
          shares: [share(ws2, KEY2.keyId, SECRET2)],
        })
      ).status,
    ).toBe(400);
  });

  it('replacing the key sends the new copies and makes the workstations left out forget the old one', async () => {
    const from1 = r1.received.length;
    const from2 = r2.received.length;
    await call(admin, 'PUT', '/api/org/providers/openai', {
      models: [],
      shares: [share(w.workstationId, KEY1.keyId, 'bmV3LWNpcGhlcg==')],
    });
    const set = await r1.waitFor(
      'command',
      (c) => c.command === 'provider.key.set' && c.payload.ciphertext === 'bmV3LWNpcGhlcg==',
      5000,
      from1,
    );
    r1.send('command.result', { commandId: set.commandId, ok: true, result: { stored: true } });
    const clear = await r2.waitFor('command', (c) => c.command === 'provider.key.clear', 5000, from2);
    expect(clear.payload).toEqual({ provider: 'openai', source: 'org', orgId });
    expect(
      (
        await q('SELECT workstation_id FROM org_provider_key_shares WHERE org_id=$1 AND provider=$2', [
          orgId,
          'openai',
        ])
      ).map((x) => x.workstation_id),
    ).toEqual([w.workstationId]);
    await r1.barrier();
  });

  it('revoking removes the key everywhere: copies deleted, a clear command for every workstation, pending copies dropped', async () => {
    const from1 = r1.received.length;
    // a copy that has not been delivered yet must not arrive after the revocation
    await call(admin, 'PUT', '/api/org/providers/anthropic', {
      models: [],
      shares: [share(w.workstationId, KEY1.keyId, SECRET1), share(ws2, KEY2.keyId, SECRET2)],
    });
    await r1.waitFor(
      'command',
      (c) => c.command === 'provider.key.set' && c.payload.provider === 'anthropic',
      5000,
      from1,
    );
    const from2 = r2.received.length;
    const res = await call(admin, 'DELETE', '/api/org/providers/anthropic');
    expect(res.status).toBe(202);
    const c1 = await r1.waitFor(
      'command',
      (c) => c.command === 'provider.key.clear' && c.payload.provider === 'anthropic',
      5000,
      from1,
    );
    expect(c1.payload).toEqual({ provider: 'anthropic', source: 'org', orgId });
    await r2.waitFor(
      'command',
      (c) => c.command === 'provider.key.clear' && c.payload.provider === 'anthropic',
      5000,
      from2,
    );
    expect(
      await q('SELECT 1 FROM org_provider_key_shares WHERE org_id=$1 AND provider=$2', [orgId, 'anthropic']),
    ).toEqual([]);
    expect(
      await q(
        `SELECT 1 FROM runner_commands WHERE type='provider.key.set' AND payload->>'provider'='anthropic' AND status IN ('pending','sent') AND payload <> '{}'::jsonb`,
      ),
    ).toEqual([]);
    expect(
      (
        await q('SELECT configured FROM org_providers WHERE org_id=$1 AND provider=$2', [orgId, 'anthropic'])
      )[0]?.configured,
    ).toBe(false);
  });
});

describe('sharing the key with a workstation that joined later', () => {
  it('lets the Owner or an Admin enter the key again for one workstation', async () => {
    const from2 = r2.received.length;
    const res = await call(
      admin,
      'PUT',
      '/api/org/providers/openai/shares',
      share(ws2, KEY2.keyId, 'YWdhaW4='),
    );
    expect(res.status).toBe(202);
    const c = await r2.waitFor(
      'command',
      (x) => x.command === 'provider.key.set' && x.payload.ciphertext === 'YWdhaW4=',
      5000,
      from2,
    );
    expect(c.payload).toMatchObject({ source: 'org', orgId, provider: 'openai', keyId: KEY2.keyId });
    r2.send('command.result', { commandId: c.commandId, ok: true, result: { stored: true } });
    await r2.barrier();
    await until(
      async () =>
        (
          await q(
            'SELECT status FROM org_provider_key_shares WHERE org_id=$1 AND provider=$2 AND workstation_id=$3',
            [orgId, 'openai', ws2],
          )
        )[0]?.status === 'stored',
    );
    // nothing to share for a provider the organization has no key for
    const none = await call(
      admin,
      'PUT',
      '/api/org/providers/google/shares',
      share(ws2, KEY2.keyId, 'YWdhaW4='),
    );
    expect(none.status).toBe(409);
  });

  it('asks a runner that holds the key to re-seal it to the new one, on an approval, and relays the answer', async () => {
    // the member's workstation forgets it, then it is shared again from the Owner's runner
    await call(admin, 'PUT', '/api/org/providers/openai', {
      models: ['m1'],
      shares: [share(w.workstationId, KEY1.keyId, 'b3duZXI=')],
    });
    const set = await r1.waitFor(
      'command',
      (c) => c.command === 'provider.key.set' && c.payload.ciphertext === 'b3duZXI=',
    );
    r1.send('command.result', { commandId: set.commandId, ok: true, result: { stored: true } });
    await r1.barrier();
    await until(
      async () =>
        (
          await q(
            'SELECT status FROM org_provider_key_shares WHERE org_id=$1 AND provider=$2 AND workstation_id=$3',
            [orgId, 'openai', w.workstationId],
          )
        )[0]?.status === 'stored',
    );
    // a member cannot approve it
    expect(
      (
        await call(member, 'POST', '/api/org/providers/openai/reshare', {
          sourceWorkstationId: w.workstationId,
          targetWorkstationId: ws2,
        })
      ).status,
    ).toBe(403);
    // the target must be a workstation of the organization, the source must hold the key
    expect(
      (
        await call(admin, 'POST', '/api/org/providers/openai/reshare', {
          sourceWorkstationId: ws2,
          targetWorkstationId: w.workstationId,
        })
      ).status,
    ).toBe(409);
    const from1 = r1.received.length;
    const from2 = r2.received.length;
    const res = await call(admin, 'POST', '/api/org/providers/openai/reshare', {
      sourceWorkstationId: w.workstationId,
      targetWorkstationId: ws2,
    });
    expect(res.status).toBe(202);
    const reseal = await r1.waitFor('command', (c) => c.command === 'provider.key.reseal', 5000, from1);
    expect(reseal.payload).toMatchObject({
      provider: 'openai',
      orgId,
      targetKeyId: KEY2.keyId,
      targetPublicKey: KEY2.publicKey,
      targetWorkstationId: ws2,
      approvedBy: admin.id,
    });
    // the source runner answers with the key sealed to the target; the server relays it as a normal organization key command
    r1.send('command.result', {
      commandId: reseal.commandId,
      ok: true,
      result: { ok: true, ciphertext: 'aC5yZXNlYWxlZC10by1iYm9i' },
    });
    const relayed = await r2.waitFor(
      'command',
      (c) => c.command === 'provider.key.set' && c.payload.ciphertext === 'aC5yZXNlYWxlZC10by1iYm9i',
      5000,
      from2,
    );
    expect(relayed.payload).toMatchObject({ source: 'org', orgId, keyId: KEY2.keyId, models: ['m1'] });
    expect(
      (
        await q(
          'SELECT via FROM org_provider_key_shares WHERE org_id=$1 AND provider=$2 AND workstation_id=$3',
          [orgId, 'openai', ws2],
        )
      )[0]?.via,
    ).toBe('runner');
    const ev = await q(
      `SELECT payload FROM events WHERE type='OrgProviderKeyShared' ORDER BY seq DESC LIMIT 1`,
    );
    expect(ev[0]?.payload).toMatchObject({ workstationId: ws2, via: 'runner', by: admin.id });
    expect(JSON.stringify(ev)).not.toContain('aC5yZXNl');
    r2.send('command.result', { commandId: relayed.commandId, ok: true, result: { stored: true } });
    await r2.barrier();
  });

  it('drops a re-sealed answer when the key was revoked meanwhile or the target runner key changed', async () => {
    const from1 = r1.received.length;
    await call(admin, 'POST', '/api/org/providers/openai/reshare', {
      sourceWorkstationId: w.workstationId,
      targetWorkstationId: ws2,
    });
    const reseal = await r1.waitFor('command', (c) => c.command === 'provider.key.reseal', 5000, from1);
    await call(admin, 'DELETE', '/api/org/providers/openai');
    const from2 = r2.received.length;
    r1.send('command.result', {
      commandId: reseal.commandId,
      ok: true,
      result: { ok: true, ciphertext: 'bGF0ZQ==' },
    });
    await r1.barrier();
    await new Promise((res) => setTimeout(res, 200));
    expect(
      commandsOf(r2, 'provider.key.set', from2).filter((c) => c.payload.ciphertext === 'bGF0ZQ=='),
    ).toEqual([]);
    expect(
      await q('SELECT 1 FROM org_provider_key_shares WHERE org_id=$1 AND provider=$2', [orgId, 'openai']),
    ).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ caps and attribution

async function giveGoogleKey(source: 'org' | 'workstation') {
  await markOnline(w.t, w.workstationId, { runtimes: GEMINI_RUNTIMES([orgId], source), repoIds: [w.repoId] });
}

async function addOrgSpend(
  usdMicros: number,
  over: { provider?: string; source?: string | null; unknown?: boolean; at?: Date } = {},
) {
  const agent = (await q(`SELECT id FROM agents LIMIT 1`))[0]?.id ?? randomUUID();
  await q(
    `INSERT INTO shift_costs (shift_id, org_id, agent_id, project_id, kind, model, cost_usd_micros, ended_at, key_source, key_provider, cost_unknown)
     VALUES ($1,$2,$3,$4,'card','gemini:gemini-2.5-pro',$5,$6,$7,$8,$9)`,
    [
      randomUUID(),
      orgId,
      agent,
      w.projectId,
      usdMicros,
      over.at ?? ctx().clock.now(),
      over.source === undefined ? 'org' : over.source,
      over.provider ?? 'google',
      over.unknown ?? false,
    ],
  );
}
const clearSpend = () => q(`DELETE FROM shift_costs WHERE key_source IS NOT NULL`);
const capRow = async () =>
  (await q('SELECT * FROM org_providers WHERE org_id=$1 AND provider=$2', [orgId, 'google']))[0];
const alerts = async (subkind: string): Promise<any[]> =>
  q(`SELECT id, title, body, status FROM desk_items WHERE org_id=$1 AND subkind=$2 ORDER BY created_at`, [
    orgId,
    subkind,
  ]);

describe('the monthly cap', () => {
  it('counts only the organization key of that provider in the calendar month, and says how many runs had no price', async () => {
    await clearSpend();
    await addOrgSpend(2_000_000);
    await addOrgSpend(3_000_000, { provider: 'openai' }); // another provider
    await addOrgSpend(4_000_000, { source: 'workstation' }); // the owner's own key: not counted
    await addOrgSpend(5_000_000, { source: null }); // a login: no key
    await addOrgSpend(0, { unknown: true });
    await addOrgSpend(7_000_000, { at: new Date(ctx().clock.now().getTime() - 70 * 86_400_000) }); // an earlier month
    const st = await providerCapState(ctx().pool, orgId, 'google', ctx().clock.now());
    expect(st).toMatchObject({ spendMicros: 2_000_000, unknownCostTurns: 1, capMicros: null, state: 'none' });
  });

  it('is set by an Owner or Admin in whole dollars, and a member cannot', async () => {
    expect((await call(admin, 'PUT', '/api/org/providers/google/cap', { monthlyUsd: 10 })).status).toBe(200);
    expect(Number((await capRow())?.cap_micros)).toBe(10_000_000);
    expect((await call(member, 'PUT', '/api/org/providers/google/cap', { monthlyUsd: 1 })).status).toBe(403);
    const page = (await call(admin, 'GET', '/api/org/providers')).body.providers.find(
      (p: any) => p.provider === 'google',
    );
    expect(page.cap).toMatchObject({
      monthlyMicros: 10_000_000,
      spendMicros: 2_000_000,
      unknownCostTurns: 1,
      state: 'ok',
    });
  });

  it('warns once at 80% with a desk notice that names the unpriced runs, and pauses once at 100%', async () => {
    await clearSpend();
    await addOrgSpend(8_100_000);
    await addOrgSpend(0, { unknown: true });
    await evaluateProviderCap(ctx(), orgId, 'google');
    await evaluateProviderCap(ctx(), orgId, 'google');
    const warn = await alerts('provider_cap_warning');
    expect(warn).toHaveLength(1);
    expect(warn[0].title).toContain('81%');
    expect(warn[0].body).toContain('1 run this month had no known price');
    expect(await alerts('provider_cap_paused')).toHaveLength(0);
    await addOrgSpend(2_500_000);
    await evaluateAllProviderCaps(ctx());
    await evaluateAllProviderCaps(ctx());
    const paused = await alerts('provider_cap_paused');
    expect(paused).toHaveLength(1);
    expect(paused[0].title).toContain('reached its monthly cap');
    expect((await capRow())?.cap_paused_month).toMatch(/^\d{4}-\d{2}$/);
    expect(await alerts('provider_cap_warning')).toHaveLength(1);
  });

  it('stops new runs on the organization key at the cap (provider_cap_reached) and leaves the owner’s own key and other providers alone', async () => {
    const reports = GEMINI_RUNTIMES([orgId]) as never;
    const choice = { runtime: 'gemini', model: 'gemini-2.5-pro' };
    const now = ctx().clock.now();
    expect(await providerCapProblem(ctx().pool, orgId, reports, choice, now)).toMatch(
      /monthly cap of \$10\.00 \(spent \$10\.60\)/,
    );
    // the workstation's own key is in effect there: never capped
    expect(
      await providerCapProblem(
        ctx().pool,
        orgId,
        GEMINI_RUNTIMES([orgId], 'workstation') as never,
        choice,
        now,
      ),
    ).toBeNull();
    // the key in effect belongs to another organization: this organization's cap does not apply
    expect(
      await providerCapProblem(ctx().pool, orgId, GEMINI_RUNTIMES([randomUUID()]) as never, choice, now),
    ).toBeNull();
    // a Claude subscription model spends no key
    expect(
      await providerCapProblem(ctx().pool, orgId, reports, { runtime: 'claude-code', model: 'sonnet' }, now),
    ).toBeNull();
    // the Gemini CLI on its Google login spends no key
    const login = (GEMINI_RUNTIMES([orgId]) as any[]).map((x) =>
      x.id === 'gemini' ? { ...x, authVia: 'login' } : x,
    );
    expect(await providerCapProblem(ctx().pool, orgId, login as never, choice, now)).toBeNull();
  });

  it('keeps cards queued for an agent on the capped key, while an agent on a login still gets its work', async () => {
    await giveGoogleKey('org');
    const hire = await w.hire('Gem', 'builder', 'senior', { runtime: 'gemini', model: 'gemini-2.5-pro' });
    expect(hire.runtime).toBe('gemini');
    await q(`UPDATE cards SET status='cancelled' WHERE status NOT IN ('done','cancelled')`);
    await w.card({ title: 'capped card' });
    await ctx().services.dispatcher.run();
    const claimed = await q(`SELECT claimed_by_agent_id FROM cards WHERE title='capped card'`);
    expect(claimed[0]?.claimed_by_agent_id).toBeNull();
    // the owner's own key takes over: the same agent is dispatched
    await giveGoogleKey('workstation');
    await ctx().services.dispatcher.run();
    expect(
      (await q(`SELECT claimed_by_agent_id FROM cards WHERE title='capped card'`))[0]?.claimed_by_agent_id,
    ).toBe(hire.id);
    await q(
      `UPDATE cards SET status='cancelled', claim_id=NULL, claimed_by_agent_id=NULL, claim_shift_id=NULL WHERE title='capped card'`,
    );
    await q(`UPDATE shifts SET status='ended' WHERE status <> 'ended'`);
  });

  it('lifts the pause when the cap is raised or overridden for the month, and the override resolves the desk notice', async () => {
    const choice = { runtime: 'gemini', model: 'gemini-2.5-pro' };
    const reports = GEMINI_RUNTIMES([orgId]) as never;
    const now = () => ctx().clock.now();
    expect(await providerCapProblem(ctx().pool, orgId, reports, choice, now())).not.toBeNull();
    expect((await call(member, 'POST', '/api/org/providers/google/cap/override')).status).toBe(403);
    expect((await call(admin, 'POST', '/api/org/providers/google/cap/override')).status).toBe(200);
    expect(await providerCapProblem(ctx().pool, orgId, reports, choice, now())).toBeNull();
    expect((await alerts('provider_cap_paused'))[0]?.status).not.toBe('open');
    // a raised cap lifts it for good and re-arms the warning
    await q(`UPDATE org_providers SET cap_override_month=NULL WHERE org_id=$1 AND provider='google'`, [
      orgId,
    ]);
    expect(await providerCapProblem(ctx().pool, orgId, reports, choice, now())).not.toBeNull();
    expect((await call(admin, 'PUT', '/api/org/providers/google/cap', { monthlyUsd: 100 })).status).toBe(200);
    expect(await providerCapProblem(ctx().pool, orgId, reports, choice, now())).toBeNull();
    expect((await capRow())?.cap_paused_month).toBeNull();
    // a cap below what is spent already takes effect at once and notifies
    expect((await call(admin, 'PUT', '/api/org/providers/google/cap', { monthlyUsd: 5 })).status).toBe(200);
    expect(await providerCapProblem(ctx().pool, orgId, reports, choice, now())).not.toBeNull();
    expect((await alerts('provider_cap_paused')).length).toBeGreaterThanOrEqual(2);
    // no cap at all
    expect((await call(admin, 'PUT', '/api/org/providers/google/cap', { monthlyUsd: null })).status).toBe(
      200,
    );
    expect(await providerCapProblem(ctx().pool, orgId, reports, choice, now())).toBeNull();
  });

  it('starts again on the 1st of the next month', async () => {
    await call(admin, 'PUT', '/api/org/providers/google/cap', { monthlyUsd: 5 });
    const reports = GEMINI_RUNTIMES([orgId]) as never;
    const choice = { runtime: 'gemini', model: 'gemini-2.5-pro' };
    expect(await providerCapProblem(ctx().pool, orgId, reports, choice, ctx().clock.now())).not.toBeNull();
    const st = await providerCapState(ctx().pool, orgId, 'google', ctx().clock.now());
    const later = new Date(st.resetsAt.getTime() + 3600_000);
    expect(await providerCapProblem(ctx().pool, orgId, reports, choice, later)).toBeNull();
    expect((await providerCapState(ctx().pool, orgId, 'google', later)).spendMicros).toBe(0);
  });
});

describe('which key paid is recorded from the usage a runner reports', () => {
  it('writes key_source and key_provider from a shift’s usage, counts an unpriced model as unknown, and survives a projection rebuild', async () => {
    await clearSpend();
    await giveGoogleKey('org');
    await q(
      `UPDATE cards SET status='cancelled', claim_id=NULL, claimed_by_agent_id=NULL, claim_shift_id=NULL WHERE status NOT IN ('done','cancelled')`,
    );
    await q(`UPDATE shifts SET status='ended' WHERE status <> 'ended'`);
    await call(admin, 'PUT', '/api/org/providers/google/cap', { monthlyUsd: 1000 });
    const h = shiftHelpers(w);
    const run = async (usage: Record<string, unknown>) => {
      await w.card({ title: `paid ${randomUUID().slice(0, 4)}` });
      const from = r1.received.length;
      const start = await h.dispatchTo(r1, 'Gem', from);
      await h.startShift(r1, start);
      r1.ended(start.shiftId, 'stopped', { usage: { cacheReadTokens: 0, cacheWriteTokens: 0, ...usage } });
      await until(
        async () => (await q('SELECT 1 FROM shift_costs WHERE shift_id=$1', [start.shiftId]))[0],
        5000,
        'cost row',
      );
      return start.shiftId as string;
    };
    const priced = await run({
      inputTokens: 1_000_000,
      outputTokens: 0,
      model: 'gemini:gemini-2.5-pro',
      keySource: 'org',
      keyProvider: 'google',
    });
    const unpriced = await run({
      inputTokens: 1_000_000,
      outputTokens: 0,
      model: 'gemini:gemini-3.1-pro-preview',
      keySource: 'org',
      keyProvider: 'google',
    });
    const own = await run({
      inputTokens: 1_000_000,
      outputTokens: 0,
      model: 'gemini:gemini-2.5-pro',
      keySource: 'workstation',
      keyProvider: 'google',
    });
    const login = await run({ inputTokens: 1_000_000, outputTokens: 0, model: 'gemini:gemini-2.5-pro' });
    const row = async (id: string): Promise<any> =>
      (
        await q(
          'SELECT key_source, key_provider, cost_unknown, cost_usd_micros FROM shift_costs WHERE shift_id=$1',
          [id],
        )
      )[0];
    expect(await row(priced)).toMatchObject({
      key_source: 'org',
      key_provider: 'google',
      cost_unknown: false,
    });
    expect(Number((await row(priced)).cost_usd_micros)).toBe(1_250_000);
    expect(await row(unpriced)).toMatchObject({
      key_source: 'org',
      key_provider: 'google',
      cost_unknown: true,
    });
    expect(Number((await row(unpriced)).cost_usd_micros)).toBe(0);
    expect(await row(own)).toMatchObject({
      key_source: 'workstation',
      key_provider: 'google',
      cost_unknown: false,
    });
    expect(await row(login)).toMatchObject({ key_source: null, key_provider: null });
    const st = await providerCapState(ctx().pool, orgId, 'google', ctx().clock.now());
    expect(st).toMatchObject({ spendMicros: 1_250_000, unknownCostTurns: 1 });
    // the usage of a run that ended is also what the cap hook looks at
    expect(
      (await call(admin, 'GET', '/api/org/providers')).body.providers.find(
        (p: any) => p.provider === 'google',
      ).cap,
    ).toMatchObject({ spendMicros: 1_250_000, unknownCostTurns: 1 });
  });

  it('rebuilds to the same organization key facts, caps and attribution', async () => {
    const tables = ['org_providers', 'shift_costs'];
    const snap = async () => {
      const out: Record<string, unknown[]> = {};
      for (const t of tables) out[t] = await q(`SELECT * FROM ${t} ORDER BY 1, 2`);
      return JSON.stringify(out);
    };
    expect(PROJECTION_TABLES).toContain('org_providers');
    // rows the earlier tests wrote straight into the projection have no event behind them
    await q('DELETE FROM shift_costs WHERE shift_id NOT IN (SELECT id FROM shifts)');
    const before = await snap();
    expect(before).toContain('"key_source":"org"');
    expect(before).toContain('"cap_micros"');
    // the sealed copies are not a projection: a rebuild leaves them alone
    const shares = JSON.stringify(await q('SELECT * FROM org_provider_key_shares ORDER BY 1,2,3'));
    await rebuildProjections(ctx().pool, ctx().store);
    expect(await snap()).toBe(before);
    expect(JSON.stringify(await q('SELECT * FROM org_provider_key_shares ORDER BY 1,2,3'))).toBe(shares);
  });
});

describe('who may run what: the role check is the same for every harness runtime', () => {
  const hireWith = (roleKey: string, runtime: string, model: string, extra: Record<string, unknown> = {}) =>
    w.t.req('POST', '/api/agents', {
      cookie: w.owner.cookie,
      body: {
        name: `A${randomUUID().slice(0, 5)}`,
        roleKey,
        seniority: 'senior',
        workstationId: w.workstationId,
        runtime,
        model,
        ...extra,
      },
    });

  it('refuses a tester (browser), a writer (path-limited) and a shell-less analyst on Codex, but lets the shell-less roles onto Gemini and opencode', async () => {
    const roleKeys = BUILTIN_ROLES.map((x) => x.key);
    const tester = roleKeys.includes('tester') ? 'tester' : undefined;
    if (tester) {
      for (const [rt, model] of [
        ['codex', 'gpt-6.1-sol'],
        ['gemini', 'gemini-2.5-pro'],
        ['opencode', 'openai/gpt-5'],
      ] as const) {
        const res = await hireWith(tester, rt, model);
        expect(res.status, rt).toBe(400);
        expect(JSON.stringify(res.body)).toContain('runtime_not_for_role');
      }
    }
    const builder = await hireWith('builder', 'gemini', 'gemini-2.5-pro');
    expect(builder.status).toBe(201);
    const oc = await hireWith('builder', 'opencode', 'openai/gpt-5');
    expect(oc.status).toBe(201);
  });

  it('refuses a Bedrock, Vertex or gateway model for the roles that work with the owner’s own login, and lets a builder have one', async () => {
    const ok1 = await hireWith('builder', 'claude-code', 'bedrock:us.anthropic.claude-sonnet-4-6');
    expect(ok1.status).toBe(201);
    const id = ok1.body.id as string;
    // moving a builder is fine; moving the agent to a role-limited runtime is judged by the same rule
    const back = await w.t.req('PATCH', `/api/agents/${id}`, {
      cookie: w.owner.cookie,
      body: { model: 'gateway:gemini/gemini-2.5-pro' },
    });
    expect(back.status).toBe(200);
  });
});

describe('what a workstation can run', () => {
  it('says why a Gemini, opencode or backend choice cannot run on a workstation', async () => {
    const { runtimeProblem } = await import('../src/sessions/offer.ts');
    const rep = (over: object[]) =>
      [{ id: 'direct-model', available: true, keys: [], providers: [] }, ...over] as never;
    expect(runtimeProblem(rep([]), { runtime: 'gemini', model: 'gemini-2.5-pro' })).toMatch(
      /Gemini CLI is not installed/,
    );
    expect(
      runtimeProblem(rep([{ id: 'gemini', available: false, auth: 'expired' }]), {
        runtime: 'gemini',
        model: 'gemini-2.5-pro',
      }),
    ).toMatch(/not signed in/);
    expect(
      runtimeProblem(
        rep([
          { id: 'gemini', available: false, sandbox: 'unavailable', sandboxReason: 'socat not installed' },
        ]),
        { runtime: 'gemini', model: 'gemini-2.5-pro' },
      ),
    ).toContain('socat not installed');
    expect(
      runtimeProblem(rep([{ id: 'gemini', available: true, authVia: 'login' }]), {
        runtime: 'gemini',
        model: 'gemini-2.5-pro',
      }),
    ).toBeNull();
    // opencode needs a key of the model's provider for this organization
    const oc = [{ id: 'opencode', available: true }];
    expect(runtimeProblem(rep(oc), { runtime: 'opencode', model: 'openai/gpt-5' }, orgId)).toMatch(
      /OpenAI is not set up on this workstation for this organization/,
    );
    const withKey = [
      { id: 'direct-model', available: true, keys: [{ provider: 'openai', source: 'org', orgIds: [orgId] }] },
      ...oc,
    ] as never;
    expect(runtimeProblem(withKey, { runtime: 'opencode', model: 'openai/gpt-5' }, orgId)).toBeNull();
    expect(runtimeProblem(withKey, { runtime: 'opencode', model: 'openai/gpt-5' }, randomUUID())).toMatch(
      /not set up/,
    );
    // a Claude Code backend model needs the credential
    expect(
      runtimeProblem(
        [
          { id: 'claude-code', available: true },
          { id: 'direct-model', available: true, keys: [] },
        ] as never,
        { runtime: 'claude-code', model: 'bedrock:us.x' },
      ),
    ).toMatch(/Amazon Bedrock is not set up/);
    expect(
      runtimeProblem(
        [
          { id: 'claude-code', available: true, backends: [{ id: 'bedrock', label: 'B', models: [] }] },
          { id: 'direct-model', available: true, keys: [{ provider: 'bedrock', source: 'workstation' }] },
        ] as never,
        { runtime: 'claude-code', model: 'bedrock:us.x' },
        orgId,
      ),
    ).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ live stop at the cap (Q48)

describe('the cap stops running work at once', () => {
  const usage = (out: number, over: Record<string, unknown> = {}) => ({
    inputTokens: 0,
    outputTokens: out,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  });
  async function startShift(model = 'gemini-2.5-pro'): Promise<string> {
    const agent =
      (await q(`SELECT id FROM agents LIMIT 1`))[0]?.id ??
      (await w.hire('Cap', 'builder', 'junior')).agent?.id;
    const id = randomUUID();
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at)
       VALUES ($1,$2,$3,$4,'chat','running','gemini',$5, now())`,
      [id, orgId, agent, w.workstationId, model],
    );
    return id;
  }
  const report = (id: string, out: number, kind: 'shift' | 'chat' | 'delegate' = 'shift') =>
    import('../src/provider-keys/live-usage.ts').then((m) =>
      m.applyRunUsage(ctx(), { id: w.workstationId }, { kind, id, usage: usage(out) } as never),
    );
  const stops = (r: FakeRunner, id: string) =>
    r.received.filter((f: any) => f.type === 'shift.stop' && f.shiftId === id);

  it('stops a running shift on the organization key when the live usage crosses the cap, with a notice, once', async () => {
    await clearSpend();
    await q('DELETE FROM desk_items WHERE subkind IN ($1,$2)', [
      'provider_cap_paused',
      'provider_cap_warning',
    ]);
    await q(
      `UPDATE org_providers SET cap_paused_month=NULL, cap_warned_month=NULL, cap_override_month=NULL WHERE org_id=$1`,
      [orgId],
    );
    expect((await asOwner('PUT', '/api/org/providers/google/cap', { monthlyUsd: 10 })).status).toBe(200);
    await giveGoogleKey('org');
    const id = await startShift();
    // $5 of output so far: below the cap
    await report(id, 500_000);
    expect(stops(r1, id)).toHaveLength(0);
    // booked spend plus what is in flight crosses it
    await addOrgSpend(3_000_000);
    await report(id, 800_000);
    await until(async () => stops(r1, id).length > 0);
    expect((await alerts('provider_cap_paused')).length).toBe(1);
    // the same report again changes nothing: one stop, one notice
    await report(id, 900_000);
    await evaluateProviderCap(ctx(), orgId, 'google');
    expect(stops(r1, id)).toHaveLength(1);
    expect((await alerts('provider_cap_paused')).length).toBe(1);
    // new runs are refused although the stopped run's cost is not booked yet
    expect(
      await providerCapProblem(
        ctx().pool,
        orgId,
        GEMINI_RUNTIMES([orgId]) as never,
        { runtime: 'gemini', model: 'gemini-2.5-pro' },
        ctx().clock.now(),
      ),
    ).toMatch(/monthly cap/);
    // an override lets runs through again
    expect((await asOwner('POST', '/api/org/providers/google/cap/override')).status).toBe(200);
    const again = await startShift();
    await report(again, 5_000_000);
    expect(stops(r1, again)).toHaveLength(0);
  });

  it('does not stop a run on the workstation’s own key, and does not count a model with no price', async () => {
    await clearSpend();
    await q(
      `UPDATE org_providers SET cap_paused_month=NULL, cap_warned_month=NULL, cap_override_month=NULL WHERE org_id=$1`,
      [orgId],
    );
    await giveGoogleKey('workstation');
    const own = await startShift();
    await report(own, 9_000_000);
    expect(stops(r1, own)).toHaveLength(0);
    await giveGoogleKey('org');
    const unpriced = await startShift('gemini-nonexistent-9');
    await report(unpriced, 9_000_000);
    expect(stops(r1, unpriced)).toHaveLength(0);
    const { liveSpendMicros } = await import('../src/provider-keys/live-usage.ts');
    expect(liveSpendMicros(ctx(), orgId, 'google')).toBe(0);
  });

  it('counts a model with an Owner-set price live, and stops at the cap on it (R3c)', async () => {
    await clearSpend();
    await q(
      `UPDATE org_providers SET cap_paused_month=NULL, cap_warned_month=NULL, cap_override_month=NULL WHERE org_id=$1`,
      [orgId],
    );
    await giveGoogleKey('org');
    const { liveSpendMicros } = await import('../src/provider-keys/live-usage.ts');
    // the tables do not know this model: it is "cost unknown" and counts nothing until the Owner prices it
    const id = await startShift('gemini-owner-priced-1');
    await report(id, 2_000_000);
    expect(liveSpendMicros(ctx(), orgId, 'google')).toBe(0);
    await asOwner('PUT', '/api/org/model-prices', {
      provider: 'google',
      model: 'gemini-owner-priced-1',
      inputPerMtok: 1,
      outputPerMtok: 10,
      cacheReadPerMtok: null,
    });
    expect((await asOwner('PUT', '/api/org/providers/google/cap', { monthlyUsd: 50 })).status).toBe(200);
    // 3M output tokens at $10 per million: $30 so far, below the cap
    await report(id, 3_000_000);
    expect(liveSpendMicros(ctx(), orgId, 'google')).toBe(30_000_000);
    expect(stops(r1, id)).toHaveLength(0);
    // $60 in flight crosses the $50 cap: the run is stopped
    await report(id, 6_000_000);
    await until(async () => stops(r1, id).length > 0);
    await q(`UPDATE org_providers SET cap_paused_month=NULL WHERE org_id=$1`, [orgId]);
    await asOwner('DELETE', '/api/org/model-prices?provider=google&model=gemini-owner-priced-1');
  });

  it('cancels a running session turn on the organization key and tells the session', async () => {
    await clearSpend();
    await q(
      `UPDATE org_providers SET cap_paused_month=NULL, cap_warned_month=NULL, cap_override_month=NULL WHERE org_id=$1`,
      [orgId],
    );
    await giveGoogleKey('org');
    const thread = randomUUID();
    const turn = randomUUID();
    await q(
      `INSERT INTO threads (id, org_id, kind, title, created_by, created_at, workstation_id, session_config)
       VALUES ($1,$2,'discovery','Capped',$3,now(),$4,'{}')`,
      [thread, orgId, w.owner.id, w.workstationId],
    );
    await q(
      `INSERT INTO session_turns (id, org_id, thread_id, speaker_kind, speaker_name, message, context, model, workstation_id, status, queued_at, requested_by)
       VALUES ($1,$2,$3,'persona','Analyst','go','{}',$4,$5,'running',now(),$6)`,
      [
        turn,
        orgId,
        thread,
        JSON.stringify({ runtime: 'gemini', model: 'gemini-2.5-pro' }),
        w.workstationId,
        w.owner.id,
      ],
    );
    await report(turn, 12_000_000, 'chat');
    await until(async () => r1.received.some((f: any) => f.type === 'chat.cancel' && f.chatId === turn));
    const msgs = await q(`SELECT body FROM thread_messages WHERE thread_id=$1`, [thread]);
    expect(msgs.map((m: any) => m.body).join(' ')).toMatch(/reached its monthly cap while this was running/);
    await q(`UPDATE org_providers SET cap_paused_month=NULL WHERE org_id=$1`, [orgId]);
  });

  it('stops a delegate (a child run) on the organization key of its own model, by its id', async () => {
    await clearSpend();
    await q(
      `UPDATE org_providers SET cap_paused_month=NULL, cap_warned_month=NULL, cap_override_month=NULL WHERE org_id=$1`,
      [orgId],
    );
    expect((await asOwner('PUT', '/api/org/providers/google/cap', { monthlyUsd: 10 })).status).toBe(200);
    await giveGoogleKey('org');
    // the parent runs on a Claude subscription; the child (granted by name) runs on Gemini with the organization key
    const parent = await startShift('sonnet');
    const child = randomUUID();
    await q(
      `INSERT INTO delegate_begins (delegate_id, caller_id, org_id, begun_at, workstation_id, target, target_kind, runtime, model)
       VALUES ($1,$2,$3,now(),$4,'gem','persona','gemini','gemini-2.5-pro')`,
      [child, parent, orgId, w.workstationId],
    );
    await report(child, 20_000_000, 'delegate');
    await until(async () => r1.received.some((f: any) => f.type === 'chat.cancel' && f.chatId === child));
    // the child is stopped once
    await report(child, 21_000_000, 'delegate');
    expect(r1.received.filter((f: any) => f.type === 'chat.cancel' && f.chatId === child)).toHaveLength(1);
    await q('DELETE FROM delegate_begins WHERE delegate_id=$1', [child]);
    await q(`UPDATE org_providers SET cap_paused_month=NULL WHERE org_id=$1`, [orgId]);
  });

  it('forgets a run when it ends (its cost is booked then), and a report for a run that is not running counts nothing', async () => {
    await clearSpend();
    const { liveSpendMicros, dropLiveUsage } = await import('../src/provider-keys/live-usage.ts');
    const id = await startShift();
    await report(id, 100_000);
    expect(liveSpendMicros(ctx(), orgId, 'google')).toBeGreaterThan(0);
    dropLiveUsage(ctx(), id);
    expect(liveSpendMicros(ctx(), orgId, 'google')).toBe(0);
    await q(`UPDATE shifts SET status='ended' WHERE id=$1`, [id]);
    await report(id, 100_000);
    expect(liveSpendMicros(ctx(), orgId, 'google')).toBe(0);
  });
});
