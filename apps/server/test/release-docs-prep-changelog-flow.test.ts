import {
  RELEASE_CHANGELOG_OUTCOME,
  RELEASE_DOCS_PREP_CAPABILITY,
  RELEASE_DOCS_PREP_CHANGELOG_CAPABILITY,
  RELEASE_SHIP_CAPABILITY,
  ReleaseFactsSchema,
} from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withAppendTx } from '../src/db/tx.ts';
import { applyReleaseDocsPrepResult } from '../src/release/docs-prep.ts';
import {
  applyReleaseChangelogReport,
  buildReleaseChangelogTask,
  runReleaseChangelogFallback,
} from '../src/release/docs-prep-changelog-task.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, markOnline, type World } from './helpers/world.ts';

/** The 'Write changelog' step end to end on the server: dispatch, the BA task, the report and the stored output. */

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
const tasks = () => q2(`SELECT * FROM ba_tasks WHERE kind='release_changelog' ORDER BY created_at`);
const latest = async () => (await owner('GET', `${base()}/runs/latest`)).body;

async function setCaps(changelog: boolean) {
  await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
  const caps = [RELEASE_DOCS_PREP_CAPABILITY, RELEASE_SHIP_CAPABILITY];
  if (changelog) caps.push(RELEASE_DOCS_PREP_CHANGELOG_CAPABILITY);
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

const GOOD_MD = '## [Unreleased]\n\n### Added\n\n- Retire a workstation with agent handover.\n\n## [1.3.0] - 2026-10-20\n';

beforeEach(async () => {
  await freshState();
  await q(`TRUNCATE release_proposals, release_ships, repo_release_facts, release_docs_prep_runs CASCADE`);
  await q(`TRUNCATE runner_commands CASCADE`);
  await q(`DELETE FROM ba_tasks WHERE kind='release_changelog'`);
  await q(
    `UPDATE projects SET release_docs_prep='{"enabled": true, "steps": {"guide": false}}'::jsonb, working_branch='release/1.5.0' WHERE id=$1`,
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

const ENTRY = 'Export a board. Download every card of a board as a spreadsheet to share it with people outside the team.';
const report = (outcomeId: string, data: unknown = {}, note?: string) =>
  ({ report: { kind: 'outcome', outcomeId, data, ...(note ? { note } : {}) } }) as any;

async function applyReport(msg: any) {
  const [task] = await tasks();
  await q(`UPDATE ba_tasks SET status='running' WHERE id=$1`, [task.id]);
  return withAppendTx(w.t.app.ctx.pool, (tx) => applyReleaseChangelogReport(w.t.app.ctx, tx, task, msg));
}

async function startToChangelog() {
  expect((await owner('POST', `${base()}/runs`)).status).toBeLessThan(300);
  await answer(analysed);
}

describe('Write changelog: dispatch', () => {
  it('queues one BA task for the repository and sends no runner command yet; the brief lists the changes', async () => {
    await startToChangelog();
    expect((await cmds()).map((c: any) => c.payload.step)).toEqual(['analyse']);
    const t = await tasks();
    expect(t).toHaveLength(1);
    expect(t[0].prep_repo_id).toBe(w.repoId);
    const run = await latest();
    expect(run.repos[0].steps.find((s: any) => s.step === 'changelog').state).toBe('running');
    const brief = await buildReleaseChangelogTask(w.t.app.ctx.pool, t[0]);
    expect(brief?.changes.map((c) => c.source)).toEqual([FEAT, CHORE]);
    expect(brief?.existing).toEqual([{ heading: 'Added', text: 'Retire a workstation with agent handover.' }]);
  });

  it('fails the step before any task when the facts at the analysed head are malformed', async () => {
    await setFacts('## [Unreleased]\n\n## [1.5.0]\n\n### Added\n\n- Pending.\n\n## [1.3.0] - 2026-10-20\n');
    await startToChangelog();
    expect(await tasks()).toHaveLength(0);
    const run = await latest();
    expect(run.status).toBe('failed');
    expect(JSON.stringify(run)).toContain('without a date');
    expect((await cmds()).map((c: any) => c.payload.step)).toEqual(['analyse']); // nothing committed
  });

  it('fails the step when the workstation runner cannot apply entries', async () => {
    await setCaps(false);
    await startToChangelog();
    expect(await tasks()).toHaveLength(0);
    expect((await latest()).status).toBe('failed');
  });
});

describe('Write changelog: the report', () => {
  it('refuses a bad proposal with the findings (repair round), then sends the accepted entries to the runner', async () => {
    await startToChangelog();
    const bad = await applyReport(
      report(RELEASE_CHANGELOG_OUTCOME.done, {
        entries: [{ heading: 'Added', text: `${ENTRY} Done in GWP-74.`, sources: [FEAT] }],
      }),
    );
    expect(bad.accepted).toBe(false);
    expect(bad.error).toContain("ticket key 'GWP-74'");
    expect(bad.error).toContain('not accounted for');
    expect((await cmds()).map((c: any) => c.payload.step)).toEqual(['analyse']);

    const good = await applyReport(
      report(RELEASE_CHANGELOG_OUTCOME.done, {
        entries: [{ heading: 'added', text: ENTRY, sources: [FEAT] }],
        skipped: [{ source: CHORE, reason: 'internal' }],
      }),
    );
    expect(good.accepted).toBe(true);
    const list = await cmds();
    const sent = list[list.length - 1].payload;
    expect(sent.step).toBe('changelog');
    expect(sent.changelog.entries).toEqual([{ heading: 'Added', text: ENTRY, sources: [FEAT] }]);
    expect((await tasks())[0].status).toBe('done');

    // The runner applied it: the output is stored and served per repository.
    await answer({
      ok: true,
      state: 'passed',
      files: ['CHANGELOG.md'],
      notices: [],
      output: { created: false, added: [{ heading: 'Added', text: ENTRY, sources: [FEAT] }], duplicates: [], warnings: [] },
    });
    const row = (await q2(`SELECT output FROM release_docs_prep_steps WHERE step='changelog'`))[0];
    expect(row.output.added[0].text).toBe(ENTRY);
    expect(row.output.skipped).toEqual([{ source: CHORE, reason: 'internal' }]);
    const run = await latest();
    expect(run.repos[0].steps.find((s: any) => s.step === 'changelog').output.added).toHaveLength(1);
  });

  it('a second run on the same release queues no task and sends no entries', async () => {
    await startToChangelog();
    await applyReport(
      report(RELEASE_CHANGELOG_OUTCOME.done, {
        entries: [{ heading: 'Added', text: ENTRY, sources: [FEAT] }],
        skipped: [{ source: CHORE, reason: 'internal' }],
      }),
    );
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
    expect(sent.step).toBe('changelog');
    expect(sent.changelog.entries).toEqual([]);
  });

  it('a fail report fails the step and the run; nothing is sent', async () => {
    await startToChangelog();
    const r = await applyReport(report(RELEASE_CHANGELOG_OUTCOME.fail, {}, 'The changes are all internal.'));
    expect(r.accepted).toBe(true);
    const run = await latest();
    expect(run.status).toBe('failed');
    expect(JSON.stringify(run)).toContain('The changes are all internal.');
    expect((await cmds()).map((c: any) => c.payload.step)).toEqual(['analyse']);
  });

  it('the fallback (no BA) fails the step and the run', async () => {
    await startToChangelog();
    const [task] = await tasks();
    await withAppendTx(w.t.app.ctx.pool, (tx) => runReleaseChangelogFallback(w.t.app.ctx, tx, task));
    expect((await latest()).status).toBe('failed');
    expect((await tasks())[0].status).toBe('fallback');
  });

  it('a report after the run was skipped is closed and sends nothing', async () => {
    await startToChangelog();
    await owner('POST', `${base()}/skip`);
    const r = await applyReport(
      report(RELEASE_CHANGELOG_OUTCOME.done, {
        entries: [{ heading: 'Added', text: ENTRY, sources: [FEAT] }],
        skipped: [{ source: CHORE, reason: 'internal' }],
      }),
    );
    expect(r.accepted).toBe(true);
    expect((await tasks())[0].status).toBe('cancelled');
    expect((await cmds()).map((c: any) => c.payload.step)).toEqual(['analyse']);
  });
});

describe('Write changelog off', () => {
  it('never queues a task or sends a changelog command', async () => {
    await q(
      `UPDATE projects SET release_docs_prep='{"enabled": true, "steps": {"changelog": false, "guide": false}}'::jsonb WHERE id=$1`,
      [w.projectId],
    );
    await startToChangelog();
    expect(await tasks()).toHaveLength(0);
    expect((await cmds()).map((c: any) => c.payload.step)).toEqual(['analyse', 'commit']);
  });
});
