import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const dispatcher = () => w.t.app.ctx.services.dispatcher;

async function freshState() {
  await q(
    'TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages, agents, runner_commands, runner_inbox CASCADE',
  );
}

async function dispatchTo(r: FakeRunner, agentName: string, from = 0) {
  await r.barrier();
  await dispatcher().run();
  return r.waitFor('shift.start', (f) => f.agent.name === agentName, 5000, from);
}

async function startShift(r: FakeRunner, start: Awaited<ReturnType<typeof dispatchTo>>) {
  r.accepted(start.shiftId);
  r.started(start.shiftId, {
    path: `/work/${start.brief.card.ref}`,
    branchName: start.worktree?.branchName ?? 'x',
    baseBranch: 'main',
    created: start.worktree?.mode === 'create',
    headSha: 'abc123',
  });
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'running']))[0],
    3000,
    'shift running',
  );
}

describe('unstick an agent', () => {
  it('"stop the running command" sends shift.kill_tools and leaves the shift running', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Kit', 'builder', 'junior');
    await w.card({ title: 'Hung tests' });
    const s = await dispatchTo(r, 'Kit');
    await startShift(r, s);
    const res = await ok<any>(
      w.t.req('POST', `/api/shifts/${s.shiftId}/kill-tools`, { cookie: w.owner.cookie, body: {} }),
    );
    expect(res.sent).toBe(true);
    const frame = await r.waitFor('shift.kill_tools', (f) => f.shiftId === s.shiftId);
    expect(frame.shiftId).toBe(s.shiftId);
    expect((await q('SELECT status FROM shifts WHERE id=$1', [s.shiftId]))[0]?.status).toBe('running');
    r.close();
  });

  it('stop re-queues the card by default', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Lia', 'builder', 'junior');
    const card = await w.card({ title: 'Stop me' });
    const s = await dispatchTo(r, 'Lia');
    await startShift(r, s);
    await ok(w.t.req('POST', `/api/shifts/${s.shiftId}/stop`, { cookie: w.owner.cookie, body: {} }));
    await r.waitFor('shift.stop', (f) => f.shiftId === s.shiftId);
    r.ended(s.shiftId, 'stopped');
    await until(
      async () => (await q('SELECT 1 FROM cards WHERE id=$1 AND status=$2', [card.id, 'queued']))[0],
      3000,
      'card queued again',
    );
    r.close();
  });

  it('stop with keepCard gives the card straight back to the same agent', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Max', 'builder', 'junior');
    const card = await w.card({ title: 'Keep me' });
    const s = await dispatchTo(r, 'Max');
    const agentId = s.agent.agentId;
    await startShift(r, s);
    const stopped = await ok<any>(
      w.t.req('POST', `/api/shifts/${s.shiftId}/stop`, { cookie: w.owner.cookie, body: { keepCard: true } }),
    );
    expect(stopped.sent).toBe(true);
    await r.waitFor('shift.stop', (f) => f.shiftId === s.shiftId);
    const from = r.received.length;
    r.ended(s.shiftId, 'stopped');
    await r.barrier();
    await dispatcher().run();
    await until(
      async () =>
        (
          await q('SELECT 1 FROM shifts WHERE card_id=$1 AND id <> $2 AND agent_id=$3', [
            card.id,
            s.shiftId,
            agentId,
          ])
        )[0],
      5000,
      'a fresh shift for the same agent',
    );
    const next = await r.waitFor('shift.start', (f) => f.shiftId !== s.shiftId, 5000, from);
    expect(next.agent.agentId).toBe(agentId);
    r.close();
  });

  it('a stranger cannot stop a shift', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Oli', 'builder', 'junior');
    await w.card({ title: 'Not yours' });
    const s = await dispatchTo(r, 'Oli');
    await startShift(r, s);
    const other = await w.t.userSession(`other-${Date.now()}@example.test`);
    const res = await w.t.req('POST', `/api/shifts/${s.shiftId}/kill-tools`, {
      cookie: other.cookie,
      body: {},
    });
    expect([403, 404]).toContain(res.status);
    r.close();
  });
});

describe('working branch sync', () => {
  const status = (over: Record<string, unknown> = {}) => ({
    repoId: w.repoId,
    workingBranch: 'dev',
    state: 'behind',
    ahead: 0,
    behind: 3,
    dirty: false,
    onBranch: true,
    checkedOutBranch: 'dev',
    checkedAt: new Date().toISOString(),
    ...over,
  });

  it('stores the runner report and shows it on the workstation and in the project', async () => {
    await q(`UPDATE project_repos SET working_branch='dev' WHERE id=$1`, [w.repoId]);
    const r = await w.connectRunner();
    r.send('repo.sync_status', { status: status() });
    await r.barrier();
    const list = await ok<any>(w.t.req('GET', '/api/workstations', { cookie: w.owner.cookie }));
    const repo = list.workstations.find((x: any) => x.id === w.workstationId).repos[0];
    expect(repo.sync).toMatchObject({ state: 'behind', behind: 3, workingBranch: 'dev' });
    const proj = await ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: w.owner.cookie }));
    expect(proj.repos[0].syncs[0]).toMatchObject({ state: 'behind', behind: 3, canSync: true });
    r.close();
  });

  it('a hello asks the runner for a first check; "Sync now" queues another and the answer is stored', async () => {
    await q(`UPDATE project_repos SET working_branch='dev' WHERE id=$1`, [w.repoId]);
    await q('TRUNCATE runner_commands');
    await q('DELETE FROM repo_sync_status');
    const r = await w.connectRunner();
    const first = await r.waitFor('command', (f) => f.command === 'repo.sync');
    expect(first.payload).toMatchObject({ repoId: w.repoId, workingBranch: 'dev' });
    r.send('command.result', {
      commandId: first.commandId,
      ok: true,
      result: status({ state: 'updated', behind: 0 }),
    });
    await r.barrier();
    const from = r.received.length;
    await ok(
      w.t.req('POST', `/api/workstations/${w.workstationId}/repos/${w.repoId}/sync`, {
        cookie: w.owner.cookie,
        body: {},
      }),
      202,
    );
    const again = await r.waitFor(
      'command',
      (f) => f.command === 'repo.sync' && f.commandId !== first.commandId,
      5000,
      from,
    );
    r.send('command.result', {
      commandId: again.commandId,
      ok: true,
      result: status({ state: 'diverged', ahead: 2, behind: 1 }),
    });
    await r.barrier();
    const rows = await q('SELECT state, ahead, behind FROM repo_sync_status WHERE project_repo_id=$1', [
      w.repoId,
    ]);
    expect(rows[0]).toMatchObject({ state: 'diverged', ahead: 2, behind: 1 });
    r.close();
  });

  it('only the workstation owner can sync', async () => {
    const other = await w.t.userSession(`syncer-${Date.now()}@example.test`);
    const res = await w.t.req('POST', `/api/workstations/${w.workstationId}/repos/${w.repoId}/sync`, {
      cookie: other.cookie,
      body: {},
    });
    expect(res.status).toBe(404);
  });
});
