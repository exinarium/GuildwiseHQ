import {
  PREP_TASK_KINDS,
  RELEASE_DOCS_PREP_CAPABILITY,
  RELEASE_DOCS_PREP_WRITER_TASKS_CAPABILITY,
  RELEASE_SHIP_CAPABILITY,
  ReleaseFactsSchema,
  streamId,
} from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runBaTaskFallback } from '../src/commands/ba-tasks.ts';
import { withAppendTx } from '../src/db/tx.ts';
import { applyReleaseDocsPrepResult } from '../src/release/docs-prep.ts';
import { applyLegacyChangelogReport } from '../src/release/docs-prep-legacy.ts';
import { applyReleasePrepReport, releasePrepTaskPass } from '../src/release/docs-prep-tasks.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, markOnline, type World } from './helpers/world.ts';

/** The 'Write changelog' step end to end on the server: dispatch, the release prep task, the report and the stored output. */

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const HEAD = 'a'.repeat(40);
const FEAT = 'e'.repeat(40);
const CHORE = 'f'.repeat(40);
type Rows = [any, ...any[]];
const q2 = async (sql: string, params: unknown[] = []) => (await q(sql, params)) as Rows;
const base = () => `/api/projects/${w.projectId}/release-docs-prep`;
const owner = (method: string, u: string, body?: unknown) =>
  w.t.req(method, u, { cookie: w.owner.cookie, body });
const cmds = () => q2(`SELECT * FROM runner_commands WHERE type='release.docs_prep' ORDER BY created_at`);
const tasks = () =>
  q2(`SELECT * FROM release_docs_prep_tasks WHERE step='changelog' ORDER BY attempt, position, created_at`);
const latest = async () => (await owner('GET', `${base()}/runs/latest`)).body;

async function setCaps(writerTasks: boolean) {
  await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
  const caps = [RELEASE_DOCS_PREP_CAPABILITY, RELEASE_SHIP_CAPABILITY];
  if (writerTasks) caps.push(RELEASE_DOCS_PREP_WRITER_TASKS_CAPABILITY);
  await q(
    `INSERT INTO workstation_capabilities (workstation_id, capabilities, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (workstation_id) DO UPDATE SET capabilities=$2`,
    [w.workstationId, caps],
  );
}

async function setFacts(changelog: string) {
  const facts = ReleaseFactsSchema.parse({
    headSha: HEAD,
    ahead: 2,
    lastTag: { name: 'v1.3.0', sha: 'b'.repeat(40) },
    existingTags: ['v1.3.0'],
    changedTotal: 1,
    commits: [],
    components: [],
    changelog,
  });
  await q(
    `INSERT INTO repo_release_facts (project_repo_id, request_id, trigger, state, head_sha, facts, requested_at, updated_at)
     VALUES ($1, gen_random_uuid(), 'manual', 'ready', $2, $3::jsonb, now(), now())
     ON CONFLICT (project_repo_id) DO UPDATE SET state='ready', head_sha=$2, facts=$3::jsonb`,
    [w.repoId, HEAD, JSON.stringify(facts)],
  );
}

const GOOD_MD =
  '## [Unreleased]\n\n### Added\n\n- Retire a workstation with agent handover.\n\n## [1.3.0] - 2026-10-20\n';

beforeEach(async () => {
  await freshState();
  await q(`TRUNCATE release_proposals, release_ships, repo_release_facts, release_docs_prep_runs CASCADE`);
  await q(`TRUNCATE runner_commands CASCADE`);
  await q(`DELETE FROM ba_tasks WHERE kind='release_changelog'`);
  await q(`TRUNCATE release_docs_prep_tasks`);
  await q(
    `UPDATE projects SET release_docs_prep='{"enabled": true, "steps": {"guide": false, "help": false}}'::jsonb, working_branch='release/1.5.0' WHERE id=$1`,
    [w.projectId],
  );
  await q(`UPDATE project_repos SET main_branch='main', working_branch=NULL WHERE id=$1`, [w.repoId]);
  await setCaps(true);
  await setFacts(GOOD_MD);
});

async function answer(result: Record<string, unknown>, ok_ = true) {
  const list = await cmds();
  const last = list[list.length - 1];
  await applyReleaseDocsPrepResult(w.t.app.ctx, w.workstationId, last.payload, ok_, result, undefined);
  return last.payload;
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
    commitCount: 2,
    commits: [
      { sha: FEAT, subject: 'feat: export boards', author: 'A', date: '2026-11-01' },
      { sha: CHORE, subject: 'chore: bump deps', author: 'A', date: '2026-11-01' },
    ],
    commitsTruncated: false,
    merges: [],
    cards: [],
    areas: [],
  },
};

const ENTRY =
  'Export a board. Download every card of a board as a spreadsheet to share it with people outside the team.';
const stepTag = (c: any) => `${c.payload.step}${c.payload.phase ? `:${c.payload.phase}` : ''}`;

/** Gives the queued task to the BA (as the dispatcher pass does) and returns the shift row. */
async function dispatchTask(role = 'ba') {
  const agent = (
    await q2(`SELECT id FROM agents WHERE role_key=$2 AND workstation_id=$1 LIMIT 1`, [w.workstationId, role])
  )[0];
  const t = (
    await q2(`SELECT * FROM release_docs_prep_tasks WHERE status='queued' ORDER BY attempt, position LIMIT 1`)
  )[0];
  const shiftId = crypto.randomUUID();
  await withAppendTx(w.t.app.ctx.pool, (tx) =>
    w.t.app.ctx.store.append(
      [
        {
          streamId: `releasedocs-${t.run_id}`,
          event: {
            type: 'ReleaseDocsPrepTaskDispatched',
            payload: { taskId: t.id, shiftId, agentId: agent.id, workstationId: w.workstationId },
          },
          actor: { kind: 'system' } as never,
          scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' } as never,
        },
      ],
      { tx },
    ),
  );
  return (await q2(`SELECT * FROM shifts WHERE id=$1`, [shiftId]))[0];
}
const prepReport = (shift: any, outcomeId: string, note: string, data: Record<string, unknown> = {}) =>
  withAppendTx(w.t.app.ctx.pool, (tx) =>
    applyReleasePrepReport(
      w.t.app.ctx,
      tx,
      { report: { kind: 'outcome', outcomeId, note, data } } as never,
      shift,
    ),
  );

async function startToChangelog() {
  expect((await owner('POST', `${base()}/runs`)).status).toBeLessThan(300);
  await answer(analysed);
}

describe('Write changelog: dispatch', () => {
  it('queues one changelog_entries task for the repository (not a BA task) and sends no runner command yet', async () => {
    await w.hire('Ada', 'ba', 'senior');
    await startToChangelog();
    expect((await cmds()).map(stepTag)).toEqual(['analyse']);
    const t = await tasks();
    expect(t).toHaveLength(1);
    expect(t[0].repo_id).toBe(w.repoId);
    expect(t[0].phase).toBe('write');
    expect(t[0].task.kind).toBe('changelog_entries');
    expect((await q2(`SELECT count(*)::int AS n FROM ba_tasks WHERE kind='release_changelog'`))[0].n).toBe(0);
    const run = await latest();
    const write = run.repos[0].steps.find((s: any) => s.step === 'changelog' && s.phase === 'write');
    expect(write.state).toBe('running');
    expect(t[0].task.changes.map((c: any) => c.source)).toEqual([FEAT, CHORE]);
    expect(t[0].task.existing).toEqual([
      { heading: 'Added', text: 'Retire a workstation with agent handover.' },
    ]);
  });

  it('the writer of a changelog task is a BA first, then an architect, then a builder (one registry)', () => {
    expect(PREP_TASK_KINDS.changelog_entries.roles).toEqual(['ba', 'architect', 'builder']);
  });

  it('fails the step before any task when the facts at the analysed head are malformed', async () => {
    await setFacts('## [Unreleased]\n\n## [1.5.0]\n\n### Added\n\n- Pending.\n\n## [1.3.0] - 2026-10-20\n');
    await startToChangelog();
    expect(await tasks()).toHaveLength(0);
    const run = await latest();
    expect(run.status).toBe('failed');
    expect(JSON.stringify(run)).toContain('without a date');
    expect((await cmds()).map(stepTag)).toEqual(['analyse']); // nothing committed
  });

  it('fails the step before its first phase when the workstation runner takes no writer tasks', async () => {
    await setCaps(false);
    await startToChangelog();
    expect(await tasks()).toHaveLength(0);
    const run = await latest();
    expect(run.status).toBe('failed');
    expect(run.failed.error).toBe(
      'Write changelog needs a newer runner on the workstation that has toy. Update the runner and retry prep.',
    );
  });

  it('with no writer agent on the workstation the write phase fails with the one no-writer message', async () => {
    await startToChangelog();
    expect(await tasks()).toHaveLength(1);
    await releasePrepTaskPass(w.t.app.ctx);
    const run = await latest();
    expect(run.status).toBe('failed');
    expect(run.failed.error).toMatch(
      /^Write changelog: no agent on .+ can write the changelog entries\. It needs an active BA, architect or builder agent on that workstation\. Hire or move one there \(or turn the step off\), then Retry prep\. Or write the entries under ## \[Unreleased\] by hand and Skip prep\.$/,
    );
    expect((await tasks())[0].code).toBe('no_writer');
    expect((await cmds()).map(stepTag)).toEqual(['analyse']);
  });

  it('a task nobody could take within 2 hours fails as writer_unreachable, naming why', async () => {
    await w.hire('Ada', 'ba', 'senior');
    await startToChangelog();
    w.t.clock.advance(2 * 3_600_000 + 60_000);
    try {
      await releasePrepTaskPass(w.t.app.ctx);
    } finally {
      w.t.clock.setOffset(0);
    }
    const run = await latest();
    expect(run.status).toBe('failed');
    expect(run.failed.error).toContain('no agent on');
    expect(run.failed.error).toContain('could write the changelog entries within 2 hours (');
    expect((await tasks())[0].code).toBe('writer_unreachable');
  });
});

describe('Write changelog: the report', () => {
  const GOOD = {
    entries: [{ heading: 'added', text: ENTRY, sources: [FEAT] }],
    skipped: [{ source: CHORE, reason: 'internal' }],
  };

  it('refuses a bad proposal with the findings (repair round), then stores the accepted one and sends it to the runner', async () => {
    await w.hire('Ada', 'ba', 'senior');
    await startToChangelog();
    const shift = await dispatchTask();
    const bad = await prepReport(shift, 'prep_done', 'done', {
      proposal: { entries: [{ heading: 'Added', text: `${ENTRY} Done in GWP-74.`, sources: [FEAT] }] },
    });
    expect(bad.accepted).toBe(false);
    expect(bad.error).toContain('The entries were not accepted. Fix these and report again:');
    expect(bad.error).toContain("ticket key 'GWP-74'");
    expect(bad.error).toContain('not accounted for');
    // the task stays open for the repair, nothing was sent
    expect((await tasks())[0].status).toBe('running');
    expect((await cmds()).map(stepTag)).toEqual(['analyse']);

    const good = await prepReport(shift, 'prep_done', 'done', { proposal: GOOD });
    expect(good.accepted).toBe(true);
    const [t] = await tasks();
    expect(t.status).toBe('done');
    expect(t.result.entries).toEqual([{ heading: 'Added', text: ENTRY, sources: [FEAT] }]);
    expect(t.result.skipped).toEqual([{ source: CHORE, reason: 'internal' }]);
    const list = await cmds();
    const sent = list[list.length - 1].payload;
    expect([sent.step, sent.phase]).toEqual(['changelog', 'apply']);
    expect(sent.changelog.entries).toEqual([{ heading: 'Added', text: ENTRY, sources: [FEAT] }]);
    expect(sent.changelog.proposal.skipped).toEqual([{ source: CHORE, reason: 'internal' }]);
    expect(sent.writer).toBeUndefined();

    // The runner applied it: the output is stored and served per repository.
    await answer({
      ok: true,
      state: 'passed',
      files: ['CHANGELOG.md'],
      notices: [],
      output: {
        created: false,
        added: [{ heading: 'Added', text: ENTRY, sources: [FEAT] }],
        duplicates: [],
        warnings: [],
      },
    });
    const row = (
      await q2(`SELECT output FROM release_docs_prep_steps WHERE step='changelog' AND phase='apply'`)
    )[0];
    expect(row.output.added[0].text).toBe(ENTRY);
    expect(row.output.skipped).toEqual([{ source: CHORE, reason: 'internal' }]);
    const run = await latest();
    expect(
      run.repos[0].steps.find((s: any) => s.step === 'changelog' && s.phase === 'apply').output.added,
    ).toHaveLength(1);
  });

  it('a deny-list name in an entry is refused (and never echoed)', async () => {
    await w.hire('Ada', 'ba', 'senior');
    await startToChangelog();
    const shift = await dispatchTask();
    const r = await prepReport(shift, 'prep_done', 'done', {
      proposal: {
        entries: [{ heading: 'Added', text: `Export a board with Ada. ${ENTRY}`, sources: [FEAT] }],
        skipped: [{ source: CHORE, reason: 'internal' }],
      },
    });
    expect(r.accepted).toBe(false);
    expect(r.error).not.toContain('Ada');
    expect((await tasks())[0].status).toBe('running');
  });

  it('a report with no proposal is refused', async () => {
    await w.hire('Ada', 'ba', 'senior');
    await startToChangelog();
    const shift = await dispatchTask();
    const r = await prepReport(shift, 'prep_done', 'done', {});
    expect(r.accepted).toBe(false);
    expect(r.error).toContain('no proposal');
  });

  it('a second run on the same release queues no task and sends no entries', async () => {
    await w.hire('Ada', 'ba', 'senior');
    await startToChangelog();
    await prepReport(await dispatchTask(), 'prep_done', 'done', { proposal: GOOD });
    await answer({
      ok: true,
      state: 'passed',
      files: ['CHANGELOG.md'],
      notices: [],
      output: { added: [{ heading: 'Added', text: ENTRY, sources: [FEAT] }] },
    });
    await answer({ ok: true, state: 'passed', files: [], notices: [] }); // commit prepare
    await answer({ ok: true, state: 'passed', files: [], notices: [] }); // commit push
    expect((await latest()).status).toBe('passed');

    await startToChangelog();
    expect(await tasks()).toHaveLength(1); // only the first run's task
    const list = await cmds();
    const sent = list[list.length - 1].payload;
    expect([sent.step, sent.phase]).toEqual(['changelog', 'apply']);
    expect(sent.changelog.entries).toEqual([]);
  });

  it('a fail report fails the step and the run; nothing is sent', async () => {
    await w.hire('Ada', 'ba', 'senior');
    await startToChangelog();
    const r = await prepReport(await dispatchTask(), 'prep_failed', 'The changes are all internal.');
    expect(r.accepted).toBe(true);
    const run = await latest();
    expect(run.status).toBe('failed');
    expect(run.failed.error).toBe(
      'Write changelog: the changelog entries could not be written: The changes are all internal.',
    );
    expect((await cmds()).map(stepTag)).toEqual(['analyse']);
  });

  it('a report after the run was skipped is closed and sends nothing', async () => {
    await w.hire('Ada', 'ba', 'senior');
    await startToChangelog();
    const shift = await dispatchTask();
    await owner('POST', `${base()}/skip`);
    const r = await prepReport(shift, 'prep_done', 'done', { proposal: GOOD });
    expect(r.accepted).toBe(true);
    expect((await cmds()).map(stepTag)).toEqual(['analyse']);
  });
});

describe('a Write changelog BA task queued before the update (legacy)', () => {
  async function legacyTask() {
    await startToChangelog();
    const run = (await q2(`SELECT id FROM release_docs_prep_runs`))[0];
    // the old shape: a changelog row without phases that waits for a BA task
    await q(`TRUNCATE release_docs_prep_tasks`);
    await q(
      `INSERT INTO release_docs_prep_steps (run_id, repo_id, step, phase, state) VALUES ($1, $2, 'changelog', '', 'running')`,
      [run.id, w.repoId],
    );
    const taskId = crypto.randomUUID();
    await withAppendTx(w.t.app.ctx.pool, (tx) =>
      w.t.app.ctx.store.append(
        [
          {
            streamId: streamId.baTask(taskId),
            event: {
              type: 'BaTaskQueued',
              payload: {
                taskId,
                projectId: w.projectId,
                kind: 'release_changelog',
                prepRunId: run.id,
                prepRepoId: w.repoId,
              },
            },
            actor: { kind: 'system' } as never,
            scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' } as never,
          },
        ],
        { tx },
      ),
    );
    await q(`UPDATE ba_tasks SET status='running' WHERE id=$1`, [taskId]);
    return (await q2(`SELECT * FROM ba_tasks WHERE id=$1`, [taskId]))[0];
  }

  it("the fallback cancels the task and fails the run's changelog row with a retry message", async () => {
    const task = await legacyTask();
    await withAppendTx(w.t.app.ctx.pool, (tx) => runBaTaskFallback(w.t.app.ctx, tx, task));
    expect((await q2(`SELECT status FROM ba_tasks WHERE id=$1`, [task.id]))[0].status).toBe('cancelled');
    const run = await latest();
    expect(run.status).toBe('failed');
    expect(run.failed.error).toBe('Write changelog was interrupted by an update. Retry prep.');
  });

  it('a report cancels the task, writes nothing and fails the row the same way', async () => {
    const task = await legacyTask();
    const r = await withAppendTx(w.t.app.ctx.pool, (tx) => applyLegacyChangelogReport(w.t.app.ctx, tx, task));
    expect(r.accepted).toBe(true);
    expect((await q2(`SELECT status FROM ba_tasks WHERE id=$1`, [task.id]))[0].status).toBe('cancelled');
    expect((await latest()).failed.error).toBe('Write changelog was interrupted by an update. Retry prep.');
    expect((await cmds()).map(stepTag)).toEqual(['analyse']);
  });
});

describe('Write changelog off', () => {
  it('never queues a task or sends a changelog command', async () => {
    await q(
      `UPDATE projects SET release_docs_prep='{"enabled": true, "steps": {"changelog": false, "guide": false, "help": false}}'::jsonb WHERE id=$1`,
      [w.projectId],
    );
    await startToChangelog();
    expect(await tasks()).toHaveLength(0);
    expect((await cmds()).map(stepTag)).toEqual(['analyse', 'commit:prepare']);
  });
});
