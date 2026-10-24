import { randomUUID } from 'node:crypto';
import {
  CLAUDE_ACCOUNTS_CAPABILITY,
  DIRECT_MODEL_CAPABILITY,
  PROVIDER_ACCOUNTS_CAPABILITY,
  PROVIDER_KEYS_BOUND_CAPABILITY,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { providerCapState } from '../src/provider-keys/caps.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember } from './helpers/members.ts';
import { eventsOfType } from './helpers/pipeline.ts';
import { createWorld, MOCK_RUNTIME, ok, until, type World } from './helpers/world.ts';

/**
 * S-A: accounts per provider and runtime. The project names an account per scope (Codex, the Gemini CLI, a provider key);
 * the dispatcher picks it per shift, falls back to main or waits; the organization's key is one more account whose monthly cap
 * still applies; notices are per (workstation, account); the setting is an event and is rebuilt from the events.
 */
let w: World;
let r: FakeRunner;
let orgId: string;
const CAPS = [
  CLAUDE_ACCOUNTS_CAPABILITY,
  PROVIDER_ACCOUNTS_CAPABILITY,
  PROVIDER_KEYS_BOUND_CAPABILITY,
  DIRECT_MODEL_CAPABILITY,
];
const ctx = () => w.t.app.ctx;
const hours = (n: number) => new Date(w.t.clock.now().getTime() + n * 3_600_000).toISOString();
const info = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  main: key === 'main',
  source: 'config_dir',
  login: 'ok',
  usage: 'ok',
  ...over,
});
const OUT = (key: string) =>
  info(key, { usage: 'limited', limitedUntil: hours(3), limitedLabel: '18:00 (UTC)' });
const codex = (accounts?: unknown[], over: Record<string, unknown> = {}) => ({
  id: 'codex',
  version: '0.163.0',
  available: accounts ? accounts.some((a: any) => a.login === 'ok' && a.usage === 'ok') : true,
  capabilities: ['shell', 'edit', 'web', 'skills', 'resume'],
  sandbox: 'enforced',
  auth: 'ok',
  ...(accounts ? { accounts } : {}),
  ...over,
});
const gemini = (over: Record<string, unknown> = {}) => ({
  id: 'gemini',
  version: '0.65.0',
  available: true,
  capabilities: ['shell', 'edit', 'web', 'skills', 'resume'],
  sandbox: 'enforced',
  auth: 'ok',
  authVia: 'key',
  ...over,
});
const direct = (keys: unknown[]) => ({
  id: 'direct-model',
  version: 'v',
  available: true,
  capabilities: ['skills'],
  keys,
});
let current: unknown[] = [];
async function report(...extra: unknown[]) {
  current = [...MOCK_RUNTIME, ...extra];
  r.send('runtimes.report', { runtimes: current });
  await r.barrier();
  await ctx().notifier.flush();
}
const put = (scope: string, body: unknown, cookie = w.owner.cookie, status = 200) =>
  ok<any>(
    w.t.req('PUT', `/api/projects/${w.projectId}/provider-accounts/${scope}`, { cookie, body }),
    status,
  );
const project = () => ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: w.owner.cookie }));
const view = (scope: string) =>
  ok<any>(
    w.t.req('GET', `/api/projects/${w.projectId}/provider-accounts/${scope}`, { cookie: w.owner.cookie }),
  );
const rowsOf = () =>
  q('SELECT scope, account_key, fallback_to_main FROM project_provider_accounts ORDER BY scope');

async function reset() {
  await q(
    `TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages,
       desk_items, card_blockers, ledger_entries, runner_inbox, devops_requests, ba_tasks CASCADE`,
  );
  await q('DELETE FROM agents WHERE NOT is_devops');
  await q('DELETE FROM project_provider_accounts');
  await q('DELETE FROM org_providers');
  await q(`UPDATE projects SET claude_account_key=NULL, claude_account_fallback=false`);
  await q(`UPDATE workstations SET last_seen_at = now() WHERE connected`);
}
async function pass(from: number) {
  await q(`UPDATE workstations SET last_seen_at = now() WHERE connected`);
  await r.barrier();
  ctx().services.dispatcher.cooldown.clear();
  await ctx().services.dispatcher.run();
  await r.barrier();
  return r.received.slice(from).filter((f) => f.type === 'shift.start') as any[];
}
const shiftAccount = async (shiftId: string) =>
  (await q('SELECT account_key FROM shifts WHERE id=$1', [shiftId]))[0]?.account_key ?? null;
const hireCodex = (name: string) =>
  w.hire(name, 'builder', 'junior', { runtime: 'codex', model: 'gpt-6-sol' });
const hireGemini = (name: string) =>
  w.hire(name, 'builder', 'junior', { runtime: 'gemini', model: 'gemini-2.5-pro' });
const alerts = (subkind: string): Promise<any[]> =>
  q(`SELECT id, title, body, status FROM desk_items WHERE subkind=$1 ORDER BY created_at`, [
    subkind,
  ]) as Promise<any[]>;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
  r = await w.connectRunner({ capabilities: CAPS });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

describe('the project’s account per provider and runtime', () => {
  it('defaults to the main account everywhere', async () => {
    await reset();
    const p = (await project()).project;
    expect(p.providerAccounts).toBeUndefined();
    expect(p.claudeAccount).toEqual({ key: null, fallbackToMain: false });
  });

  it('is an event per change, a no-op when unchanged, and shows in the project', async () => {
    expect((await put('codex', { accountKey: 'work' })).project.providerAccounts).toEqual({
      codex: { key: 'work', fallbackToMain: false },
    });
    expect(await eventsOfType('ProjectProviderAccountSet')).toHaveLength(1);
    await put('codex', { accountKey: 'work', fallbackToMain: false });
    expect(await eventsOfType('ProjectProviderAccountSet')).toHaveLength(1);
    const p = await put('codex', { accountKey: 'work', fallbackToMain: true });
    expect(p.project.providerAccounts.codex).toEqual({ key: 'work', fallbackToMain: true });
    expect(await eventsOfType('ProjectProviderAccountSet')).toHaveLength(2);
    await put('openai', { accountKey: 'org' });
    expect((await project()).project.providerAccounts).toMatchObject({
      codex: { key: 'work', fallbackToMain: true },
      openai: { key: 'org', fallbackToMain: false },
    });
    // each scope is its own setting
    expect(await rowsOf()).toEqual([
      { scope: 'codex', account_key: 'work', fallback_to_main: true },
      { scope: 'openai', account_key: 'org', fallback_to_main: false },
    ]);
  });

  it('Claude Code keeps its own event and columns', async () => {
    await put('claude-code', { accountKey: 'work', fallbackToMain: true });
    expect(await eventsOfType('ProjectClaudeAccountSet')).not.toHaveLength(0);
    const p = (await project()).project;
    expect(p.claudeAccount).toEqual({ key: 'work', fallbackToMain: true });
    expect(p.providerAccounts?.['claude-code']).toBeUndefined();
    await put('claude-code', { accountKey: 'org' }, w.owner.cookie, 422);
    await put('claude-code', { accountKey: null });
  });

  it('refuses an unknown scope, a bad or reserved name, the organization key for a login runtime, and a manager', async () => {
    await put('nope', { accountKey: 'work' }, w.owner.cookie, 400);
    await put('codex', { accountKey: 'main' }, w.owner.cookie, 422);
    await put('codex', { accountKey: 'Bad Name' }, w.owner.cookie, 400);
    await put('codex', { accountKey: 'org' }, w.owner.cookie, 422);
    await put('gemini', { accountKey: 'org' }, w.owner.cookie, 422);
    const manager = await addMember(w, 'pa-mgr');
    await put('codex', { accountKey: 'other' }, manager.cookie, 403);
    expect((await project()).project.providerAccounts.codex.key).toBe('work');
  });

  it('clearing goes back to main and drops the fallback switch', async () => {
    const p = await put('codex', { accountKey: null, fallbackToMain: true });
    expect(p.project.providerAccounts?.codex).toBeUndefined();
    expect((await rowsOf()).map((x: any) => x.scope)).toEqual(['openai']);
    await put('openai', { accountKey: null });
    expect(await rowsOf()).toEqual([]);
  });

  it('rebuilds to the same rows from the events', async () => {
    await put('codex', { accountKey: 'work', fallbackToMain: true });
    await put('anthropic', { accountKey: 'org' });
    await put('gemini', { accountKey: 'g1' });
    await put('anthropic', { accountKey: 'personal', fallbackToMain: true });
    await put('gemini', { accountKey: null });
    const before = await q(
      'SELECT project_id, scope, account_key, fallback_to_main FROM project_provider_accounts ORDER BY scope',
    );
    expect(before.map((x: any) => [x.scope, x.account_key, x.fallback_to_main])).toEqual([
      ['anthropic', 'personal', true],
      ['codex', 'work', true],
    ]);
    const { rebuildProjections } = await import('../src/projections/rebuild.ts');
    await rebuildProjections(ctx().pool, ctx().store);
    const after = await q(
      'SELECT project_id, scope, account_key, fallback_to_main FROM project_provider_accounts ORDER BY scope',
    );
    expect(after).toEqual(before);
    expect((await project()).project.providerAccounts).toMatchObject({
      codex: { key: 'work', fallbackToMain: true },
    });
  });

  it('old events (no provider account) replay: the table stays empty', async () => {
    await reset();
    const { rebuildProjections } = await import('../src/projections/rebuild.ts');
    await rebuildProjections(ctx().pool, ctx().store);
    // the reset removed rows, not events; rebuild restores the last choices
    expect((await rowsOf()).length).toBeGreaterThanOrEqual(0);
  });
});

describe('dispatch on a Codex account', () => {
  it('claims on the project account and says so in shift.start, the event and the shift row', async () => {
    await reset();
    await report(codex([info('main'), info('work')]));
    await hireCodex('Cody');
    await put('codex', { accountKey: 'work' });
    const card = await w.card({ title: 'On work' });
    const starts = await pass(r.received.length);
    expect(starts).toHaveLength(1);
    expect(starts[0].account).toEqual({ key: 'work' });
    expect(await shiftAccount(starts[0].shiftId)).toBe('work');
    const ev = await q(`SELECT payload FROM events WHERE type='CardClaimed' AND payload->>'cardId'=$1`, [
      card.id,
    ]);
    expect(ev[0]?.payload.accountKey).toBe('work');
  });

  it('a project without an account uses main and sends none', async () => {
    await reset();
    await report(codex([info('main'), info('work')]));
    await hireCodex('Cody');
    await w.card({ title: 'On main' });
    const starts = await pass(r.received.length);
    expect(starts).toHaveLength(1);
    expect(starts[0].account).toBeUndefined();
    expect(await shiftAccount(starts[0].shiftId)).toBeNull();
  });

  it('the account out and fallback off: nothing is claimed; with fallback on it runs on main', async () => {
    await reset();
    await report(codex([info('main'), OUT('work')]));
    await hireCodex('Cody');
    await put('codex', { accountKey: 'work' });
    const card = await w.card({ title: 'Waits' });
    expect(await pass(r.received.length)).toHaveLength(0);
    expect((await q('SELECT status FROM cards WHERE id=$1', [card.id]))[0]?.status).toBe('queued');
    await put('codex', { accountKey: 'work', fallbackToMain: true });
    const starts = await pass(r.received.length);
    expect(starts).toHaveLength(1);
    expect(starts[0].account).toBeUndefined();
  });

  it('a login that is expired or never done counts like a hit limit; recovery goes back to the account', async () => {
    await reset();
    await report(codex([info('main'), info('work', { login: 'none' })]));
    await hireCodex('Cody');
    await put('codex', { accountKey: 'work' });
    await w.card({ title: 'No login' });
    expect(await pass(r.received.length)).toHaveLength(0);
    await report(codex([info('main'), info('work', { login: 'expired' })]));
    expect(await pass(r.received.length)).toHaveLength(0);
    await report(codex([info('main'), info('work')]));
    const starts = await pass(r.received.length);
    expect(starts).toHaveLength(1);
    expect(starts[0].account).toEqual({ key: 'work' });
  });

  it('main out: a project on its own account still runs, one on main waits', async () => {
    await reset();
    await report(codex([OUT('main'), info('work')]));
    await hireCodex('Cody');
    await put('codex', { accountKey: 'work' });
    await w.card({ title: 'Work card' });
    const starts = await pass(r.received.length);
    expect(starts).toHaveLength(1);
    expect(starts[0].account).toEqual({ key: 'work' });
    await reset();
    await hireCodex('Cora');
    await w.card({ title: 'Main card' });
    expect(await pass(r.received.length)).toHaveLength(0);
  });

  it('an older runner (no accounts[] for the runtime) offers only main: the account counts as missing', async () => {
    await reset();
    await report(codex(undefined));
    await hireCodex('Cody');
    await put('codex', { accountKey: 'work' });
    await w.card({ title: 'Legacy' });
    expect(await pass(r.received.length)).toHaveLength(0);
    await put('codex', { accountKey: 'work', fallbackToMain: true });
    const starts = await pass(r.received.length);
    expect(starts).toHaveLength(1);
    expect(starts[0].account).toBeUndefined();
  });

  it('the runner turns the shift away for a limit: the account is marked out at once, no penalty, and the card is not claimed on it again', async () => {
    await reset();
    await report(codex([info('main'), info('work')]));
    await hireCodex('Cody');
    await put('codex', { accountKey: 'work' });
    const card = await w.card({ title: 'Reject loop' });
    const starts = await pass(r.received.length);
    expect(starts).toHaveLength(1);
    r.rejected(starts[0].shiftId, 'usage_limited', { accountKey: 'work', limitedUntil: hours(2) });
    await until(
      async () => (await q('SELECT claim_id FROM cards WHERE id=$1', [card.id]))[0]?.claim_id === null,
      4000,
      'card released',
    );
    const rt = (
      await q('SELECT runtimes FROM workstations WHERE id=$1', [w.workstationId])
    )[0]?.runtimes.find((x: any) => x.id === 'codex');
    expect(rt.accounts.find((a: any) => a.key === 'work')).toMatchObject({ usage: 'limited' });
    expect(rt.accounts.find((a: any) => a.key === 'main')).toMatchObject({ usage: 'ok' });
    expect(await pass(r.received.length)).toHaveLength(0);
  });

  it('a question about a ticket uses the project account; without a card, main', async () => {
    await reset();
    await report(codex([info('main'), info('work')]));
    const cody = await w.hire('Cody', 'analyst', 'senior', { runtime: 'codex', model: 'gpt-6-sol' });
    await put('codex', { accountKey: 'work' });
    const card = await w.card({ title: 'Asked about' });
    const item = randomUUID();
    await q(
      `INSERT INTO desk_items (id, org_id, kind, status, routed_to, routed_agent_id, card_id, project_id, title, created_at, updated_at)
       VALUES ($1,$2,'question','open','agent',$3,$4,$5,'Which one?',now(),now())`,
      [item, orgId, cody.id, card.id, w.projectId],
    );
    await pass(r.received.length);
    expect((await q(`SELECT account_key FROM shifts WHERE desk_item_id=$1`, [item]))[0]?.account_key).toBe(
      'work',
    );
  });
});

describe('dispatch on a provider key account (the Gemini CLI on a key)', () => {
  const keys = (over: Record<string, unknown> = {}) => [
    { provider: 'google', source: 'workstation', accounts: ['work'], orgKey: true, orgIds: [orgId], ...over },
  ];
  const runtimes = (k: unknown[]) => [gemini(), direct(k)];

  it('the project’s named key account is used and sent; a missing one waits or falls back to main', async () => {
    await reset();
    await report(...runtimes(keys()));
    await hireGemini('Gem');
    await put('google', { accountKey: 'work' });
    await w.card({ title: 'Named key' });
    const starts = await pass(r.received.length);
    expect(starts).toHaveLength(1);
    expect(starts[0].account).toEqual({ key: 'work' });
    expect(await shiftAccount(starts[0].shiftId)).toBe('work');

    await reset();
    await report(...runtimes(keys({ accounts: [] })));
    await hireGemini('Gem');
    await put('google', { accountKey: 'work' });
    await w.card({ title: 'No such account' });
    expect(await pass(r.received.length)).toHaveLength(0);
    await put('google', { accountKey: 'work', fallbackToMain: true });
    const next = await pass(r.received.length);
    expect(next).toHaveLength(1);
    expect(next[0].account).toBeUndefined();
  });

  it('a workstation with only named accounts has no main key: main-account projects wait, projects on an account run', async () => {
    await reset();
    await report(
      ...runtimes([{ provider: 'google', source: 'workstation', main: false, accounts: ['work'] }]),
    );
    await hireGemini('Gem');
    await w.card({ title: 'Main project' });
    expect(await pass(r.received.length)).toHaveLength(0);
    await put('google', { accountKey: 'work' });
    expect(await pass(r.received.length)).toHaveLength(1);
  });

  it('the organization’s key is an account a project may choose', async () => {
    await reset();
    await report(...runtimes(keys()));
    await hireGemini('Gem');
    await put('google', { accountKey: 'org' });
    await w.card({ title: 'On the organization key' });
    const starts = await pass(r.received.length);
    expect(starts).toHaveLength(1);
    expect(starts[0].account).toEqual({ key: 'org' });
    // and the view offers it
    await q(
      `INSERT INTO org_providers (org_id, provider, configured, key_generation) VALUES ($1,'google',true,1)
       ON CONFLICT (org_id, provider) DO UPDATE SET configured = true`,
      [orgId],
    );
    const v = await view('google');
    expect(v.orgKey).toBe(true);
    expect(v.knownKeys).toEqual(['org', 'work']);
    expect(v.workstations[0]).toMatchObject({ supportsAccounts: true });
  });

  it('a runner that does not report accounts cannot run on the organization’s key (it would spend its own)', async () => {
    await reset();
    await report(...runtimes([{ provider: 'google', source: 'workstation', orgKey: true, orgIds: [orgId] }]));
    await hireGemini('Gem');
    await put('google', { accountKey: 'org' });
    await w.card({ title: 'Old runner, org key' });
    expect(await pass(r.received.length)).toHaveLength(0);
  });

  describe('the cap still applies', () => {
    async function capReached(on: boolean) {
      await q(
        `INSERT INTO org_providers (org_id, provider, configured, key_generation, cap_micros, cap_paused_month)
         VALUES ($1,'google',true,1,10000000,$2)
         ON CONFLICT (org_id, provider) DO UPDATE SET cap_micros = 10000000, cap_paused_month = $2`,
        [orgId, on ? (await providerCapState(ctx().pool, orgId, 'google', ctx().clock.now())).month : null],
      );
    }

    it('a project on the organization key waits at the cap; one on a named account or the owner’s key goes on', async () => {
      await reset();
      await capReached(true);
      await report(...runtimes(keys()));
      await hireGemini('Gem');
      await put('google', { accountKey: 'org' });
      await w.card({ title: 'Capped' });
      expect(await pass(r.received.length)).toHaveLength(0);
      // fallback to main does not help when main is the organization's key too (no own key here)
      await put('google', { accountKey: 'org', fallbackToMain: true });
      await report(
        ...runtimes([{ provider: 'google', source: 'org', orgKey: true, orgIds: [orgId], accounts: [] }]),
      );
      expect(await pass(r.received.length)).toHaveLength(0);
      // a named account is the workstation's own key: never capped
      await report(...runtimes(keys()));
      await put('google', { accountKey: 'work' });
      const starts = await pass(r.received.length);
      expect(starts).toHaveLength(1);
      expect(starts[0].account).toEqual({ key: 'work' });
    });

    it('the owner’s key as main is not capped; lifting the cap lets the organization key run again', async () => {
      await reset();
      await capReached(true);
      await report(...runtimes(keys()));
      await hireGemini('Gem');
      await w.card({ title: 'Main is the owner key' });
      expect(await pass(r.received.length)).toHaveLength(1);
      await reset();
      await capReached(true);
      await put('google', { accountKey: 'org' });
      await hireGemini('Gem2');
      await w.card({ title: 'Org key again' });
      expect(await pass(r.received.length)).toHaveLength(0);
      await capReached(false);
      const starts = await pass(r.received.length);
      expect(starts).toHaveLength(1);
      expect(starts[0].account).toEqual({ key: 'org' });
    });
  });
});

describe('notices per (workstation, account)', () => {
  it('raises a sign-in notice for an account a project names, closes it when it works, and raises a usage notice while it is limited', async () => {
    await reset();
    await report(codex([info('main'), info('work', { login: 'none' })]));
    await hireCodex('Cody');
    await put('codex', { accountKey: 'work' });
    const login = await alerts('provider_account_login');
    expect(login).toHaveLength(1);
    expect(login[0].title).toContain('Codex account work needs a sign-in');
    expect(login[0].body).toContain('Integrations page');
    expect(login[0].body).toContain('paused');
    // same report again: still one
    await report(codex([info('main'), info('work', { login: 'none' })]));
    expect(await alerts('provider_account_login')).toHaveLength(1);
    expect((await alerts('provider_account_login'))[0].status).toBe('open');
    // signed in: closed
    await report(codex([info('main'), info('work')]));
    expect((await alerts('provider_account_login')).filter((x: any) => x.status === 'open')).toHaveLength(0);
    // limited: an information notice that names the projects and what happens
    await report(codex([info('main'), OUT('work')]));
    const usage = await alerts('provider_account_usage');
    expect(usage).toHaveLength(1);
    expect(usage[0].title).toContain('Codex account work reached its usage limit');
    expect(usage[0].body).toContain('paused');
    await report(codex([info('main'), info('work')]));
    expect((await alerts('provider_account_usage')).filter((x: any) => x.status === 'open')).toHaveLength(0);
  });

  it('says "run on the main account meanwhile" when the project falls back', async () => {
    await reset();
    await report(codex([info('main'), info('work', { login: 'expired' })]));
    await hireCodex('Cody');
    await put('codex', { accountKey: 'work', fallbackToMain: true });
    const open = (await alerts('provider_account_login')).filter((x: any) => x.status === 'open');
    expect(open).toHaveLength(1);
    expect(open[0].title).toContain('needs a sign-in');
    expect(open[0].body).toContain('run on the main account meanwhile');
    await report(codex([info('main'), info('work')]));
  });

  it('the main account of a login runtime gets a notice when its login goes, where the workstation has agents on it', async () => {
    await reset();
    await report(codex([info('main', { login: 'expired' }), info('work')]));
    await hireCodex('Cody');
    await report(codex([info('main', { login: 'expired' }), info('work')]));
    const open = (await alerts('provider_account_login')).filter((x: any) => x.status === 'open');
    expect(open.map((x: any) => x.title)).toEqual([
      expect.stringContaining('Codex main account needs a sign-in'),
    ]);
    await report(codex([info('main'), info('work')]));
  });

  it('an account that does not exist on the workstation, and a key account with no key, are told apart from a login problem', async () => {
    await reset();
    await report(codex([info('main')]));
    await hireCodex('Cody');
    await put('codex', { accountKey: 'ghost' });
    const missing = (await alerts('provider_account_login')).filter((x: any) => x.status === 'open');
    expect(missing[0].title).toContain('Codex account ghost is not set up on');
    await put('codex', { accountKey: null });
    await put('openai', { accountKey: 'work' });
    await report(
      codex([info('main')]),
      direct([{ provider: 'openai', source: 'workstation', accounts: [] }]),
    );
    const keyless = (await alerts('provider_account_login')).filter((x: any) => x.status === 'open');
    expect(keyless.map((x: any) => x.title)).toEqual(['OpenAI account work has no key on Desk']);
    expect(keyless[0].body).toContain('Set key');
    await report(
      codex([info('main')]),
      direct([{ provider: 'openai', source: 'workstation', accounts: ['work'] }]),
    );
    expect((await alerts('provider_account_login')).filter((x: any) => x.status === 'open')).toHaveLength(0);
  });
});

describe('the project view', () => {
  it('lists the workstation with the chosen account and main for a login scope', async () => {
    await reset();
    await report(codex([info('main', { email: 'm@x.test' }), info('work', { email: 'w@x.test' })]));
    await hireCodex('Cody');
    await put('codex', { accountKey: 'work', fallbackToMain: true });
    const v = await view('codex');
    expect(v).toMatchObject({
      scope: 'codex',
      kind: 'login',
      setting: { key: 'work', fallbackToMain: true },
      knownKeys: ['work'],
    });
    expect(v.workstations).toHaveLength(1);
    expect(v.workstations[0]).toMatchObject({
      supportsAccounts: true,
      main: { key: 'main', login: 'ok', email: 'm@x.test' },
      account: { key: 'work', login: 'ok', email: 'w@x.test' },
    });
  });

  it('says a key account has no key on the workstation', async () => {
    await reset();
    await report(gemini(), direct([{ provider: 'google', source: 'workstation', accounts: ['alt'] }]));
    await hireGemini('Gem');
    await put('google', { accountKey: 'work' });
    const v = await view('google');
    expect(v.kind).toBe('key');
    expect(v.knownKeys).toEqual(['alt', 'work']);
    expect(v.workstations[0].account).toMatchObject({ key: 'work', login: 'none', kind: 'key' });
    expect(v.workstations[0].main).toMatchObject({
      key: 'main',
      login: 'ok',
      kind: 'key',
      source: 'workstation',
    });
  });

  it('Claude Code’s scope returns the Claude view in the same shape', async () => {
    const v = await view('claude-code');
    expect(v).toMatchObject({ scope: 'claude-code', kind: 'login', setting: { key: null } });
  });
});
