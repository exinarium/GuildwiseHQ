import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, E2E_DIR, paths } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';

// Release prep (docs and videos): the per-project switch, a run with "Analyse changes" and "Commit results" on a
// project with two repositories, the ship gate, failure, Retry and Skip. Own owner, own guest member, own runner (mock)
// and two local origins: alpha (tag v1.0.0 on main, two commits and a merge on release/1.1) and beta (no tag, one commit
// on release/1.1). No forge is contacted: the ship lands by merge and publishes with no release page.
test.describe.configure({ mode: 'serial' });

const OWNER = { email: 'prepper@e2e.test', name: 'E2E Prepper', password: 'prepper-password-12345' };
const GUEST = { email: 'prepguest@e2e.test', name: 'E2E PrepGuest', password: 'prepguest-password-12345' };
const BRANCH = 'release/1.1';
const DIR = join(E2E_DIR, 'docs-prep');
const ORIGINS = join(DIR, 'origin');
const SEEDS = join(DIR, 'seed');
const CLONES = join(DIR, 'repos');
const HOME = paths.runnerHome('docs-prep');
const origin = (name: string) => join(ORIGINS, `${name}.git`);
const NAME = 'Release prep (docs and videos)';

let owner: APIRequestContext;
let guest: APIRequestContext;
let page: Page;
let guestPage: Page;
let projectId: string;
const repoIds: Record<string, string> = {};

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Someone Else',
  GIT_AUTHOR_EMAIL: 'else@e2e.test',
  GIT_COMMITTER_NAME: 'Someone Else',
  GIT_COMMITTER_EMAIL: 'else@e2e.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv }).trim();
const originSha = (name: string, ref = BRANCH): string | null => {
  try {
    return git(origin(name), 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`);
  } catch {
    return null;
  }
};

function seedRepo(name: string, build: (cwd: string) => void): void {
  execFileSync('git', ['init', '--bare', '-b', 'main', origin(name)], { stdio: 'ignore' });
  const cwd = join(SEEDS, name);
  execFileSync('git', ['clone', origin(name), cwd], { stdio: 'ignore', env: gitEnv });
  git(cwd, 'checkout', '-b', 'main');
  writeFileSync(join(cwd, 'README.md'), `# ${name}\n`);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'Initial commit');
  build(cwd);
  git(cwd, 'push', '--tags', 'origin', 'main', BRANCH);
}

const json = async (r: { json(): Promise<unknown> }) => (await r.json()) as any;

interface RunRow {
  id: string;
  status: string;
  trigger: string;
  retry_of: string | null;
  started_by: string | null;
  failed_step: string | null;
  failed_repo_id: string | null;
  error: string | null;
  skipped_by: string | null;
  skipped_at: Date | null;
}
const runs = () =>
  q<RunRow>('SELECT * FROM release_docs_prep_runs WHERE project_id=$1 ORDER BY started_at', [projectId]);
const lastRun = async () => (await runs()).at(-1);
const runWhen = (what: string, pred: (r: RunRow | undefined) => boolean, ms = 90_000) =>
  waitFor(what, lastRun, pred, ms) as Promise<RunRow>;
const userId = async (email: string) =>
  (await q<{ id: string }>('SELECT id FROM users WHERE email=$1', [email]))[0]!.id;

/** The open Ship release proposal of a repository (asked with "Prepare release" when none is live yet). */
async function proposalFor(
  repo: string,
): Promise<{ id: string; desk_item_id: string; recommended_version: string }> {
  const live = () =>
    q<{ id: string; desk_item_id: string; recommended_version: string; state: string }>(
      `SELECT * FROM release_proposals WHERE repo_id=$1 AND state='proposed'`,
      [repoIds[repo]],
    );
  if ((await live()).length === 0) {
    const r = await owner.post(`/api/projects/${projectId}/repos/${repoIds[repo]}/release-proposal`, {
      data: {},
    });
    expect([202, 409], await r.text()).toContain(r.status());
  }
  return (await waitFor(`a Ship release proposal for ${repo}`, live, (p) => p.length === 1, 60_000))[0]!;
}

async function factsHead(repo: string): Promise<string> {
  const f = await waitFor(
    `release facts of ${repo}`,
    () =>
      q<{ state: string; facts: { headSha: string } | null }>(
        'SELECT state, facts FROM repo_release_facts WHERE project_repo_id=$1',
        [repoIds[repo]],
      ),
    (r) => r[0]?.state === 'ready' && !!r[0].facts?.headSha,
    60_000,
  );
  return f[0]!.facts!.headSha;
}

/** Approves the Ship release item through the API, as the Approve button does. */
async function approveShip(repo: string) {
  const p = await proposalFor(repo);
  return owner.post(`/api/desk/${p.desk_item_id}/resolve`, {
    data: {
      resolution: 'approved',
      release: { version: p.recommended_version, components: [], factsHeadSha: await factsHead(repo) },
    },
  });
}

const shipOf = (repo: string) =>
  q<{ status: string; version: string; commit_sha: string | null }>(
    'SELECT * FROM release_ships WHERE repo_id=$1 ORDER BY created_at DESC NULLS LAST',
    [repoIds[repo]],
  );

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, OWNER);
  await inviteAndAccept(admin, GUEST);
  owner = await apiAs(OWNER.email, OWNER.password);
  guest = await apiAs(GUEST.email, GUEST.password);
  page = await (await browser.newContext({ storageState: await owner.storageState() })).newPage();
  guestPage = await (await browser.newContext({ storageState: await guest.storageState() })).newPage();
});

test('setup: two origins with a release branch, a paired mock runner holding both, project REL, a guest member', async () => {
  for (const d of [ORIGINS, SEEDS, CLONES]) mkdirSync(d, { recursive: true });
  seedRepo('alpha', (cwd) => {
    git(cwd, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
    git(cwd, 'checkout', '-b', 'REL-1-search');
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src/search.js'), 'export const search = () => [];\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'Add search (REL-1)');
    git(cwd, 'checkout', '-b', BRANCH, 'main');
    git(cwd, 'merge', '--no-ff', '-m', 'Merge pull request #7 from team/REL-1-search', 'REL-1-search');
    writeFileSync(join(cwd, 'README.md'), '# alpha\n\nNow with search.\n');
    git(cwd, 'commit', '-am', 'Describe search in the readme');
  });
  seedRepo('beta', (cwd) => {
    git(cwd, 'checkout', '-b', BRANCH);
    mkdirSync(join(cwd, 'api'), { recursive: true });
    writeFileSync(join(cwd, 'api/handler.js'), 'export const handler = () => 200;\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'Add the api handler (REL-2)');
  });
  for (const name of ['alpha', 'beta'])
    execFileSync('git', ['clone', origin(name), join(CLONES, name)], { stdio: 'ignore', env: gitEnv });

  const code = (await json(await owner.post('/api/workstations/pairing-codes', { data: {} }))).code as string;
  pairRunner(BASE_URL, code, 'Prep Box', HOME);
  addRepoRoot(CLONES, HOME);
  startRunner({ AOM_MOCK_STEP_MS: '200' }, HOME);
  await waitFor(
    'runner connected',
    async () => (await json(await owner.get('/api/workstations'))).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  const devops = (await json(await owner.get('/api/agents'))).agents.find(
    (a: { isDevops: boolean }) => a.isDevops,
  );
  if (devops)
    expect(
      (await owner.patch(`/api/agents/${devops.id}`, { data: { runtime: 'mock', model: 'mock' } })).status(),
    ).toBe(200);

  const proj = await owner.post('/api/projects', { data: { key: 'REL', name: 'Release project' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await json(proj)).project.id;
  for (const name of ['alpha', 'beta']) {
    const add = await owner.post(`/api/projects/${projectId}/repos`, {
      data: { name, remoteUrl: origin(name), workingBranch: BRANCH, mainBranch: 'main' },
    });
    expect(add.status(), await add.text()).toBe(201);
    repoIds[name] = (await json(add)).repos.find((r: { name: string }) => r.name === name).id;
  }
  const commitAs = await owner.put(`/api/projects/${projectId}/commit-as`, {
    data: { commitAs: { name: 'Release Bot', email: 'release-bot@e2e.test' } },
  });
  expect(commitAs.status(), await commitAs.text()).toBe(200);
  await waitFor(
    'the workstation holds alpha and beta',
    async () => (await json(await owner.get('/api/workstations'))).workstations[0].repos.length,
    (n) => n === 2,
    60_000,
  );

  // a guest member of the project: not its owner and no role in the owner's organization
  const share = await owner.post(`/api/projects/${projectId}/members`, { data: { email: GUEST.email } });
  expect(share.ok(), await share.text()).toBeTruthy();
  const accept = await guest.post(`/api/projects/${projectId}/members/accept`, { data: {} });
  expect(accept.ok(), await accept.text()).toBeTruthy();
});

test('AC1: a new project has release prep off; Releases has no Release prep tab and Ship release reads as before', async () => {
  const row = (
    await q<{ release_docs_prep: unknown }>('SELECT release_docs_prep FROM projects WHERE id=$1', [projectId])
  )[0]!;
  expect(row.release_docs_prep).toEqual({ enabled: false, steps: {} });
  const s = await json(await owner.get(`/api/projects/${projectId}/release-docs-prep/settings`));
  expect(s.enabled).toBe(false);
  expect(s.canEdit).toBe(true);
  expect((await json(await owner.get('/api/release-docs-prep'))) as unknown[]).toEqual([]);

  await page.goto('/delivery/releases');
  await expect(page.getByTestId('releases-tab-waiting')).toBeVisible();
  await expect(page.getByTestId('releases-tab-prep')).toHaveCount(0);

  const p = await proposalFor('alpha');
  await factsHead('alpha');
  await page.goto('/desk');
  const item = page.getByTestId(`desk-item-${p.desk_item_id}`);
  await expect(item.getByTestId('ship-release')).toBeVisible();
  await expect(item.getByRole('button', { name: /^Approve release/ })).toBeEnabled();
  await expect(item.getByTestId('ship-docs-prep-blocked')).toHaveCount(0);
  await expect(item).not.toContainText('Release prep');
});

test('AC2: a member sees the settings read-only and gets 403 on settings, run, retry and skip', async () => {
  const s = await json(await guest.get(`/api/projects/${projectId}/release-docs-prep/settings`));
  expect(s.canEdit).toBe(false);
  const put = await guest.put(`/api/projects/${projectId}/release-docs-prep/settings`, {
    data: { enabled: true, steps: {} },
  });
  expect(put.status(), await put.text()).toBe(403);
  expect((await guest.post(`/api/projects/${projectId}/release-docs-prep/runs`, { data: {} })).status()).toBe(
    403,
  );
  expect((await guest.post(`/api/projects/${projectId}/release-docs-prep/skip`, { data: {} })).status()).toBe(
    403,
  );
  const retry = await guest.post(
    `/api/projects/${projectId}/release-docs-prep/runs/00000000-0000-4000-8000-000000000000/retry`,
    { data: {} },
  );
  expect(retry.status()).toBe(403);
  // a stranger to the project gets 404, not 403
  const stranger = await apiAs(ADMIN.email, ADMIN.password);
  expect((await stranger.get(`/api/projects/${projectId}/release-docs-prep/settings`)).status()).toBe(404);

  await guestPage.goto(`/projects/${projectId}/settings`);
  const panel = guestPage.getByTestId('release-docs-prep-settings');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('release-docs-prep-readonly')).toBeVisible();
  await expect(panel.getByRole('switch')).toBeDisabled();
  await expect(panel.getByRole('checkbox', { name: /^Analyse changes/ })).toBeDisabled();
  expect(
    (
      await q<{ release_docs_prep: { enabled: boolean } }>(
        'SELECT release_docs_prep FROM projects WHERE id=$1',
        [projectId],
      )
    )[0]!.release_docs_prep.enabled,
  ).toBe(false);
});

test('AC2/AC9: the owner switches release prep on; the checklist lists only the registered steps', async () => {
  await page.goto(`/projects/${projectId}/settings`);
  const panel = page.getByTestId('release-docs-prep-settings');
  await expect(panel.getByTestId('release-docs-prep-readonly')).toHaveCount(0);
  const labels = (await panel.locator('fieldset label').allInnerTexts()).map((t) => t.split('\n')[0]!.trim());
  expect(labels).toEqual(['Analyse changes', 'Write changelog', 'Update user guide', 'Generate videos', 'Commit results']);
  const sw = panel.getByRole('switch', { name: 'Run release prep before a release ships' });
  await expect(sw).not.toBeChecked();
  await sw.check();
  await waitFor(
    'release prep switched on',
    async () =>
      (
        await q<{ release_docs_prep: { enabled: boolean; steps: Record<string, boolean> } }>(
          'SELECT release_docs_prep FROM projects WHERE id=$1',
          [projectId],
        )
      )[0]!.release_docs_prep,
    (s) => s.enabled === true,
    15_000,
  ).then((s) => expect(s.steps).toEqual({ analyse: true, changelog: true, guide: true, videos: false, commit: true }));
  // the runs below use Analyse and Commit only (the mock runner has no writer agent for the guide)
  const narrow = await owner.put(`/api/projects/${projectId}/release-docs-prep/settings`, {
    data: { enabled: true, steps: { analyse: true, changelog: false, guide: false, videos: false, commit: true } },
  });
  expect(narrow.status()).toBe(200);
  const ev = await q<{ actor_id: string }>(
    `SELECT actor_id FROM events WHERE type='ReleaseDocsPrepSettingsSet' AND project_id=$1`,
    [projectId],
  );
  const ownerId = await userId(OWNER.email);
  expect(ev.length).toBeGreaterThanOrEqual(1);
  expect(new Set(ev.map((e) => e.actor_id))).toEqual(new Set([ownerId]));
  // an unknown step id is refused
  const bad = await owner.put(`/api/projects/${projectId}/release-docs-prep/settings`, {
    data: { enabled: true, steps: { videos_from_mars: true } },
  });
  expect(bad.status()).toBe(400);
});

test('AC3: with prep on and no run, the server refuses the ship naming release prep; the item links to the prep status', async () => {
  const refused = await approveShip('alpha');
  expect(refused.status(), await refused.text()).toBe(409);
  const body = await json(refused);
  expect(JSON.stringify(body)).toContain('release_docs_prep_required');
  expect(JSON.stringify(body)).toContain(NAME);
  expect((await shipOf('alpha')).length).toBe(0);
  expect(
    (await q(`SELECT 1 FROM release_proposals WHERE repo_id=$1 AND state='approved'`, [repoIds.alpha]))
      .length,
  ).toBe(0);

  const p = await proposalFor('alpha');
  await page.goto('/desk');
  const item = page.getByTestId(`desk-item-${p.desk_item_id}`);
  const blocked = item.getByTestId('ship-docs-prep-blocked');
  await expect(blocked).toContainText(NAME);
  await expect(item.getByRole('button', { name: /^Approve release/ })).toBeDisabled();
  await blocked.getByRole('link', { name: 'See release prep' }).click();
  await expect(page).toHaveURL(/tab=prep/);
  const prep = page.getByTestId('release-docs-prep-REL');
  await expect(prep).toBeVisible();
  await expect(prep.getByTestId('release-docs-prep-state')).toHaveText('not run');
  await expect(prep.getByRole('button', { name: 'Run release prep' })).toBeVisible();
});

test('AC4/AC5/AC8: Run release prep analyses both repositories; a second run is refused; nothing to commit, so no commit', async () => {
  const before = { alpha: originSha('alpha'), beta: originSha('beta') };
  await page.goto('/delivery/releases?tab=prep');
  const prep = page.getByTestId('release-docs-prep-REL');
  await prep.getByRole('button', { name: 'Run release prep' }).click();
  // a second start for the same release while the first runs is refused with a clear message
  const second = await owner.post(`/api/projects/${projectId}/release-docs-prep/runs`, { data: {} });
  const run = await lastRun();
  if (run?.status === 'running') {
    expect(second.status(), await second.text()).toBe(409);
    expect(JSON.stringify(await json(second))).toContain('already running');
  } else {
    // the first run finished before the second request arrived: then the second is a normal new run
    expect(second.status(), await second.text()).toBe(202);
  }
  expect(
    (await q(`SELECT 1 FROM release_docs_prep_runs WHERE project_id=$1 AND status='running'`, [projectId]))
      .length,
  ).toBeLessThanOrEqual(1);
  const done = await runWhen('the prep run passes', (r) => r?.status === 'passed' || r?.status === 'failed');
  expect(done.status, done.error ?? '').toBe('passed');

  await expect(prep.getByTestId('release-docs-prep-state')).toHaveText('passed');
  const alpha = prep.getByTestId('prep-repo-alpha');
  const beta = prep.getByTestId('prep-repo-beta');
  await expect(alpha.getByTestId('prep-summary')).toContainText('2 commits since v1.0.0');
  await expect(beta.getByTestId('prep-summary')).toContainText('1 commits since main');
  await alpha.getByTestId('prep-summary').locator('summary').click();
  await expect(alpha.getByTestId('prep-summary')).toContainText('Cards: REL-1');
  await expect(alpha.getByTestId('prep-summary')).toContainText('Add search (REL-1)');
  await expect(alpha.getByTestId('prep-summary')).toContainText('src: 1 files (1 added');
  await expect(alpha).toContainText('No changes: nothing was committed.');
  await expect(beta).toContainText('No changes: nothing was committed.');
  await expect(prep.getByTestId('prep-commit')).toHaveCount(0);

  const repos = await q<{
    repo_id: string;
    state: string;
    base_tag: string | null;
    summary: any;
    commit_sha: string | null;
    pushed: boolean;
  }>('SELECT * FROM release_docs_prep_repos WHERE run_id=$1', [done.id]);
  const byId = Object.fromEntries(repos.map((r) => [r.repo_id, r]));
  expect(byId[repoIds.alpha!]!.summary.commitCount).toBe(2);
  expect(byId[repoIds.alpha!]!.summary.base).toMatchObject({ kind: 'tag', tag: 'v1.0.0' });
  expect(byId[repoIds.alpha!]!.summary.merges[0]).toMatchObject({ prNumber: 7, cardKeys: ['REL-1'] });
  expect(byId[repoIds.beta!]!.summary.commitCount).toBe(1);
  expect(byId[repoIds.beta!]!.summary.base).toMatchObject({ kind: 'main', branch: 'main' });
  for (const r of repos) {
    expect(r.state).toBe('passed');
    expect(r.commit_sha).toBeNull();
  }
  const steps = await q<{ repo_id: string; step: string; phase: string; state: string }>(
    'SELECT repo_id, step, phase, state FROM release_docs_prep_steps WHERE run_id=$1 ORDER BY step, phase',
    [done.id],
  );
  expect(new Set(steps.map((s) => `${s.step}/${s.phase}`))).toEqual(
    new Set(['analyse/', 'commit/prepare', 'commit/push']),
  );
  expect(steps.every((s) => s.state === 'passed')).toBe(true);
  // a repository with no produced file gets no commit: both release branches are where they were
  expect({ alpha: originSha('alpha'), beta: originSha('beta') }).toEqual(before);
});

test('AC6: after the passed run the existing ship flow starts and completes as today', async () => {
  test.setTimeout(240_000);
  const p = await proposalFor('alpha');
  await page.goto('/desk');
  const item = page.getByTestId(`desk-item-${p.desk_item_id}`);
  await expect(item.getByTestId('ship-release')).toBeVisible();
  await expect(item.getByTestId('ship-docs-prep-blocked')).toHaveCount(0);
  const approve = item.getByRole('button', { name: /^Approve release/ });
  await expect(approve).toBeEnabled();
  await approve.click();
  const ship = await waitFor(
    'the alpha release is published',
    () => shipOf('alpha'),
    (s) => s[0]?.status === 'published' || s[0]?.status === 'failed',
    180_000,
  );
  expect(ship[0]!.status).toBe('published');
  expect(git(origin('alpha'), 'tag', '--list', `v${ship[0]!.version}`)).toBe(`v${ship[0]!.version}`);
  expect(git(origin('alpha'), 'log', '-1', '--format=%an <%ae>', `refs/heads/${BRANCH}`)).toBe(
    'Release Bot <release-bot@e2e.test>',
  );
  await waitFor(
    'the alpha proposal is closed',
    () => q<{ state: string }>('SELECT state FROM release_proposals WHERE id=$1', [p.id]),
    (r) => r[0]?.state !== 'proposed' && r[0]?.state !== 'approved',
    60_000,
  );
});

test('AC7: a step that fails in one repository commits nothing anywhere, keeps the ship blocked, and shows step, repo and error; Retry starts a new run', async () => {
  test.setTimeout(240_000);
  // beta ships next; ask for its proposal while its release branch is intact
  const pb = await proposalFor('beta');
  await factsHead('beta');
  // the analyse step in alpha fails: its origin cannot be fetched (a release branch that is merely missing on origin
  // is skipped for that repository by design, so the origin itself is moved away)
  const alphaSha = originSha('alpha')!;
  const betaBefore = originSha('beta');
  renameSync(origin('alpha'), `${origin('alpha')}.away`);

  await page.goto('/delivery/releases?tab=prep');
  const prep = page.getByTestId('release-docs-prep-REL');
  await prep.getByRole('button', { name: 'Run release prep' }).click();
  const failed = await runWhen('the prep run fails', (r) => r?.status === 'failed' && r.trigger === 'manual');
  expect(failed.failed_step).toBe('analyse');
  expect(failed.failed_repo_id).toBe(repoIds.alpha);
  expect(failed.error).toContain('could not fetch');
  await expect(prep.getByTestId('release-docs-prep-state')).toHaveText('failed');
  await expect(prep.getByTestId('release-docs-prep-failed')).toContainText('Failed at analyse in alpha');
  // the commit step never started in any repository (its rows stay as planned, no command was sent)
  const commitSteps = await q<{ state: string; command_id: string | null }>(
    `SELECT state, command_id FROM release_docs_prep_steps WHERE run_id=$1 AND step='commit'`,
    [failed.id],
  );
  expect(commitSteps.length).toBe(4);
  for (const s of commitSteps) {
    expect(['pending', 'skipped']).toContain(s.state);
    expect(s.command_id).toBeNull();
  }
  expect(originSha('beta')).toBe(betaBefore);
  expect(
    (await q(`SELECT 1 FROM release_docs_prep_repos WHERE run_id=$1 AND commit_sha IS NOT NULL`, [failed.id]))
      .length,
  ).toBe(0);

  const refused = await approveShip('beta');
  expect(refused.status(), await refused.text()).toBe(409);
  expect(JSON.stringify(await json(refused))).toContain('release_docs_prep_required');
  await page.goto('/desk');
  await expect(
    page.getByTestId(`desk-item-${pb.desk_item_id}`).getByTestId('ship-docs-prep-blocked'),
  ).toContainText(NAME);

  // a member cannot retry the failed run
  expect(
    (
      await guest.post(`/api/projects/${projectId}/release-docs-prep/runs/${failed.id}/retry`, { data: {} })
    ).status(),
  ).toBe(403);
  await page.goto('/delivery/releases?tab=prep');
  await prep.getByRole('button', { name: 'Retry prep' }).click();
  const retried = await runWhen(
    'the retry finishes',
    (r) => r?.trigger === 'retry' && r.status !== 'running',
  );
  expect(retried.id).not.toBe(failed.id);
  expect(retried.retry_of).toBe(failed.id);
  expect(retried.status).toBe('failed');
  expect(retried.started_by).toBe(await userId(OWNER.email));
  const started = await q<{ actor_id: string; payload: { trigger: string } }>(
    `SELECT actor_id, payload FROM events WHERE type='ReleaseDocsPrepStarted' AND payload->>'runId'=$1`,
    [retried.id],
  );
  expect(started).toEqual([
    { actor_id: await userId(OWNER.email), payload: expect.objectContaining({ trigger: 'retry' }) },
  ]);
  await expect(prep.getByTestId('release-docs-prep-run')).toContainText('a retry');
  // put alpha's origin back: the failed runs never touched its release branch
  renameSync(`${origin('alpha')}.away`, origin('alpha'));
  expect(originSha('alpha')).toBe(alphaSha);
});

test('AC7: Skip prep for this release is recorded with who and when and lets the existing ship run', async () => {
  test.setTimeout(240_000);
  await page.goto('/delivery/releases?tab=prep');
  const prep = page.getByTestId('release-docs-prep-REL');
  await prep.getByRole('button', { name: 'Skip prep for this release' }).click();
  await page.getByRole('button', { name: 'Skip prep' }).click();
  await expect(prep.getByTestId('release-docs-prep-state')).toHaveText('skipped');
  const run = await runWhen('the run is skipped', (r) => r?.status === 'skipped');
  expect(run.skipped_by).toBe(await userId(OWNER.email));
  expect(run.skipped_at).toBeTruthy();
  const ev = await q<{ actor_id: string; payload: { wasStatus: string; skippedBy: string } }>(
    `SELECT actor_id, payload FROM events WHERE type='ReleaseDocsPrepSkipped' AND project_id=$1`,
    [projectId],
  );
  expect(ev.length).toBe(1);
  expect(ev[0]!.actor_id).toBe(await userId(OWNER.email));
  expect(ev[0]!.payload.wasStatus).toBe('failed');
  // skipping twice is refused
  expect((await owner.post(`/api/projects/${projectId}/release-docs-prep/skip`, { data: {} })).status()).toBe(
    409,
  );

  const pb = await proposalFor('beta');
  await page.goto('/desk');
  const item = page.getByTestId(`desk-item-${pb.desk_item_id}`);
  await expect(item.getByTestId('ship-docs-prep-blocked')).toHaveCount(0);
  const approve = item.getByRole('button', { name: /^Approve release/ });
  await expect(approve).toBeEnabled();
  await approve.click();
  const ship = await waitFor(
    'the beta release is published',
    () => shipOf('beta'),
    (s) => s[0]?.status === 'published' || s[0]?.status === 'failed',
    180_000,
  );
  expect(ship[0]!.status).toBe('published');
});
