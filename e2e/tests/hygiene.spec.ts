import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { pool, q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, E2E_DIR, HYGIENER, paths } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';
import { expandWorkstation } from '../support/ui.ts';

// DevOps repository hygiene and the working branch (docs/design/phases.md addendum): one user, one runner (mock runtime),
// project HYG on its own repository `notes-app` whose working branch is NOT confirmed (like TEST01's). The mock DevOps
// engineer runs the real `aom hygiene run` against that repository. No Claude or GitHub is contacted.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('hygiene');
const DIR = join(E2E_DIR, 'hygiene');
const ORIGIN = join(DIR, 'origin/notes-app.git');
const ROOT = join(DIR, 'repos');
const CLONE = join(ROOT, 'notes-app');
let page: Page;
let api: APIRequestContext;
let workstationId: string;
let projectId: string;
let repoId: string;

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.name=Notes', '-c', 'user.email=notes@e2e.test', ...a], {
    cwd,
    encoding: 'utf8',
  }).trim();
const originHead = (branch = 'trunk') => git(ORIGIN, 'rev-parse', branch);
const repoRow = async () =>
  (
    await q<{ working_branch: string | null; known_branches: string[] }>(
      `SELECT working_branch, known_branches FROM project_repos WHERE id=$1`,
      [repoId],
    )
  )[0];
const requests = () =>
  q<{ id: string; status: string; hygiene: { trigger: string } }>(
    `SELECT id, status, hygiene FROM devops_requests WHERE hygiene IS NOT NULL ORDER BY created_at`,
  );
const questions = (status = 'open') =>
  q<{
    id: string;
    title: string;
    blocking: boolean;
    pinned: boolean;
    options: Array<{ id: string; label: string }>;
    data: any;
  }>(
    // this spec's project only: the phases spec leaves its own working-branch questions in the database
    `SELECT id, title, blocking, pinned, options, data FROM desk_items WHERE subkind='working_branch' AND status=$1 AND project_id=$2 ORDER BY created_at`,
    [status, projectId],
  );

/** Clicks "Run hygiene now" and waits until the new request is done. */
async function runHygiene(): Promise<{ id: string; status: string }> {
  const before = (await requests()).length;
  await page.goto('/workstations');
  await expandWorkstation(page.getByTestId('workstation-Hygiene Box'));
  await page.getByRole('button', { name: 'Run hygiene now' }).click();
  await expect(page.getByText(/Hygiene run requested|already queued or running/)).toBeVisible();
  const list = await waitFor(
    'the hygiene request finished',
    requests,
    (r) => r.length > before && r.slice(before).every((x) => x.status === 'done' || x.status === 'failed'),
    90_000,
  );
  return list[list.length - 1] as { id: string; status: string };
}

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, HYGIENER);
  api = await apiAs(HYGIENER.email, HYGIENER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});
test.afterAll(async () => {
  await pool.end();
});

test('setup: a runner holding notes-app, whose working branch is not confirmed, and project HYG', async () => {
  mkdirSync(join(DIR, 'origin'), { recursive: true });
  mkdirSync(ROOT, { recursive: true });
  // no main or master: in simple mode a repository with one of them has its working branch confirmed without asking
  git(DIR, 'init', '--bare', '-b', 'trunk', ORIGIN);
  git(DIR, 'clone', ORIGIN, CLONE);
  git(CLONE, 'checkout', '-b', 'trunk');
  writeFileSync(join(CLONE, 'README.md'), '# Notes\n');
  git(CLONE, 'add', '.');
  git(CLONE, 'commit', '-m', 'Initial commit');
  git(CLONE, 'push', '-u', 'origin', 'trunk');
  git(CLONE, 'branch', 'develop');
  git(CLONE, 'push', 'origin', 'develop');

  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Hygiene Box', HOME);
  addRepoRoot(ROOT, HOME);
  startRunner({ AOM_MOCK_STEP_MS: '200', AOM_MOCK_CHAT_TOKEN_MS: '20' }, HOME);
  const ws = await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  workstationId = ws[0].id;
  const proj = await api.post('/api/projects', { data: { key: 'HYG', name: 'Hygiene project' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  // no workingBranch: it has not been confirmed
  const add = await api.post(`/api/projects/${projectId}/repos`, {
    data: { name: 'notes-app', remoteUrl: ORIGIN },
  });
  expect(add.status(), await add.text()).toBe(201);
  repoId = (await add.json()).repos[0].id;
  expect((await repoRow())?.working_branch).toBeNull();
  await waitFor(
    'the workstation holds notes-app',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].repos.length,
    (n) => n === 1,
    30_000,
  );
  await waitFor(
    'DevOps engineer uses the mock runtime',
    async () => (await (await api.get('/api/agents')).json()).agents as any[],
    (a) => a.some((x) => x.isDevops && x.runtime === 'mock'),
    30_000,
  );
});

test('AC1: while the working branch is unset, hygiene reports the uncommitted changes and asks the manager; nothing is committed or pushed', async () => {
  writeFileSync(join(CLONE, 'todo.md'), 'unsaved work\n');
  writeFileSync(join(CLONE, 'README.md'), '# Notes\n\nedited\n');
  const head = originHead();
  const localHead = git(CLONE, 'rev-parse', 'HEAD');

  await page.goto('/workstations');
  await expandWorkstation(page.getByTestId('workstation-Hygiene Box'));
  const card = page.getByTestId('hygiene-Hygiene Box');
  await expect(card.getByLabel('Run')).toHaveValue('24'); // daily by default
  await expect(card.getByTestId('hygiene-status')).toContainText('Not run yet');
  const run = await runHygiene();
  expect(run.status).toBe('done');

  expect(originHead()).toBe(head);
  expect(git(CLONE, 'rev-parse', 'HEAD')).toBe(localHead);
  expect(git(CLONE, 'status', '--porcelain')).toContain('todo.md');

  const [q1] = await waitFor('the working-branch question', questions, (r) => r.length === 1);
  // the missing branch holds back a commit: blocking, so it reaches the manager at once
  expect(q1).toMatchObject({ blocking: true, pinned: true });
  expect(q1?.options.map((o) => o.label)).toEqual(['develop', 'trunk', 'Another branch']);
  expect(q1?.data).toMatchObject({ repoId, reason: 'unconfirmed' });
  expect((await repoRow())?.known_branches).toEqual(['develop', 'trunk']);

  await page.goto('/desk');
  const art = page.getByRole('article', {
    name: /Which branch is the working branch of notes-app \(HYG\)\?/,
  });
  await expect(art).toBeVisible();
  await expect(art.getByTestId('desk-kind')).toHaveText('Working branch');
  await expect(art).toContainText('Atlas'); // the DevOps engineer asks
  await expect(art).toContainText('2 file(s) have uncommitted changes');
  await page.screenshot({ path: join(paths.vaults, 'hygiene-branch-question.png'), fullPage: true });

  // asking again while the question is open adds nothing
  await runHygiene();
  expect(await questions()).toHaveLength(1);
});

test('AC2: answering sets the branch on the repository with a ledger entry; hygiene then saves the work on a saved-work branch', async () => {
  const head = originHead();
  await page.goto('/desk');
  const art = page.getByRole('article', { name: /Which branch is the working branch of notes-app/ });
  await art.getByRole('radio', { name: /^trunk/ }).check();
  await art.getByRole('button', { name: 'Set working branch' }).click();
  await waitFor('the branch is stored', repoRow, (r) => r?.working_branch === 'trunk', 30_000);
  expect((await questions('open')).length).toBe(0);
  const ledger = await q<{ body: string; scope: string }>(
    `SELECT body, scope FROM ledger_entries WHERE source_desk_item_id IN (SELECT id FROM desk_items WHERE subkind='working_branch' AND project_id=$1)`,
    [projectId],
  );
  expect(ledger).toHaveLength(1);
  expect(ledger[0]?.body).toContain('trunk');
  const ev = await q<{ payload: any }>(
    `SELECT payload FROM events WHERE type='ProjectRepoWorkingBranchSet' ORDER BY seq DESC LIMIT 1`,
  );
  expect(ev[0]?.payload).toMatchObject({
    workingBranch: 'trunk',
    previousBranch: null,
    reason: 'unconfirmed',
  });

  // the held-back work is stored on a saved-work branch and pushed by the run the answer started: nothing lands on the
  // working branch and the manager's checkout is left as it was
  const saved = await waitFor(
    'the saved-work branch reached origin',
    async () => git(ORIGIN, 'branch', '--list', 'guildwise/saved-work/*'),
    (b) => b.trim() !== '',
    90_000,
  );
  const savedBranch = saved.trim().replace(/^[*+]?\s*/, '');
  expect(git(ORIGIN, 'log', '-1', '--format=%s', savedBranch)).toContain('saved work');
  expect(git(ORIGIN, 'show', `${savedBranch}:todo.md`)).toContain('unsaved work');
  expect(originHead()).toBe(head);
  expect(git(CLONE, 'status', '--porcelain')).toContain('todo.md');
  const requestsNow = await requests();
  expect(requestsNow.at(-1)?.hygiene.trigger).toBe('branch_confirmed');

  // later shifts do not ask again
  await runHygiene();
  expect(await questions()).toHaveLength(0);
});

test('AC3: uncommitted changes on a branch that is not the working branch are saved on a saved-work branch, not committed there', async () => {
  git(CLONE, 'checkout', 'develop');
  writeFileSync(join(CLONE, 'scratch.txt'), 'on the wrong branch\n');
  const head = originHead('develop');
  const savedBefore = git(ORIGIN, 'branch', '--list', 'guildwise/saved-work/*').split('\n').length;
  await runHygiene();
  // the checkout and the branch it is on are left alone; the edits go to a new saved-work branch (no finding is raised)
  expect(originHead('develop')).toBe(head);
  expect(git(CLONE, 'status', '--porcelain')).toContain('scratch.txt');
  await waitFor(
    'a new saved-work branch holding scratch.txt',
    async () => git(ORIGIN, 'branch', '--list', 'guildwise/saved-work/*').split('\n').length,
    (n) => n > savedBefore,
    30_000,
  );
  expect(
    await q(`SELECT 1 FROM hygiene_findings WHERE kind='dirty_other_branch' AND project_id=$1`, [projectId]),
  ).toHaveLength(0);
  await page.goto('/workstations');
  await expandWorkstation(page.getByTestId('workstation-Hygiene Box'));
  await page.screenshot({ path: join(paths.vaults, 'hygiene-workstation.png'), fullPage: true });

  // tidied by hand: back on the working branch
  rmSync(join(CLONE, 'scratch.txt'));
  git(CLONE, 'checkout', 'trunk');
  await runHygiene();
  expect(
    await q(`SELECT 1 FROM hygiene_findings WHERE status='open' AND project_id=$1`, [projectId]),
  ).toHaveLength(0);
});

test('AC4: the runner sweep removes the worktree of a dead card and keeps a dirty one, which becomes a finding', async () => {
  const wt = join(HOME, 'worktrees', 'HYG-deadbeef');
  mkdirSync(wt, { recursive: true });
  git(CLONE, 'worktree', 'add', '-b', 'aom/hyg-1-gone', join(wt, 'HYG-1'), 'trunk');
  git(CLONE, 'worktree', 'add', '-b', 'aom/hyg-2-dirty', join(wt, 'HYG-2'), 'trunk');
  writeFileSync(join(wt, 'HYG-2', 'forgotten.txt'), 'uncommitted\n');
  await runHygiene();
  await waitFor(
    'the clean worktree is removed',
    async () => existsSync(join(wt, 'HYG-1')),
    (x) => !x,
    30_000,
  );
  expect(existsSync(join(wt, 'HYG-2', 'forgotten.txt'))).toBe(true);
  expect(git(CLONE, 'branch', '--list', 'aom/hyg-1-gone')).toContain('aom/hyg-1-gone'); // the branch is kept
  const f = await waitFor(
    'the dirty worktree is a finding',
    () =>
      q<{ subject: string }>(
        `SELECT subject FROM hygiene_findings WHERE kind='dirty_worktree' AND status='open'`,
      ),
    (r) => r.length === 1,
    30_000,
  );
  expect(f[0]?.subject).toBe(join(wt, 'HYG-2'));
  // tidy up for the following specs
  git(CLONE, 'worktree', 'remove', '--force', join(wt, 'HYG-2'));
  git(CLONE, 'branch', '-D', 'aom/hyg-1-gone', 'aom/hyg-2-dirty');
});

test('AC5: the project settings show the working branch with a Change action', async () => {
  await page.goto(`/projects/${projectId}/settings`);
  const row = page.getByTestId('working-branch-notes-app');
  await expect(row).toContainText('trunk');
  await row.getByRole('button', { name: 'Change working branch of notes-app' }).click();
  await row.getByLabel('Branch', { exact: true }).selectOption('develop');
  await row.getByRole('button', { name: 'Save branch' }).click();
  await waitFor('the branch changed', repoRow, (r) => r?.working_branch === 'develop', 30_000);
  await expect(row).toContainText('develop');
  await page.screenshot({ path: join(paths.vaults, 'hygiene-project-settings.png'), fullPage: true });
  // back to trunk for the next steps
  await row.getByRole('button', { name: 'Change working branch of notes-app' }).click();
  await row.getByLabel('Branch', { exact: true }).selectOption('trunk');
  await row.getByRole('button', { name: 'Save branch' }).click();
  await waitFor('the branch is trunk again', repoRow, (r) => r?.working_branch === 'trunk', 30_000);
  await q(`UPDATE project_repos SET working_branch_set_at = now() - interval '5 hours' WHERE id=$1`, [
    repoId,
  ]);
});

test('AC6: a new phase asks the manager to keep the working branch or name another (non-urgent)', async () => {
  // "Keep it?" questions go only to managers who turned expert mode on (simple mode confirms without asking)
  expect((await api.put('/api/auth/git-expert', { data: { enabled: true } })).ok()).toBe(true);
  const res = await api.post(`/api/projects/${projectId}/phases`, {
    data: { name: 'Autosave', description: 'Notes save themselves.' },
  });
  expect(res.status(), await res.text()).toBe(201);
  const [q2] = await waitFor('the re-confirmation', questions, (r) => r.length === 1, 30_000);
  expect(q2?.title).toContain('Keep trunk as the working branch of notes-app (HYG)');
  expect(q2).toMatchObject({ blocking: false, pinned: false });
  // the saved-work branches hygiene pushed earlier are offered as well; they are not what this spec is about
  expect(q2?.options.map((o) => o.id).filter((id) => !id.startsWith('branch:guildwise/saved-work/'))).toEqual(
    ['keep', 'branch:develop', 'other'],
  );
  await page.goto('/desk');
  const art = page.getByRole('article', { name: /Keep trunk as the working branch of notes-app/ });
  await expect(art.getByRole('radio', { name: /Keep trunk/ })).toBeChecked();
  // name another branch
  await art.getByRole('radio', { name: /Another branch/ }).check();
  await art.getByRole('button', { name: 'Set working branch' }).click();
  await expect(art.getByRole('alert')).toContainText('Type the name of the branch');
  await art.getByRole('textbox', { name: 'Branch name' }).fill('release/2026');
  await art.getByRole('button', { name: 'Set working branch' }).click();
  // A branch named while re-confirming for a phase is saved on that phase; the repository keeps its default.
  const phaseBranch = () =>
    q<{ working_branch: string | null }>(`SELECT working_branch FROM phases WHERE name='Autosave'`);
  await waitFor(
    'the phase branch is stored',
    phaseBranch,
    (r) => r[0]?.working_branch === 'release/2026',
    30_000,
  );
  expect((await repoRow())?.working_branch).toBe('trunk');
  expect(
    (
      await q(
        `SELECT 1 FROM events WHERE type='ProjectRepoWorkingBranchSet' AND payload->>'workingBranch'='release/2026'`,
      )
    ).length,
  ).toBe(0);
  // that branch does not exist anywhere: hygiene says so instead of guessing
  await runHygiene();
  const f = await waitFor(
    'a branch_missing finding',
    () => q<{ kind: string }>(`SELECT kind FROM hygiene_findings WHERE status='open'`),
    (r) => r.length === 1,
  );
  expect(f[0]?.kind).toBe('branch_missing');
  await q(`UPDATE project_repos SET working_branch='trunk' WHERE id=$1`, [repoId]);
  await q(`UPDATE phases SET working_branch=NULL WHERE name='Autosave'`);
});

test('AC7: the cadence is set per workstation', async () => {
  await page.goto('/workstations');
  await expandWorkstation(page.getByTestId('workstation-Hygiene Box'));
  await page.getByTestId('hygiene-Hygiene Box').getByLabel('Run').selectOption({ label: 'Every 6 hours' });
  await waitFor(
    'the cadence is stored',
    async () =>
      (
        await q<{ hygiene_interval_hours: number }>(
          `SELECT hygiene_interval_hours FROM workstations WHERE id=$1`,
          [workstationId],
        )
      )[0],
    (w) => w?.hygiene_interval_hours === 6,
    15_000,
  );
  await page.reload();
  await expect(page.getByTestId('hygiene-Hygiene Box').getByLabel('Run')).toHaveValue('6');
});
