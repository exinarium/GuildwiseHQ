import {
  RELEASE_DOCS_PREP_CAPABILITY,
  RELEASE_DOCS_PREP_WRITER_TASKS_CAPABILITY,
  RELEASE_SHIP_CAPABILITY,
} from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAppendTx } from '../src/db/tx.ts';
import { applyReleaseDocsPrepResult } from '../src/release/docs-prep.ts';
import {
  queueReleasePrepTasks,
  RELEASE_PREP_MAX_REJECTIONS,
  releasePrepTaskPass,
} from '../src/release/docs-prep-tasks.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { freshState, hireDevopsEngineer } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * A release_prep shift through the runner gateway: the dispatcher pass sends `shift.start`, the runner accepts, starts,
 * reports it in heartbeats and ends it with `aom prep done`; rejected and unaccepted starts.
 */

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const HEAD = 'a'.repeat(40);
const SHA = 'c'.repeat(40);
type Rows = [any, ...any[]];
const q2 = async (sql: string, params: unknown[] = []) => (await q(sql, params)) as Rows;
const base = () => `/api/projects/${w.projectId}/release-docs-prep`;
const owner = (method: string, u: string, body?: unknown) =>
  w.t.req(method, u, { cookie: w.owner.cookie, body });
const cmds = () => q2(`SELECT * FROM runner_commands WHERE type='release.docs_prep' ORDER BY created_at`);
const tag = (c: any) => `${c.payload.step}${c.payload.phase ? `:${c.payload.phase}` : ''}`;
const tasks = () => q2(`SELECT * FROM release_docs_prep_tasks ORDER BY attempt, position`);
const latest = async () => (await owner('GET', `${base()}/runs/latest`)).body;
const shiftRow = async (id: string) => (await q2('SELECT * FROM shifts WHERE id=$1', [id]))[0];

async function answer(result: Record<string, unknown>) {
  const list = await cmds();
  const last = list[list.length - 1];
  await applyReleaseDocsPrepResult(w.t.app.ctx, w.workstationId, last.payload, true, result, undefined);
}

const analysed = {
  ok: true,
  state: 'passed',
  files: [],
  notices: [],
  baseTag: 'v1.3.0',
  baseSha: 'b'.repeat(40),
  headSha: HEAD,
  summary: {
    repoName: 'toy',
    branch: 'release/1.5.0',
    headSha: HEAD,
    base: { kind: 'tag', tag: 'v1.3.0', sha: 'b'.repeat(40) },
    commitCount: 1,
    commits: [{ sha: 'e'.repeat(40), subject: 'feat', author: 'A', date: '2026-11-01' }],
    commitsTruncated: false,
    merges: [],
    cards: [],
    areas: [],
  },
};
const created = {
  slug: 'forms',
  action: 'create',
  reasons: ['new screen Forms (GWP-200)'],
  state: 'pending',
};
const planWithNewVideo = {
  ok: true,
  state: 'passed',
  files: [],
  notices: [],
  report: {
    harness: true,
    rule: 'rule',
    voice: 'Kokoro af_heart',
    videos: [created],
    shared: [],
    unmapped: [],
    ignoredCount: 0,
    needsAuthoring: [
      { slug: 'forms', title: 'Forms', pages: ['apps/web/src/pages/Forms.tsx'], reasons: created.reasons },
    ],
  },
};

let r: FakeRunner;

beforeEach(async () => {
  r?.close();
  await freshState();
  await q(`TRUNCATE release_proposals, release_ships, repo_release_facts, release_docs_prep_runs CASCADE`);
  await q(
    `UPDATE projects SET release_docs_prep='{"enabled": false, "steps": {}}'::jsonb, working_branch='release/1.5.0' WHERE id=$1`,
    [w.projectId],
  );
  await q(`UPDATE project_repos SET main_branch='main', working_branch=NULL WHERE id=$1`, [w.repoId]);
  w.t.clock.setOffset(0);
  r = await w.connectRunner({
    capabilities: [
      RELEASE_DOCS_PREP_CAPABILITY,
      RELEASE_DOCS_PREP_WRITER_TASKS_CAPABILITY,
      RELEASE_SHIP_CAPABILITY,
    ],
  });
  await hireDevopsEngineer(w);
  await owner('PUT', `${base()}/settings`, {
    enabled: true,
    steps: { changelog: false, guide: false, help: false, videos: true },
  });
  await ok(owner('POST', `${base()}/runs`), 202);
  await answer(analysed);
  await answer(planWithNewVideo);
  expect((await tasks())[0].status).toBe('queued');
});

afterAll(() => r?.close());

/** Runs the dispatcher's release prep pass and returns the `shift.start` the runner receives. */
async function dispatch() {
  await r.barrier();
  const from = r.received.length;
  const started = await releasePrepTaskPass(w.t.app.ctx);
  expect(started).toHaveLength(1);
  const start = await r.waitFor('shift.start', (f) => f.shiftId === started[0]!.shiftId, 5000, from);
  expect(start.kind).toBe('release_prep');
  return start;
}

async function startShift(shiftId: string) {
  r.accepted(shiftId);
  r.started(shiftId);
  await until(async () => (await shiftRow(shiftId))?.status === 'running', 3000, 'shift running');
}

describe('queued tasks of a run that ended', () => {
  it.each([
    ['passed', 'finished'],
    ['failed', 'failed'],
    ['skipped', 'was cancelled'],
  ])(
    'a queued task of a run that is %s is closed with the reason and not dispatched',
    async (status, wording) => {
      await q(`UPDATE release_docs_prep_runs SET status=$1`, [status]);
      const started = await releasePrepTaskPass(w.t.app.ctx);
      expect(started).toEqual([]);
      const [t] = await tasks();
      expect(t.status).toBe('failed');
      expect(t.note).toContain(`release prep run ended (it ${wording})`);
      expect(t.code ?? null).toBeNull();
    },
  );
});

describe('commands are delivered after the commit', () => {
  it('sends the next step command once the report committed, with no timer', async () => {
    const start = await dispatch();
    await startShift(start.shiftId);
    const deliver = vi.spyOn(w.t.app.ctx.services.gateway, 'deliverPending');
    const timer = vi.spyOn(globalThis, 'setTimeout');
    try {
      const { reportId } = r.report(start.shiftId, {
        kind: 'outcome',
        outcomeId: 'prep_done',
        note: 'wrote the forms video',
        data: { commit: SHA, files: ['e2e/video/forms.spec.ts'] },
      });
      await r.waitFor('shift.report.result', (f) => f.reportId === reportId);
      expect(deliver).toHaveBeenCalledWith(w.workstationId);
      expect(timer.mock.calls.some((c) => c[1] === 250)).toBe(false);
    } finally {
      deliver.mockRestore();
      timer.mockRestore();
    }
  });
});

describe('a release_prep shift through the gateway', () => {
  it('is started by the dispatcher pass, kept on heartbeat, and its prep done renders the new video', async () => {
    const start = await dispatch();
    expect(start.releasePrep?.task).toMatchObject({ kind: 'new_video', slug: 'forms' });
    expect(start.releasePrep?.writable).toContain('e2e/video/forms.spec.ts');
    expect((await tasks())[0].status).toBe('running');
    await startShift(start.shiftId);

    const stops = () => r.of('shift.stop').filter((f) => f.shiftId === start.shiftId);
    for (let i = 0; i < 2; i++) {
      r.heartbeat([start.shiftId]);
      await r.barrier();
    }
    expect(stops()).toEqual([]);
    expect((await shiftRow(start.shiftId)).status).toBe('running');

    const { reportId } = r.report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'prep_done',
      note: 'wrote the forms video',
      data: { commit: SHA, files: ['e2e/video/forms.spec.ts'] },
    });
    const res = await r.waitFor('shift.report.result', (f) => f.reportId === reportId);
    expect(res.accepted).toBe(true);
    expect((await tasks())[0].status).toBe('done');
    const list = await cmds();
    expect(list.map(tag)).toEqual(['analyse', 'videos:plan', 'videos:render']);
    expect(list[2].payload.input.authored).toEqual(['forms']);

    // once ended, a runner that still reports the shift is told to stop it
    r.ended(start.shiftId, 'reported');
    await until(async () => (await shiftRow(start.shiftId)).status === 'ended', 3000, 'shift ended');
    r.heartbeat([start.shiftId]);
    await r.barrier();
    await until(async () => stops().length > 0, 3000, 'stop after the end');
    expect(stops()[0]!.reason).toBe('claim_lost');
  });

  it(`a start the workstation keeps refusing fails the task after ${RELEASE_PREP_MAX_REJECTIONS} tries, naming the reason`, async () => {
    for (let i = 0; i < RELEASE_PREP_MAX_REJECTIONS; i++) {
      const start = await dispatch();
      r.rejected(start.shiftId, 'worktree_failed', { detail: 'refs/guildwise/docs-prep work ref missing' });
      await until(async () => (await shiftRow(start.shiftId)).status === 'ended', 3000, 'rejected');
      if (i < RELEASE_PREP_MAX_REJECTIONS - 1) {
        expect((await tasks())[0].status).toBe('queued');
        expect((await latest()).status).toBe('running');
      }
    }
    const [t] = await tasks();
    expect(t.status).toBe('failed');
    expect(t.note).toBe(
      'the workstation could not start the task (worktree_failed: refs/guildwise/docs-prep work ref missing)',
    );
    const run = await latest();
    expect(run.status).toBe('failed');
    expect(run.failed.error).toContain(
      'forms: could not write the video script: the workstation could not start',
    );
    expect((await cmds()).map(tag)).not.toContain('videos:render');
  });

  it('a busy agent or account is requeued without counting', async () => {
    for (const reason of ['busy', 'usage_limited', 'auth_expired', 'busy']) {
      const start = await dispatch();
      r.rejected(start.shiftId, reason);
      await until(async () => (await shiftRow(start.shiftId)).status === 'ended', 3000, 'rejected');
    }
    expect((await tasks())[0].status).toBe('queued');
    expect((await latest()).status).toBe('running');
  });

  it('a start the runner never accepts is ended by the reaper, the task requeued and the agent cooled down', async () => {
    const start = await dispatch();
    expect((await shiftRow(start.shiftId)).status).toBe('starting');
    w.t.clock.advance(31_000);
    await w.t.app.ctx.services.reaper.run();
    const s = await shiftRow(start.shiftId);
    expect([s.status, s.outcome]).toEqual(['ended', 'rejected']);
    expect((await tasks())[0].status).toBe('queued');
    expect(w.t.app.ctx.services.dispatcher.cooldown.get(s.agent_id)).toBeGreaterThan(
      w.t.clock.now().getTime(),
    );
    // after the cooldown the dispatcher gives it out again
    const again = await dispatch();
    expect(again.shiftId).not.toBe(start.shiftId);
    w.t.clock.setOffset(0);
  });
});

describe('one chooser for the writer of every content step', () => {
  const changelogTask = {
    kind: 'changelog_entries' as const,
    projectName: 'Toy',
    repoName: 'toy',
    releaseBranch: 'release/1.5.0',
    changes: [],
    existing: [],
  };
  const guideTask = {
    kind: 'guide_edits' as const,
    guidePath: 'docs/USER-GUIDE.md',
    changes: [
      { sources: ['card:TOY-1'], title: 'x', subjects: [], files: [], areas: [], routes: [], hints: [] },
    ],
    coveredSources: [],
  };

  async function queue(step: string, phase: string, task: typeof changelogTask | typeof guideTask) {
    const run = (await q2('SELECT * FROM release_docs_prep_runs'))[0];
    await withAppendTx(w.t.app.ctx.pool, (tx) =>
      queueReleasePrepTasks(w.t.app.ctx, tx, run, w.repoId, step, phase, 0, [task]),
    );
  }

  it('gives every task kind to the workstation DevOps agent, never to a BA, architect or builder', async () => {
    // GWP-189: release prep always runs outside the agent sandbox, so only the DevOps engineer may write it.
    await w.hire('Ada', 'ba', 'senior');
    await w.hire('Amy', 'architect', 'senior');
    await w.hire('Cy', 'builder', 'junior');
    await queue('changelog', 'write', changelogTask);
    await queue('guide', 'write', guideTask);
    const kinds: string[] = [];
    // one release_prep shift at a time per agent: drain the three queued tasks one pass at a time
    for (let i = 0; i < 3; i++) {
      await r.barrier();
      const started = await releasePrepTaskPass(w.t.app.ctx);
      expect(started.length).toBeLessThanOrEqual(1);
      for (const s of started) {
        const a = (await q2('SELECT is_devops, role_key FROM agents WHERE id=$1', [s.agentId]))[0];
        expect(a.is_devops).toBe(true);
        expect(a.role_key).toBe('devops');
        kinds.push(
          (await q2('SELECT task FROM release_docs_prep_tasks WHERE id=$1', [s.taskId]))[0].task.kind,
        );
        await q(`UPDATE shifts SET status='ended' WHERE agent_id=$1 AND kind='release_prep'`, [s.agentId]);
      }
    }
    expect(kinds.sort()).toEqual(['changelog_entries', 'guide_edits', 'new_video']);
    // the start is a release_prep shift with the proposal task, not a DevOps request
    const start = r.of('shift.start').find((f: any) => f.releasePrep?.task.kind === 'changelog_entries');
    expect(start?.kind).toBe('release_prep');
    expect(start?.agent.isDevops).toBe(true);
    expect(start?.releasePrep?.writable).toEqual(['release-prep-proposal.json']);
    expect(start?.brief.card.title).toBe('Write the changelog entries (release/1.5.0)');
  });

  it('starts nothing when the workstation has only non-DevOps agents (no fallback to another role)', async () => {
    await q(`UPDATE agents SET status='retired' WHERE is_devops AND workstation_id=$1`, [w.workstationId]);
    await w.hire('Ada', 'ba', 'senior');
    await w.hire('Amy', 'architect', 'senior');
    await queue('changelog', 'write', changelogTask);
    await r.barrier();
    expect(await releasePrepTaskPass(w.t.app.ctx)).toEqual([]);
    const failed = (
      await q2("SELECT status, code FROM release_docs_prep_tasks WHERE task->>'kind'='changelog_entries'")
    )[0];
    expect(failed).toMatchObject({ status: 'failed', code: 'no_writer' });
  });

  it('does not use a paused DevOps agent', async () => {
    await q(`UPDATE agents SET paused_at=now() WHERE is_devops AND workstation_id=$1`, [w.workstationId]);
    await r.barrier();
    expect(await releasePrepTaskPass(w.t.app.ctx)).toEqual([]);
  });
});
