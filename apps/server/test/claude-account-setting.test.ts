import { CLAUDE_ACCOUNTS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember } from './helpers/members.ts';
import { eventsOfType } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, MOCK_RUNTIME, ok, until, type World } from './helpers/world.ts';

/**
 * Per-project Claude accounts, slice A1 (docs/design/claude-accounts.md): the project names an account by key; the
 * setting is an event (ProjectClaudeAccountSet), a no-op when unchanged, owner/admin only, rebuilt from events, and a new
 * key is queued for provisioning (`claude.account.ensure`) on the workstations that serve the project. The view lists
 * ready and missing workstations.
 */
let w: World;
let r: FakeRunner;
const CLAUDE = { id: 'claude-code', version: '2.1.299', available: true, capabilities: ['shell'] };
const info = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  main: key === 'main',
  source: key === 'main' ? 'default' : 'config_dir',
  login: 'ok',
  usage: 'ok',
  ...over,
});

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [CLAUDE_ACCOUNTS_CAPABILITY] });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const put = (body: unknown, cookie = w.owner.cookie, status = 200) =>
  ok<any>(w.t.req('PUT', `/api/projects/${w.projectId}/claude-account`, { cookie, body }), status);
const project = () => ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: w.owner.cookie }));
const view = () =>
  ok<any>(w.t.req('GET', `/api/projects/${w.projectId}/claude-accounts`, { cookie: w.owner.cookie }));
const ensures = () =>
  q(`SELECT payload, status FROM runner_commands WHERE type='claude.account.ensure' ORDER BY created_at`);
const report = async (accounts?: unknown[]) => {
  r.send('runtimes.report', {
    runtimes: [MOCK_RUNTIME[0], { ...CLAUDE, ...(accounts ? { accounts } : {}) }],
  });
  await r.barrier();
};

describe('project setting: Claude account', () => {
  it('defaults to the main account with the fallback off', async () => {
    await freshState();
    await w.hire('Ada', 'builder', 'junior', { runtime: 'claude-code', model: 'sonnet' });
    expect((await project()).project.claudeAccount).toEqual({ key: null, fallbackToMain: false });
  });

  it('the owner names an account; the same value again appends nothing', async () => {
    const p = await put({ accountKey: 'work' });
    expect(p.project.claudeAccount).toEqual({ key: 'work', fallbackToMain: false });
    expect(await eventsOfType('ProjectClaudeAccountSet')).toHaveLength(1);
    await put({ accountKey: 'work', fallbackToMain: false });
    expect(await eventsOfType('ProjectClaudeAccountSet')).toHaveLength(1);
    expect((await put({ accountKey: 'work', fallbackToMain: true })).project.claudeAccount).toEqual({
      key: 'work',
      fallbackToMain: true,
    });
    expect(await eventsOfType('ProjectClaudeAccountSet')).toHaveLength(2);
  });

  it('rejects a bad key, the reserved key main, and a manager who is not Owner or Admin', async () => {
    await put({ accountKey: 'Work Space' }, w.owner.cookie, 400);
    await put({ accountKey: 'main' }, w.owner.cookie, 400);
    const manager = await addMember(w, 'acct-mgr');
    await put({ accountKey: 'other' }, manager.cookie, 403);
    expect((await project()).project.claudeAccount.key).toBe('work');
  });

  it('clearing the key goes back to main and drops the fallback switch', async () => {
    const p = await put({ accountKey: null, fallbackToMain: true });
    expect(p.project.claudeAccount).toEqual({ key: null, fallbackToMain: false });
    await put({ accountKey: 'work' });
  });

  it('is rebuilt from the events', async () => {
    await put({ accountKey: 'work', fallbackToMain: true });
    await q(`UPDATE projects SET claude_account_key=NULL, claude_account_fallback=false WHERE id=$1`, [
      w.projectId,
    ]);
    const { rebuildProjections } = await import('../src/projections/rebuild.ts');
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect((await project()).project.claudeAccount).toEqual({ key: 'work', fallbackToMain: true });
  });
});

describe('provisioning request and the view', () => {
  it('queues claude.account.ensure for the key on a capable workstation, not twice while one is waiting', async () => {
    await freshState();
    await w.hire('Bob', 'builder', 'junior', { runtime: 'claude-code', model: 'sonnet' });
    await q(`DELETE FROM runner_commands WHERE type='claude.account.ensure'`);
    await put({ accountKey: 'proj2' });
    // the connected fake runner receives it at once and answers nothing: the command stays 'sent'
    await until(async () => (await ensures()).length === 1, 3000, 'ensure queued');
    expect((await ensures())[0]?.payload).toEqual({ key: 'proj2' });
    await put({ accountKey: 'proj2', fallbackToMain: true });
    expect(await ensures()).toHaveLength(1);
  });

  it('lists the workstation as missing, then ready, with main described by the legacy fields', async () => {
    await report();
    let v = await view();
    expect(v.setting).toEqual({ key: 'proj2', fallbackToMain: true });
    expect(v.workstations).toHaveLength(1);
    expect(v.workstations[0]).toMatchObject({ connected: true, supportsAccounts: true });
    expect(v.workstations[0].account).toBeUndefined();
    expect(v.workstations[0].main).toMatchObject({ key: 'main', login: 'ok', usage: 'ok' });

    await report([info('main'), info('proj2', { email: 'a@x.test', plan: 'claude_team' })]);
    v = await view();
    expect(v.workstations[0].account).toMatchObject({ key: 'proj2', email: 'a@x.test' });
    expect(v.knownKeys).toEqual(['proj2']);

    await report([info('main'), info('proj2', { login: 'none' }), info('other')]);
    v = await view();
    expect(v.workstations[0].account.login).toBe('none');
    expect(v.knownKeys).toEqual(['other', 'proj2']);
  });

  it('the view needs a visible project', async () => {
    const stranger = await w.t.userSession(`stranger-${Date.now()}@example.test`);
    await ok(
      w.t.req('GET', `/api/projects/${w.projectId}/claude-accounts`, { cookie: stranger.cookie }),
      404,
    );
  });
});
