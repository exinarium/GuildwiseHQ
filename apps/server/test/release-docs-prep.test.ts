import { randomUUID } from 'node:crypto';
import {
  RELEASE_DOCS_PREP_CAPABILITY,
  RELEASE_SHIP_CAPABILITY,
  type ReleaseFacts,
  ReleaseFactsSchema,
} from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyReleaseDocsPrepResult,
  releaseDocsPrepSweep,
  releaseDocsPrepViewFor,
} from '../src/release/docs-prep.ts';
import { reconcileReleaseProposal } from '../src/release/reconcile.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember } from './helpers/members.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, markOnline, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const HEAD = 'a'.repeat(40);
const PREP = 'd'.repeat(40);
type Rows = [any, ...any[]];
const q2 = async (sql: string, params: unknown[] = []) => (await q(sql, params)) as Rows;
const base = () => `/api/projects/${w.projectId}/release-docs-prep`;
const owner = (method: string, u: string, body?: unknown) =>
  w.t.req(method, u, { cookie: w.owner.cookie, body });
const cmds = () => q2(`SELECT * FROM runner_commands WHERE type='release.docs_prep' ORDER BY created_at`);
const events = async (type: string) =>
  Number((await q2(`SELECT count(*)::int AS n FROM events WHERE type=$1`, [type]))[0].n);

const facts = (commits: string[] = []): ReleaseFacts =>
  ReleaseFactsSchema.parse({
    headSha: HEAD,
    ahead: 3,
    lastTag: { name: 'v1.3.0', sha: 'b'.repeat(40) },
    existingTags: ['v1.3.0'],
    changedTotal: 1,
    commits: commits.map((sha) => ({ sha, subject: 'docs', breakingFooter: false })),
    components: [],
    changelog: '## [Unreleased]\n\n### Added\n\n- One.\n\n## [1.3.0] - 2026-10-20\n',
  });

async function capable() {
  await markOnline(w.t, w.workstationId, { repoIds: [w.repoId] });
  await q(
    `INSERT INTO workstation_capabilities (workstation_id, capabilities, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (workstation_id) DO UPDATE SET capabilities=$2`,
    [w.workstationId, [RELEASE_DOCS_PREP_CAPABILITY, RELEASE_SHIP_CAPABILITY]],
  );
}

beforeEach(async () => {
  await freshState();
  await q(`TRUNCATE release_proposals, release_ships, repo_release_facts, release_docs_prep_runs CASCADE`);
  await q(`TRUNCATE runner_commands CASCADE`);
  await q(
    `UPDATE projects SET release_docs_prep='{"enabled": false, "steps": {}}'::jsonb, working_branch='release/1.5.0' WHERE id=$1`,
    [w.projectId],
  );
  await q(`UPDATE project_repos SET main_branch='main', working_branch=NULL WHERE id=$1`, [w.repoId]);
  await capable();
});

/**
 * 'Write changelog' and 'Update user guide' are on by default but need a BA task and a writer agent: these tests untick
 * both unless they ask for one ('Write changelog' has its own tests in release-docs-prep-changelog-flow.test.ts).
 */
const enable = (steps: Record<string, boolean> = {}) =>
  owner('PUT', `${base()}/settings`, { enabled: true, steps: { changelog: false, guide: false, ...steps } });

/** Answers the newest command of the run as the workstation did. */
async function answer(result: Record<string, unknown>, ok_ = true, error?: string) {
  const list = await cmds();
  const last = list[list.length - 1];
  await applyReleaseDocsPrepResult(w.t.app.ctx, w.workstationId, last.payload, ok_, result, error);
  return last.payload;
}
const passedAnalyse = {
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
const latest = async () => (await owner('GET', `${base()}/runs/latest`)).body;

async function runToPassed(commit?: string) {
  const started = await owner('POST', `${base()}/runs`);
  expect(JSON.stringify(started.body)).toContain('runId');
  await answer(passedAnalyse);
  await answer({
    ok: true,
    state: 'passed',
    files: ['docs/G.md'],
    notices: [],
    ...(commit ? { commit } : {}),
  });
  await answer({
    ok: true,
    state: 'passed',
    files: [],
    notices: [],
    ...(commit ? { commit, pushed: true } : {}),
  });
}

async function approveShip() {
  await q(
    `INSERT INTO repo_release_facts (project_repo_id, request_id, trigger, state, head_sha, facts, requested_at, updated_at)
     VALUES ($1, gen_random_uuid(), 'manual', 'ready', $2, $3::jsonb, now(), now())
     ON CONFLICT (project_repo_id) DO UPDATE SET state='ready', head_sha=$2, facts=$3::jsonb`,
    [w.repoId, HEAD, JSON.stringify(facts([PREP]))],
  );
  await reconcileReleaseProposal(w.t.app.ctx, w.repoId, 'manual');
  const item = (
    await q2(`SELECT * FROM desk_items WHERE subkind='ship_release' AND data->>'repoId'=$1`, [w.repoId])
  )[0];
  return w.t.req('POST', `/api/desk/${item.id}/resolve`, {
    cookie: w.owner.cookie,
    body: { resolution: 'approved', release: { version: '1.4.0', components: [], factsHeadSha: HEAD } },
  });
}

describe('Release prep (docs and videos) settings', () => {
  it('is off by default and lists only the registered steps', async () => {
    const col = (await q2(`SELECT release_docs_prep FROM projects WHERE id=$1`, [w.projectId]))[0];
    expect(col.release_docs_prep).toEqual({ enabled: false, steps: {} });
    const s = await ok<any>(owner('GET', `${base()}/settings`));
    expect(s.enabled).toBe(false);
    expect(s.canEdit).toBe(true);
    expect(s.steps.map((x: any) => x.id)).toEqual(['analyse', 'changelog', 'guide', 'videos', 'commit']);
  });

  it('the owner changes it; a member gets 403 and an outsider 404; unknown steps are refused', async () => {
    const m = await addMember(w);
    const denied = await w.t.req('PUT', `${base()}/settings`, {
      cookie: m.cookie,
      body: { enabled: true, steps: {} },
    });
    expect(denied.status).toBe(403);
    const read = await ok<any>(w.t.req('GET', `${base()}/settings`, { cookie: m.cookie }));
    expect(read.canEdit).toBe(false);
    const stranger = await w.t.userSession(`stranger-${Date.now()}@example.test`);
    expect(
      (
        await w.t.req('PUT', `${base()}/settings`, {
          cookie: stranger.cookie,
          body: { enabled: true, steps: {} },
        })
      ).status,
    ).toBe(404);
    expect(
      (await owner('PUT', `${base()}/settings`, { enabled: true, steps: { nope: true } })).status,
    ).toBe(400);
    const before = await events('ReleaseDocsPrepSettingsSet');
    expect((await enable({ analyse: false })).status).toBe(200);
    expect(await events('ReleaseDocsPrepSettingsSet')).toBe(before + 1);
    await enable({ analyse: false });
    expect(await events('ReleaseDocsPrepSettingsSet')).toBe(before + 1); // unchanged: no event
    expect(
      (await ok<any>(owner('GET', `${base()}/settings`))).steps.find((x: any) => x.id === 'analyse').enabled,
    ).toBe(false);
  });
});

describe('prep run', () => {
  it('is refused while the switch is off, and for a member', async () => {
    const off = await owner('POST', `${base()}/runs`);
    expect(off.status).toBe(409);
    expect(off.body.error?.code ?? off.body.code).toBe('release_docs_prep_off');
    await enable();
    const m = await addMember(w, 'runner');
    expect((await w.t.req('POST', `${base()}/runs`, { cookie: m.cookie })).status).toBe(403);
    expect((await w.t.req('POST', `${base()}/skip`, { cookie: m.cookie })).status).toBe(403);
  });

  it('dispatches analyse, then commit prepare, then commit push, and passes', async () => {
    await enable();
    await runToPassed(PREP);
    const list = await cmds();
    expect(list.map((c: any) => `${c.payload.step}${c.payload.phase ? `:${c.payload.phase}` : ''}`)).toEqual([
      'analyse',
      'commit:prepare',
      'commit:push',
    ]);
    expect(list[1].payload.summary.commitCount).toBe(1);
    expect(list[1].payload.base).toEqual({ sha: 'b'.repeat(40), tag: 'v1.3.0' });
    const run = await latest();
    expect(run.status).toBe('passed');
    expect(run.repos[0]).toMatchObject({ baseTag: 'v1.3.0', commitSha: PREP, pushed: true });
    expect(run.repos[0].summary.commitCount).toBe(1);
  });

  it('refuses a second run while one is running', async () => {
    await enable();
    expect((await owner('POST', `${base()}/runs`)).status).toBe(202);
    const again = await owner('POST', `${base()}/runs`);
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain('release_docs_prep_running');
    expect((await q2(`SELECT 1 FROM release_docs_prep_runs WHERE status='running'`)).length).toBe(1);
  });

  it('two starts at once leave exactly one run', async () => {
    await enable();
    const [a, b] = await Promise.all([owner('POST', `${base()}/runs`), owner('POST', `${base()}/runs`)]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect((await q2(`SELECT 1 FROM release_docs_prep_runs`)).length).toBe(1);
  });

  it('a failed step fails the run before any commit; Retry starts a new run; both are audited', async () => {
    await enable();
    await owner('POST', `${base()}/runs`);
    await answer({ ok: false, state: 'failed', error: 'could not fetch', files: [], notices: [] });
    const run = await latest();
    expect(run.status).toBe('failed');
    expect(run.failed).toMatchObject({ step: 'analyse', error: 'could not fetch' });
    expect((await cmds()).map((c: any) => c.payload.step)).toEqual(['analyse']); // commit never dispatched
    // a late answer from the same workstation changes nothing
    await applyReleaseDocsPrepResult(
      w.t.app.ctx,
      w.workstationId,
      (await cmds())[0].payload,
      true,
      passedAnalyse,
      undefined,
    );
    expect((await latest()).status).toBe('failed');
    const retry = await owner('POST', `${base()}/runs/${run.id}/retry`);
    expect(retry.status).toBe(202);
    const started = await q2(`SELECT payload FROM events WHERE type='ReleaseDocsPrepStarted' ORDER BY seq`);
    expect(started.at(-1).payload).toMatchObject({
      trigger: 'retry',
      retryOf: run.id,
      startedBy: expect.anything(),
    });
    // retrying a run that is not the failed latest one is refused
    expect((await owner('POST', `${base()}/runs/${run.id}/retry`)).status).toBe(409);
  });

  it('Skip is owner/admin only, recorded with who and when, and not allowed after a pass', async () => {
    await enable();
    await owner('POST', `${base()}/runs`);
    await answer({ ok: false, state: 'failed', error: 'boom', files: [], notices: [] });
    expect((await owner('POST', `${base()}/skip`)).status).toBe(204);
    const run = await latest();
    expect(run.status).toBe('skipped');
    expect(run.skippedBy).toBeTruthy();
    expect(run.skippedAt).toBeTruthy();
    expect(await events('ReleaseDocsPrepSkipped')).toBe(1);
    expect((await owner('POST', `${base()}/skip`)).status).toBe(409);
  });

  it('Skip with no run records a skipped run', async () => {
    await enable();
    expect((await owner('POST', `${base()}/skip`)).status).toBe(204);
    expect((await latest()).status).toBe('skipped');
  });

  it('a step with no answer for 12 hours fails the run', async () => {
    await enable();
    await owner('POST', `${base()}/runs`);
    await q(
      `UPDATE release_docs_prep_steps SET started_at = now() - interval '13 hours' WHERE state='running'`,
    );
    await releaseDocsPrepSweep(w.t.app.ctx);
    const run = await latest();
    expect(run.status).toBe('failed');
    expect(run.failed.error).toContain('12 hours');
  });

  it('is refused while a release is approved for shipping', async () => {
    await enable();
    await q(
      `INSERT INTO release_proposals (id, org_id, project_id, repo_id, desk_item_id, state, trigger, recommended_version, recommended_level, reason, head_sha, created_at, updated_at)
       SELECT gen_random_uuid(), org_id, id, $2, gen_random_uuid(), 'approved', 'manual', '1.4.0', 'minor', 'x', $3, now(), now() FROM projects WHERE id=$1`,
      [w.projectId, w.repoId, HEAD],
    );
    const r = await owner('POST', `${base()}/runs`);
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('release_shipping');
  });
});

describe('the Update user guide step', () => {
  const lastPayload = async () => (await cmds()).at(-1)!.payload;

  it('refuses a run when the guide step is on but Analyse changes is unticked (409 release_docs_prep_requires)', async () => {
    await enable({ analyse: false, guide: true });
    const res = await owner('POST', `${base()}/runs`);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('release_docs_prep_requires');
    expect(JSON.stringify(res.body)).toContain(
      'Update user guide needs Analyse changes. Turn it on in the project settings.',
    );
  });

  it('with no writer agent on the workstation the guide step fails the run before any commit', async () => {
    await enable({ guide: true });
    await owner('POST', `${base()}/runs`);
    await answer(passedAnalyse);
    const run = await latest();
    expect(run.status).toBe('failed');
    const guide = run.repos[0].steps.find((s: any) => s.step === 'guide');
    expect(guide.state).toBe('failed');
    expect(guide.error).toContain('can write the release documentation');
    expect((await cmds()).map((c: any) => c.payload.step)).toEqual(['analyse']);
  });

  it('with no writer agent and two repositories the guide step fails in both and the run fails', async () => {
    const second = randomUUID();
    await q(
      `INSERT INTO project_repos (id, project_id, name, remote_url, remote_url_normalized, main_branch)
       VALUES ($1,$2,'zcloud','git@github.com:acme/zcloud.git','github.com/acme/zcloud','main')`,
      [second, w.projectId],
    );
    try {
      await markOnline(w.t, w.workstationId, { repoIds: [w.repoId, second] });
      await enable({ guide: true });
      expect((await owner('POST', `${base()}/runs`)).status).toBeLessThan(300);
      const analyse = await cmds();
      expect(analyse.map((c: any) => c.payload.repoId).sort()).toEqual([w.repoId, second].sort());
      for (const c of analyse)
        await applyReleaseDocsPrepResult(
          w.t.app.ctx,
          w.workstationId,
          c.payload,
          true,
          passedAnalyse,
          undefined,
        );
      const run = await latest();
      expect(run.status).toBe('failed');
      expect(run.repos).toHaveLength(2);
      for (const repo of run.repos) {
        const guide = repo.steps.find((s: any) => s.step === 'guide');
        expect(guide.state).toBe('failed');
        expect(guide.error).toMatch(
          /^no agent on the workstation that has .+ can write the release documentation$/,
        );
      }
      expect((await cmds()).map((c: any) => c.payload.step)).toEqual(['analyse', 'analyse']);
    } finally {
      await q(`TRUNCATE release_docs_prep_runs CASCADE`);
      await q(`UPDATE project_repos SET removed_at=now() WHERE id=$1`, [second]);
    }
  });

  it('dispatches the guide step with the preferred writer (architect before builder) and then the commit', async () => {
    await w.hire('Zed', 'builder', 'junior');
    const architect = await w.hire('Amy', 'architect', 'senior');
    await enable({ guide: true });
    await owner('POST', `${base()}/runs`);
    await answer(passedAnalyse);
    const payload = await lastPayload();
    expect(payload.step).toBe('guide');
    expect(payload.writer).toBeTruthy();
    expect(JSON.stringify(payload.writer)).toContain(architect.agent?.id ?? architect.id);
    expect(payload.stepInput.coveredSources).toEqual([]);
    await answer({ ok: true, state: 'passed', files: [], notices: [], output: { status: 'passed' } });
    expect((await lastPayload()).step).toBe('commit');
  });

  it('stores the step output, shows it in the run view, and hands its sources to the next run as coveredSources', async () => {
    await w.hire('Amy', 'architect', 'senior');
    await enable({ guide: true });
    await owner('POST', `${base()}/runs`);
    await answer(passedAnalyse);
    const output = {
      status: 'passed',
      changed: [{ section: '4.2 Cards', sources: ['card:TOY-1'] }],
      covered: [{ source: 'merge:' + 'c'.repeat(40), section: '4.3 Releases' }],
    };
    await answer({ ok: true, state: 'passed', files: ['docs/G.md'], notices: [], output });
    await answer({ ok: true, state: 'passed', files: [], notices: [] });
    await answer({ ok: true, state: 'passed', files: [], notices: [] });
    const first = await latest();
    expect(first.status).toBe('passed');
    const guide = first.repos[0].steps.find((s: any) => s.step === 'guide');
    expect(guide.output).toMatchObject({ status: 'passed', changed: [{ section: '4.2 Cards' }] });

    await owner('POST', `${base()}/runs`);
    await answer(passedAnalyse);
    const next = await lastPayload();
    expect(next.step).toBe('guide');
    expect(next.stepInput.coveredSources).toEqual(['card:TOY-1', 'merge:' + 'c'.repeat(40)]);
  });
});

describe('the ship gate', () => {
  it('off: the approval starts the ship as before', async () => {
    const res = await approveShip();
    expect(res.status).toBe(200);
    expect((await q2(`SELECT 1 FROM runner_commands WHERE type='release.ship'`)).length).toBe(1);
  });

  it('on with no run: the approval is refused naming release prep and rolled back', async () => {
    await enable();
    const approved = await events('ReleaseApproved');
    const res = await approveShip();
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('release_docs_prep_required');
    expect(JSON.stringify(res.body)).toContain('Release prep (docs and videos)');
    expect(JSON.stringify(res.body)).toContain('tab=prep');
    expect(await events('ReleaseApproved')).toBe(approved);
    expect((await q2(`SELECT 1 FROM runner_commands WHERE type='release.ship'`)).length).toBe(0);
    expect((await q2(`SELECT state FROM release_proposals`))[0].state).toBe('proposed');
  });

  it('on with a running or failed run: refused', async () => {
    await enable();
    await owner('POST', `${base()}/runs`);
    expect((await approveShip()).status).toBe(409);
    await answer({ ok: false, state: 'failed', error: 'boom', files: [], notices: [] });
    const res = await approveShip();
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('Retry or Skip');
  });

  it('on with a passed run whose commit is in the facts: the ship starts', async () => {
    await enable();
    await runToPassed(PREP);
    const res = await approveShip();
    expect(res.status).toBe(200);
    expect((await q2(`SELECT 1 FROM runner_commands WHERE type='release.ship'`)).length).toBe(1);
  });

  it('on with a passed run whose commit is not in the facts yet: refused with a Refresh hint', async () => {
    await enable();
    await runToPassed('f'.repeat(40));
    const res = await approveShip();
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('Refresh');
  });

  it('on with a passed run that committed nothing: the ship starts', async () => {
    await enable();
    await runToPassed();
    expect((await approveShip()).status).toBe(200);
  });

  it('Analyse changes unticked while Write changelog is on: the run is refused', async () => {
    await enable({ analyse: false, changelog: true });
    const res = await owner('POST', `${base()}/runs`);
    expect(res.status).toBe(409);
    expect(res.body.error?.code ?? res.body.code).toBe('release_docs_prep_requires');
    expect(await cmds()).toHaveLength(0);
  });

  it('on with Analyse changes unticked: a passed run does not need a recorded base tag', async () => {
    await enable({ analyse: false });
    expect((await owner('POST', `${base()}/runs`)).status).toBeLessThan(300);
    await answer({ ok: true, state: 'passed', files: [], notices: [] });
    await answer({ ok: true, state: 'passed', files: [], notices: [] });
    expect((await latest()).status).toBe('passed');
    expect((await approveShip()).status).toBe(200);
  });

  it('on and skipped: the ship starts exactly as today', async () => {
    await enable();
    await owner('POST', `${base()}/skip`);
    expect((await approveShip()).status).toBe(200);
  });

  async function publishNow() {
    await q(
      `INSERT INTO release_ships (id, org_id, project_id, repo_id, version, tag, release_date, payload, status, merge_sha, pr_url, published_at, created_at, updated_at)
       SELECT gen_random_uuid(), org_id, id, $2, '1.3.0', 'v1.3.0', current_date, '{}'::jsonb, 'published', $3, 'https://github.com/o/r/pull/3', now(), now(), now()
         FROM projects WHERE id=$1`,
      [w.projectId, w.repoId, 'c'.repeat(40)],
    );
  }

  it('after a published ship, an earlier passed run is no run: the overview does not read passed, Skip is accepted', async () => {
    await enable();
    await runToPassed();
    await publishNow();
    const overview = (await owner('GET', `/api/release-docs-prep`)).body as any[];
    const mine = overview.find((o) => o.projectId === w.projectId);
    expect(mine.state).toBe('not_run');
    expect(mine.run).toBeNull();
    expect(await latest()).toBeFalsy();
    expect((await approveShip()).status).toBe(409);
    expect((await owner('POST', `${base()}/skip`)).status).toBe(204);
    expect((await latest()).status).toBe('skipped');
    expect((await approveShip()).status).toBe(200);
  });

  it('after a published ship, an earlier skipped run can be skipped again for the next release', async () => {
    await enable();
    await owner('POST', `${base()}/skip`);
    await publishNow();
    expect((await approveShip()).status).toBe(409);
    expect((await owner('POST', `${base()}/skip`)).status).toBe(204);
    expect((await approveShip()).status).toBe(200);
  });

  it('adds the gate to the proposal view only when the switch is on', async () => {
    await approveShip(); // switch off: the ship starts and the proposal exists
    const proposal = (await q2(`SELECT * FROM release_proposals`))[0];
    expect(await releaseDocsPrepViewFor(w.t.app.ctx.pool, proposal)).toBeUndefined();
    await enable();
    const view = await releaseDocsPrepViewFor(w.t.app.ctx.pool, proposal);
    expect(view?.blocked).toBe(true);
    expect(view?.message).toContain('Release prep (docs and videos)');
    expect(view?.link).toContain(`release-docs-prep-${w.projectId}`);
  });
});

describe('Generate videos step', () => {
  const plan = (videos: unknown[], needsAuthoring: unknown[] = []) => ({
    ok: true,
    state: 'passed',
    files: [],
    notices: [],
    report: { harness: true, rule: 'rule', voice: 'Kokoro af_heart', videos, shared: [], unmapped: [], ignoredCount: 0, needsAuthoring },
  });
  const regen = { slug: 'backlog', action: 'regenerate', reasons: ['screen Backlog changed: x'], state: 'pending' };
  const tag = (c: any) => `${c.payload.step}${c.payload.phase ? `:${c.payload.phase}` : ''}`;
  const stepRows = () => q2(`SELECT step, phase, state, error, report FROM release_docs_prep_steps ORDER BY step, phase`);

  it('is off by default even with prep on', async () => {
    await enable();
    await owner('POST', `${base()}/runs`);
    expect((await latest()).steps).toEqual(['analyse', 'commit']);
  });

  it('runs plan, skips author with nothing new, hands the plan to render, then commits; the report is shown', async () => {
    await enable({ videos: true });
    await owner('POST', `${base()}/runs`);
    await answer(passedAnalyse);
    await answer(plan([regen]));
    const render = await cmds();
    expect(render.map(tag)).toEqual(['analyse', 'videos:plan', 'videos:render']);
    const input = render[2].payload.input;
    expect(input.authored).toEqual([]);
    expect(input.plan.videos[0].slug).toBe('backlog');
    const author = (await stepRows()).find((r: any) => r.phase === 'author');
    expect(author.state).toBe('skipped');
    expect(author.error).toBe('no new videos');
    await answer({
      ok: true,
      state: 'passed',
      files: ['media/videos/backlog.webm'],
      notices: [],
      report: { harness: true, videos: [{ ...regen, state: 'rendered' }] },
    });
    expect((await cmds()).map(tag).slice(3)).toEqual(['commit:prepare']);
    const run = await latest();
    const steps = run.repos[0].steps;
    expect(steps.map((s: any) => `${s.step}:${s.phase}`)).toEqual([
      'analyse:',
      'videos:plan',
      'videos:author',
      'videos:render',
      'commit:prepare',
      'commit:push',
    ]);
    expect(steps.find((s: any) => s.phase === 'render').report.videos[0].state).toBe('rendered');
  });

  it("skips author and render in a repo with no harness ('skipped: no videos') and still commits", async () => {
    await enable({ videos: true });
    await owner('POST', `${base()}/runs`);
    await answer(passedAnalyse);
    await answer({ ok: true, state: 'skipped', error: 'skipped: no videos', files: [], notices: [], report: { harness: false } });
    expect((await cmds()).map(tag)).toEqual(['analyse', 'videos:plan', 'commit:prepare']);
    const rows = (await stepRows()).filter((r: any) => r.step === 'videos');
    expect(rows.map((r: any) => [r.phase, r.state, r.error])).toEqual([
      ['author', 'skipped', 'skipped: no videos'],
      ['plan', 'skipped', 'skipped: no videos'],
      ['render', 'skipped', 'skipped: no videos'],
    ]);
  });

  it("fails the run on 'voice unavailable': no render, no commit, ship stays blocked", async () => {
    await enable({ videos: true });
    await owner('POST', `${base()}/runs`);
    await answer(passedAnalyse);
    await answer({
      ok: true,
      state: 'failed',
      error: 'voice unavailable: Kokoro af_heart is not installed on ws',
      files: [],
      notices: [],
    });
    expect((await cmds()).map(tag)).toEqual(['analyse', 'videos:plan']);
    const run = await latest();
    expect(run.status).toBe('failed');
    expect(run.failed.error).toContain('voice unavailable');
    expect((await approveShip()).status).toBe(409);
  });

  it('fails the author phase naming each new video that has no script writer yet', async () => {
    await enable({ videos: true });
    await owner('POST', `${base()}/runs`);
    await answer(passedAnalyse);
    await answer(
      plan(
        [{ slug: 'forms', action: 'create', reasons: ['new screen'], state: 'pending' }],
        [{ slug: 'forms', title: 'Forms', pages: ['apps/web/src/pages/Forms.tsx'], reasons: ['new screen'] }],
      ),
    );
    expect((await cmds()).map(tag)).toEqual(['analyse', 'videos:plan']);
    const run = await latest();
    expect(run.status).toBe('failed');
    expect(run.failed.error).toContain('forms: could not write the video script');
  });

  it('stores a failed render report naming the video and its error', async () => {
    await enable({ videos: true });
    await owner('POST', `${base()}/runs`);
    await answer(passedAnalyse);
    await answer(plan([regen]));
    await answer({
      ok: true,
      state: 'failed',
      error: '1 video(s) failed: backlog: selector not found',
      files: [],
      notices: [],
      report: { harness: true, videos: [{ ...regen, state: 'failed', error: 'selector not found\nstack' }] },
    });
    const run = await latest();
    expect(run.status).toBe('failed');
    expect(run.failed.error).toContain('backlog: selector not found');
    const r = run.repos[0].steps.find((s: any) => s.phase === 'render');
    expect(r.report.videos[0].error).toContain('selector not found');
    expect((await cmds()).map(tag)).not.toContain('commit:prepare');
  });
});
