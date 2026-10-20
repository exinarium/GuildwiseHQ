import { CLAUDE_ACCOUNTS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { FakeRunner } from './helpers/fake-runner.ts';
import { freshState, shiftHelpers } from './helpers/shifts.ts';
import { createWorld, MOCK_RUNTIME, ok, REPO_SSH, until, type World } from './helpers/world.ts';

/**
 * Per-project Claude accounts, slice A3 (docs/design/claude-accounts.md 2.3-2.5): `claude.account.ensure` is queued when
 * a key is set and at hello for keys the runner does not report (only to capable runners, once a day); each answer opens
 * or closes the right desk notice; an account's limit or login problem is announced per account; a rejection that names
 * an account marks it out at once and costs the card nothing; the project says paused or on fallback.
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
const helloWith = async (
  accounts: unknown[] | undefined,
  capabilities: string[] = [CLAUDE_ACCOUNTS_CAPABILITY],
) => {
  if (r) {
    r.close();
    await r.waitClosed();
    // the server notes the lost connection asynchronously: it must not land after the new hello
    await until(
      async () =>
        (await q('SELECT connected FROM workstations WHERE id=$1', [w.workstationId]))[0]?.connected ===
        false,
      3000,
      'disconnected',
    );
  }
  const nr = await FakeRunner.connect(w.baseUrl, w.runnerToken);
  nr.hello({
    runtimes: [MOCK_RUNTIME[0], { ...CLAUDE, ...(accounts ? { accounts } : {}) }] as never,
    capabilities,
    repos: [{ remoteUrl: REPO_SSH, localPath: '/tmp/toy', headBranch: 'main' }],
  });
  await nr.waitFor('welcome');
  await w.t.app.ctx.notifier.flush();
  r = nr;
  return nr;
};
const report = async (accounts: unknown[] | undefined, top: Record<string, unknown> = {}) => {
  r.send('runtimes.report', {
    runtimes: [MOCK_RUNTIME[0], { ...CLAUDE, ...(accounts ? { accounts } : {}), ...top }],
  });
  await r.barrier();
};
const setAccount = (accountKey: string | null, fallbackToMain = false) =>
  ok(
    w.t.req('PUT', `/api/projects/${w.projectId}/claude-account`, {
      cookie: w.owner.cookie,
      body: { accountKey, fallbackToMain },
    }),
  );
const ensures = () =>
  q(
    `SELECT payload->>'key' AS key, status FROM runner_commands WHERE type='claude.account.ensure' ORDER BY created_at`,
  );
const notices = (subkind: string) =>
  q(`SELECT title, body, org_id FROM desk_items WHERE subkind=$1 AND status='open' ORDER BY created_at`, [
    subkind,
  ]);
const answered = new Set<string>();
const answerEnsure = async (key: string, result: Record<string, unknown>) => {
  // the newest ensure for the key that was not answered yet (a hello may have asked earlier, then been cleared)
  const open = () =>
    r
      .of('command')
      .filter(
        (f) => f.command === 'claude.account.ensure' && f.payload.key === key && !answered.has(f.commandId),
      )
      .at(-1);
  await until(async () => !!open(), 5000, 'ensure delivered');
  const cmd = open()!;
  answered.add(cmd.commandId);
  r.send('command.result', { commandId: cmd.commandId, ok: true, result });
  await r.barrier();
};
async function reset() {
  await q(`TRUNCATE cards, shifts, desk_items, runner_commands CASCADE`);
  await q(`DELETE FROM agents WHERE NOT is_devops`);
  await q(`UPDATE workstations SET claude_account_ensure='{}'::jsonb`);
  await q(`UPDATE desk_items SET status='resolved' WHERE status='open'`);
  await q(`UPDATE projects SET claude_account_key=NULL, claude_account_fallback=false`);
}

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [CLAUDE_ACCOUNTS_CAPABILITY] });
});
afterAll(async () => {
  r?.close();
  await w.t.close();
  await closeAdminPool();
});

describe('claude.account.ensure at hello', () => {
  it('asks a capable runner for a key it does not report, once a day; not when it reports the key', async () => {
    await reset();
    await w.hire('Ada', 'builder', 'junior', { runtime: 'claude-code', model: 'sonnet' });
    await setAccount('work');
    await q(`DELETE FROM runner_commands`);
    const nr = await helloWith([acct('main')]);
    const cmd = await nr.waitFor('command', (f) => f.command === 'claude.account.ensure');
    expect(cmd.payload).toEqual({ key: 'work' });
    expect(await ensures()).toHaveLength(1);

    // answered or not, a reconnect within a day does not ask again
    nr.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { key: 'work', state: 'awaiting_login', aliasAdded: false },
    });
    await nr.barrier();
    await q(`UPDATE runner_commands SET status='done'`);
    await helloWith([acct('main')]);
    await r.barrier();
    expect(await ensures()).toHaveLength(1);

    // a day later it is asked again
    await q(`UPDATE runner_commands SET created_at = created_at - interval '25 hours'`);
    await helloWith([acct('main')]);
    await r.waitFor('command', (f) => f.command === 'claude.account.ensure');
    expect(await ensures()).toHaveLength(2);

    // reporting the key: nothing to ask
    await q(`DELETE FROM runner_commands`);
    await helloWith([acct('main'), acct('work')]);
    await r.barrier();
    expect(await ensures()).toHaveLength(0);
  });

  it('never sends the command to a runner without the capability, and says to update it', async () => {
    await reset();
    await w.hire('Ada', 'builder', 'junior', { runtime: 'claude-code', model: 'sonnet' });
    await setAccount('work');
    await q(`DELETE FROM runner_commands`);
    await helloWith(undefined, []);
    await r.barrier();
    expect(await ensures()).toHaveLength(0);
    const open = await notices('claude_account_login');
    expect(open).toHaveLength(1);
    expect(open[0]?.title).toMatch(/Update the runner .* account work/);
    expect(open[0]?.body).toContain('0.1.33');
  });
});

describe('answers and sign-in notices', () => {
  it('awaiting_login opens a sign-in notice with the browser link text and the claude-gw terminal fallback; login ok closes it', async () => {
    await reset();
    await w.hire('Ada', 'builder', 'junior', { runtime: 'claude-code', model: 'sonnet' });
    await helloWith([acct('main')]);
    await q(`DELETE FROM runner_commands`);
    await setAccount('work');
    await answerEnsure('work', {
      key: 'work',
      state: 'awaiting_login',
      configDir: '~/.claude-gw-work',
      aliasAdded: true,
    });
    const open = await notices('claude_account_login');
    expect(open).toHaveLength(1);
    expect(open[0]?.title).toBe(
      `Claude account work needs a sign-in on ${(await q('SELECT name FROM workstations'))[0]?.name}`,
    );
    expect(open[0]?.body).toContain('Sign in with your Claude subscription');
    expect(open[0]?.body).toContain('claude-gw-work');
    expect(open[0]?.body).toContain('CLAUDE_CONFIG_DIR=~/.claude-gw-work claude auth login');
    expect(open[0]?.body).not.toContain('claude-work');
    const stored = (await q('SELECT claude_account_ensure AS e FROM workstations'))[0]?.e;
    expect(stored.work).toMatchObject({ state: 'awaiting_login', configDir: '~/.claude-gw-work' });

    // the same report again changes nothing; the login completing closes the notice
    await report([acct('main'), acct('work', { login: 'none', configDir: '~/.claude-gw-work' })]);
    expect(await notices('claude_account_login')).toHaveLength(1);
    await report([acct('main'), acct('work')]);
    expect(await notices('claude_account_login')).toHaveLength(0);
  });

  it('needs_owner and failed give the exact commands', async () => {
    await reset();
    await w.hire('Ada', 'builder', 'junior', { runtime: 'claude-code', model: 'sonnet' });
    await helloWith([acct('main')]);
    await q(`DELETE FROM runner_commands`);
    await setAccount('work');
    await answerEnsure('work', { key: 'work', state: 'needs_owner', aliasAdded: false });
    let open = await notices('claude_account_login');
    expect(open[0]?.body).toContain('aom-runner accounts add work');
    expect(open[0]?.body).toContain('aom-runner accounts login work');

    await setAccount('work');
    await answerEnsure('work', {
      key: 'work',
      state: 'failed',
      aliasAdded: false,
      detail: 'the folder is outside your home',
    });
    open = await notices('claude_account_login');
    expect(open).toHaveLength(1);
  });

  it('ready closes the notice; an expired or never completed login of a reported account raises it', async () => {
    await reset();
    await helloWith([acct('main'), acct('work', { login: 'expired' })]);
    await setAccount('work');
    await report([acct('main'), acct('work', { login: 'expired' })]);
    const open = await notices('claude_account_login');
    expect(open).toHaveLength(1);
    expect(open[0]?.body).toContain('login has expired');
    expect(open[0]?.body).toContain('are paused');
    await report([acct('main'), acct('work')]);
    expect(await notices('claude_account_login')).toHaveLength(0);
  });

  it('with fallback on, the notice says tickets run on main meanwhile', async () => {
    await reset();
    await setAccount('work', true);
    await helloWith([acct('main'), acct('work', { login: 'none' })]);
    await report([acct('main'), acct('work', { login: 'none' })]);
    expect((await notices('claude_account_login'))[0]?.body).toContain('run on the main account meanwhile');
  });
});

describe('notice wording follows the project setting', () => {
  it('turning fallback on rewrites "paused" to "runs on the main account"; off turns it back; clearing closes it', async () => {
    await reset();
    await helloWith([acct('main')]);
    await setAccount('work', false);
    await report([acct('main'), acct('work', { login: 'none' })]);
    let open = await notices('claude_account_login');
    expect(open).toHaveLength(1);
    expect(open[0]?.body).toContain('are paused');

    await setAccount('work', true);
    open = await notices('claude_account_login');
    expect(open).toHaveLength(1);
    expect(open[0]?.body).toContain('run on the main account meanwhile');
    expect(open[0]?.body).not.toContain('paused');

    await setAccount('work', false);
    open = await notices('claude_account_login');
    expect(open).toHaveLength(1);
    expect(open[0]?.body).toContain('are paused');

    await setAccount(null);
    expect(await notices('claude_account_login')).toHaveLength(0);
  });
});

describe('usage notices per account and the project banner', () => {
  const projectDto = async () =>
    (await w.t.req('GET', '/api/projects', { cookie: w.owner.cookie })).body.projects.find(
      (p: any) => p.id === w.projectId,
    );
  const LIMITED = (key: string, until: string) =>
    acct(key, { usage: 'limited', limitedUntil: until, limitedLabel: '18:00 (Africa/Johannesburg)' });

  it('names the account and what happens to the project; closes on recovery', async () => {
    await reset();
    await w.hire('Ada', 'builder', 'junior', { runtime: 'claude-code', model: 'sonnet' });
    await setAccount('work', false);
    await helloWith([acct('main'), acct('work')]);
    const until = hours(4);
    await report([acct('main'), LIMITED('work', until)]);
    const open = await notices('claude_usage_limit');
    expect(open).toHaveLength(1);
    expect(open[0]?.title).toMatch(/Claude account work reached its usage limit on /);
    expect(open[0]?.body).toContain('until 18:00 (Africa/Johannesburg)');
    expect(open[0]?.body).toMatch(/Projects \S+ are paused/);

    const p = await projectDto();
    expect(p.usageLimit).toMatchObject({ until, accountKey: 'work', mode: 'paused' });

    await report([acct('main'), acct('work')]);
    expect(await notices('claude_usage_limit')).toHaveLength(0);
    expect((await projectDto()).usageLimit).toBeUndefined();
  });

  it('fallback on: the project is on fallback, not paused; main out as well: paused', async () => {
    await setAccount('work', true);
    const until = hours(4);
    await report([acct('main'), LIMITED('work', until)]);
    expect((await projectDto()).usageLimit).toMatchObject({ until, accountKey: 'work', mode: 'fallback' });
    expect((await notices('claude_usage_limit'))[0]?.body).toMatch(/fall back to the main account/);

    await report([LIMITED('main', hours(2)), LIMITED('work', until)], {
      available: false,
      usage: 'limited',
      limitedUntil: hours(2),
      limitedLabel: '16:00 (Africa/Johannesburg)',
    });
    expect((await projectDto()).usageLimit).toMatchObject({ mode: 'paused' });
  });

  it('main out but the project account fine: no banner; a project without an account is paused', async () => {
    await setAccount('work', false);
    await report([LIMITED('main', hours(2)), acct('work')], { usage: 'limited', limitedUntil: hours(2) });
    expect((await projectDto()).usageLimit).toBeUndefined();
    await setAccount(null);
    expect((await projectDto()).usageLimit).toMatchObject({ mode: 'paused', accountKey: 'main' });
    await report([acct('main'), acct('work')]);
  });
});

describe('a rejection that names an account', () => {
  const h = () => shiftHelpers(w);

  it('marks the account out at once, puts the card back without penalty and never counts toward the storm item', async () => {
    await freshState();
    await q(`DELETE FROM agents WHERE NOT is_devops`);
    await q(`UPDATE desk_items SET status='resolved' WHERE status='open'`);
    await setAccount('work', false);
    await helloWith([acct('main'), acct('work')]);
    await w.hire('Ada', 'builder', 'junior', { runtime: 'claude-code', model: 'sonnet' });
    const card = await w.card({ title: 'Account runs out' });
    const from0 = r.received.length;
    const start = await h().dispatchTo(r, 'Ada', from0);
    expect(start.account).toEqual({ key: 'work' });

    const until = hours(3);
    // the report has not arrived yet: the rejection itself closes the race
    r.rejected(start.shiftId, 'usage_limited', {
      detail: '18:00 (Africa/Johannesburg)',
      limitedUntil: until,
      accountKey: 'work',
    });
    await until_(
      async () => (await q('SELECT claim_id FROM cards WHERE id=$1', [card.id]))[0]?.claim_id === null,
    );
    const c = (await q('SELECT status, retry_after, retry_failures FROM cards WHERE id=$1', [card.id]))[0]!;
    expect(c.status).toBe('queued');
    expect(c.retry_after).toBeNull();
    expect(Number(c.retry_failures ?? 0)).toBe(0);
    const stored = (await q('SELECT runtimes FROM workstations WHERE id=$1', [w.workstationId]))[0]?.runtimes;
    const entry = stored.find((x: any) => x.id === 'claude-code').accounts.find((a: any) => a.key === 'work');
    expect(entry).toMatchObject({ usage: 'limited', limitedUntil: until });
    expect(
      stored.find((x: any) => x.id === 'claude-code').accounts.find((a: any) => a.key === 'main').usage,
    ).toBe('ok');
    const msg = await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='system'`, [card.id]);
    expect(msg.map((m) => m.body).join('\n')).toContain('account `work` reached its usage limit');

    // nothing is dispatched on it now
    w.t.app.ctx.services.dispatcher.cooldown.clear();
    const from = r.received.length;
    await w.t.app.ctx.services.dispatcher.run();
    await r.barrier();
    expect(r.received.slice(from).filter((f) => f.type === 'shift.start')).toHaveLength(0);
    expect(await q(`SELECT 1 FROM desk_items WHERE subkind='worktree_rejections'`)).toHaveLength(0);
  });

  it('auth_expired marks the login expired; five in a row still raise no storm item', async () => {
    await freshState();
    await q(`DELETE FROM agents WHERE NOT is_devops`);
    await helloWith([acct('main'), acct('work')]);
    await w.hire('Ada', 'builder', 'junior', { runtime: 'claude-code', model: 'sonnet' });
    const card = await w.card({ title: 'Login expires' });
    for (let i = 0; i < 4; i++) {
      await report([acct('main'), acct('work')]);
      w.t.app.ctx.services.dispatcher.cooldown.clear();
      const start = await h().dispatchTo(r, 'Ada', r.received.length);
      r.rejected(start.shiftId, 'auth_expired', { accountKey: 'work' });
      await until_(
        async () => (await q('SELECT claim_id FROM cards WHERE id=$1', [card.id]))[0]?.claim_id === null,
      );
    }
    expect(await q(`SELECT 1 FROM desk_items WHERE subkind='worktree_rejections'`)).toHaveLength(0);
    const stored = (await q('SELECT runtimes FROM workstations WHERE id=$1', [w.workstationId]))[0]?.runtimes;
    expect(
      stored.find((x: any) => x.id === 'claude-code').accounts.find((a: any) => a.key === 'work').login,
    ).toBe('expired');
  });
});

const until_ = (fn: () => Promise<boolean>) => until(fn, 3000, 'condition');
