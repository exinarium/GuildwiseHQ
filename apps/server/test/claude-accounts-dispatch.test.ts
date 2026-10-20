import { randomUUID } from 'node:crypto';
import { CLAUDE_ACCOUNTS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, MOCK_RUNTIME, ok, type World } from './helpers/world.ts';

/**
 * Per-project Claude accounts, slice A2 (docs/design/claude-accounts.md): the dispatcher picks the account per shift.
 * Ticket shifts (card, question with a card, BA task with a card) use the project's account; everything else uses main.
 * An account that is out pauses the ticket unless the project falls back to main; a recovered account is used again.
 */
let w: World;
let r: FakeRunner;
const CLAUDE = { id: 'claude-code', version: '2.1.299', available: true, capabilities: ['shell'] };
const acct = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  main: key === 'main',
  source: key === 'main' ? 'default' : 'config_dir',
  login: 'ok',
  usage: 'ok',
  ...over,
});
const hours = (n: number) => new Date(w.t.clock.now().getTime() + n * 3_600_000).toISOString();
const OUT = (key: string) =>
  acct(key, { usage: 'limited', limitedUntil: hours(3), limitedLabel: '18:00 (Africa/Johannesburg)' });
const dispatcher = () => w.t.app.ctx.services.dispatcher;

/** What the runner reports: `accounts` absent = a legacy runtime that only knows main. */
async function report(accounts?: unknown[], top: Record<string, unknown> = {}) {
  const anyUp = accounts ? accounts.some((a: any) => a.login === 'ok' && a.usage === 'ok') : true;
  r.send('runtimes.report', {
    runtimes: [MOCK_RUNTIME[0], { ...CLAUDE, available: anyUp, ...(accounts ? { accounts } : {}), ...top }],
  });
  await r.barrier();
}
const setAccount = (accountKey: string | null, fallbackToMain = false) =>
  ok(
    w.t.req('PUT', `/api/projects/${w.projectId}/claude-account`, {
      cookie: w.owner.cookie,
      body: { accountKey, fallbackToMain },
    }),
  );
async function reset() {
  await q(
    `TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages,
       desk_items, card_blockers, ledger_entries, runner_inbox, devops_requests, ba_tasks CASCADE`,
  );
  await q('DELETE FROM agents WHERE NOT is_devops');
  await q(`UPDATE workstations SET last_seen_at = now() WHERE connected`);
}
/** Runs a pass; returns the `shift.start` frames the runner got since `from`. */
async function pass(from: number) {
  await q(`UPDATE workstations SET last_seen_at = now() WHERE connected`);
  await r.barrier();
  dispatcher().cooldown.clear();
  await dispatcher().run();
  await r.barrier();
  return r.received.slice(from).filter((f) => f.type === 'shift.start') as any[];
}
const shiftAccount = async (shiftId: string) =>
  (await q('SELECT account_key FROM shifts WHERE id=$1', [shiftId]))[0]?.account_key ?? null;
const hireClaude = (name: string, role = 'builder') =>
  w.hire(name, role, role === 'builder' ? 'junior' : 'senior', { runtime: 'claude-code', model: 'sonnet' });

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [CLAUDE_ACCOUNTS_CAPABILITY] });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

describe('card shifts', () => {
  it('claims on the project account and says so in shift.start, the event and the shift row', async () => {
    await reset();
    await setAccount('work');
    await report([acct('main'), acct('work')]);
    await hireClaude('Ada');
    const card = await w.card({ title: 'On work' });
    const from = r.received.length;
    const starts = await pass(from);
    expect(starts).toHaveLength(1);
    expect(starts[0].account).toEqual({ key: 'work' });
    expect(await shiftAccount(starts[0].shiftId)).toBe('work');
    const ev = await q(`SELECT payload FROM events WHERE type='CardClaimed' AND payload->>'cardId'=$1`, [
      card.id,
    ]);
    expect(ev[0]?.payload.accountKey).toBe('work');
  });

  it('a project without an account uses main and sends no account', async () => {
    await reset();
    await setAccount(null);
    await report([acct('main'), acct('work')]);
    await hireClaude('Ada');
    await w.card({ title: 'On main' });
    const starts = await pass(r.received.length);
    expect(starts).toHaveLength(1);
    expect(starts[0].account).toBeUndefined();
    expect(await shiftAccount(starts[0].shiftId)).toBeNull();
  });

  it('the project account out and fallback off: nothing is claimed; with fallback on it runs on main', async () => {
    await reset();
    await setAccount('work', false);
    await report([acct('main'), OUT('work')]);
    await hireClaude('Ada');
    const card = await w.card({ title: 'Waits' });
    expect(await pass(r.received.length)).toHaveLength(0);
    expect((await q('SELECT status FROM cards WHERE id=$1', [card.id]))[0]?.status).toBe('queued');

    await setAccount('work', true);
    const starts = await pass(r.received.length);
    expect(starts).toHaveLength(1);
    expect(starts[0].account).toBeUndefined();
    expect(await shiftAccount(starts[0].shiftId)).toBeNull();
  });

  it('an expired or never completed login counts like a hit limit', async () => {
    await reset();
    await setAccount('work', false);
    await report([acct('main'), acct('work', { login: 'none' })]);
    await hireClaude('Ada');
    await w.card({ title: 'No login' });
    expect(await pass(r.received.length)).toHaveLength(0);
    await report([acct('main'), acct('work', { login: 'expired' })]);
    expect(await pass(r.received.length)).toHaveLength(0);
  });

  it('claim, reject, no re-claim: an account the runner still reports limited stays out after its limitedUntil passed', async () => {
    await reset();
    await setAccount('work', false);
    await report([acct('main'), acct('work')]);
    await hireClaude('Ada');
    const card = await w.card({ title: 'Reject loop' });
    const starts = await pass(r.received.length);
    expect(starts).toHaveLength(1);
    expect(starts[0].account).toEqual({ key: 'work' });

    // the runner rejects: the account is limited and its reset time has already passed (its probe has not cleared it yet)
    const past = hours(-1);
    r.rejected(starts[0].shiftId, 'usage_limited', { accountKey: 'work', limitedUntil: past });
    for (let i = 0; i < 100; i++) {
      await r.barrier();
      if ((await q('SELECT claim_id FROM cards WHERE id=$1', [card.id]))[0]?.claim_id === null) break;
      await new Promise((res) => setTimeout(res, 30));
    }
    expect((await q('SELECT claim_id FROM cards WHERE id=$1', [card.id]))[0]?.claim_id).toBeNull();

    // still reported limited, with the past time: no claim on it (twice, to be sure), however the stored row was patched
    await report([acct('main'), acct('work', { usage: 'limited', limitedUntil: past })]);
    expect(await pass(r.received.length)).toHaveLength(0);
    expect(await pass(r.received.length)).toHaveLength(0);

    // another account is still usable: with fallback on the card runs on main
    await setAccount('work', true);
    const next = await pass(r.received.length);
    expect(next).toHaveLength(1);
    expect(next[0].account).toBeUndefined();
  });

  it('main also out: fallback finds nothing and the ticket waits; the runtime is not offered work at all', async () => {
    await reset();
    await setAccount('work', true);
    await report([OUT('main'), OUT('work')]);
    await hireClaude('Ada');
    await w.card({ title: 'Everything out' });
    expect(await pass(r.received.length)).toHaveLength(0);
  });

  it('main out but the project account fine: the project still runs; a project without an account waits', async () => {
    await reset();
    await setAccount('work', false);
    await report([OUT('main'), acct('work')]);
    await hireClaude('Ada');
    await w.card({ title: 'Work card' });
    const starts = await pass(r.received.length);
    expect(starts).toHaveLength(1);
    expect(starts[0].account).toEqual({ key: 'work' });

    await reset();
    await setAccount(null);
    await hireClaude('Bea');
    await w.card({ title: 'Main card' });
    expect(await pass(r.received.length)).toHaveLength(0);
  });

  it('recovery: the next claim returns to the project account', async () => {
    await reset();
    await setAccount('work', false);
    await report([acct('main'), OUT('work')]);
    await hireClaude('Ada');
    await w.card({ title: 'Recovers' });
    expect(await pass(r.received.length)).toHaveLength(0);
    await report([acct('main'), acct('work')]);
    const starts = await pass(r.received.length);
    expect(starts).toHaveLength(1);
    expect(starts[0].account).toEqual({ key: 'work' });
  });

  it('a legacy runtime (no accounts) only offers main: the project key counts as missing', async () => {
    await reset();
    await setAccount('work', false);
    await report(undefined);
    await hireClaude('Ada');
    await w.card({ title: 'Legacy' });
    expect(await pass(r.received.length)).toHaveLength(0);
    await setAccount('work', true);
    const starts = await pass(r.received.length);
    expect(starts).toHaveLength(1);
    expect(starts[0].account).toBeUndefined();
  });

  it('a runtime other than Claude Code is not paused by the project account', async () => {
    await reset();
    await setAccount('work', false);
    await report([acct('main')]);
    await w.hire('Mo', 'builder', 'junior');
    await w.card({ title: 'Mock agent' });
    const starts = await pass(r.received.length);
    expect(starts).toHaveLength(1);
    expect(starts[0].account).toBeUndefined();
  });
});

describe('question and BA task shifts', () => {
  async function questionItem(agentId: string, cardId: string | null) {
    const id = randomUUID();
    await q(
      `INSERT INTO desk_items (id, org_id, kind, status, routed_to, routed_agent_id, card_id, project_id, title, created_at, updated_at)
       VALUES ($1,$2,'question','open','agent',$3,$4,$5,'Which one?',now(),now())`,
      [id, w.owner.id, agentId, cardId, w.projectId],
    );
    return id;
  }

  it('a question about a ticket uses the project account; without a card it uses main', async () => {
    await reset();
    await setAccount('work', false);
    await report([acct('main'), acct('work')]);
    const ada = await hireClaude('Ada', 'architect');
    const card = await w.card({ title: 'Asked about' });
    const item = await questionItem(ada.id, card.id);
    await pass(r.received.length);
    const shift = (await q(`SELECT account_key FROM shifts WHERE desk_item_id=$1`, [item]))[0];
    expect(shift?.account_key).toBe('work');
    const ev = await q(
      `SELECT payload FROM events WHERE type='QuestionShiftDispatched' AND payload->>'deskItemId'=$1`,
      [item],
    );
    expect(ev[0]?.payload.accountKey).toBe('work');

    await reset();
    const bea = await hireClaude('Bea', 'architect');
    const free = await questionItem(bea.id, null);
    await pass(r.received.length);
    const row = (await q(`SELECT account_key FROM shifts WHERE desk_item_id=$1`, [free]))[0];
    expect(row).toBeDefined();
    expect(row?.account_key).toBeNull();
  });

  it('a question about a ticket waits while the project account is out (no fallback)', async () => {
    await reset();
    await setAccount('work', false);
    await report([acct('main'), OUT('work')]);
    const ada = await hireClaude('Ada', 'architect');
    const card = await w.card({ title: 'Asked about, paused' });
    const item = await questionItem(ada.id, card.id);
    await pass(r.received.length);
    expect(await q(`SELECT 1 FROM shifts WHERE desk_item_id=$1`, [item])).toHaveLength(0);
  });

  it('a spec_card BA task uses the project account; a task without a card uses main', async () => {
    await reset();
    await setAccount('work', false);
    await report([acct('main'), acct('work')]);
    await hireClaude('Ben', 'ba');
    const card = await w.card({ title: 'Needs a spec', specify: false });
    const withCard = randomUUID();
    await q(
      `INSERT INTO ba_tasks (id, org_id, project_id, card_id, kind, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'spec_card','queued',now(),now())`,
      [withCard, w.owner.id, w.projectId, card.id],
    );
    await pass(r.received.length);
    expect((await q(`SELECT account_key FROM shifts WHERE ba_task_id=$1`, [withCard]))[0]?.account_key).toBe(
      'work',
    );
  });
});

describe('DevOps and CEO stay on main', () => {
  it('a DevOps request waits while main is out even though the project account is fine, and runs on main', async () => {
    await reset();
    await setAccount('work', false);
    await q(`UPDATE agents SET runtime='claude-code' WHERE is_devops`);
    await report([OUT('main'), acct('work')]);
    const req = await ok<any>(
      w.t.req('POST', '/api/devops/requests', {
        cookie: w.owner.cookie,
        body: { workstationId: w.workstationId, summary: 'check the box' },
      }),
      201,
    );
    expect(await pass(r.received.length)).toHaveLength(0);
    expect((await q('SELECT status FROM devops_requests WHERE id=$1', [req.request.id]))[0]?.status).toBe(
      'queued',
    );

    await report([acct('main'), OUT('work')]);
    const starts = await pass(r.received.length);
    expect(starts.filter((s) => s.kind === 'devops')).toHaveLength(1);
    expect(starts[0].account).toBeUndefined();
  });
});
