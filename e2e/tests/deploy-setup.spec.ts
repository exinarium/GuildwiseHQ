import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, DEPLOYER, E2E_DIR, paths } from '../support/env.ts';
import { addRepoRoot, killRunner, pairRunner, startRunner } from '../support/runner.ts';
import { git } from '../support/vault.ts';

// Guided deploy setup (docs/design/deploy-run-ux-design.md, v1b), against REAL Docker: a throwaway Compose stack (project
// aomv1b-e2e, port 14711: a postgres, an app built from a tiny repo, and a bystander) is adopted through the wizard. The probe
// finds it, Save writes the generated files, the dry run changes nothing, the Owner approves, a real deploy rebuilds ONLY the
// app (the other containers and the volume keep their ids), and an unhealthy release is rolled back to the previous image.
// Standalone: one user, one runner (mock runtime; deploys run outside any model), project DPS on its own repository.
// The VPS path (ssh) is covered by the runner tests with fake docker/ssh; no sshd container is used here.
test.describe.configure({ mode: 'serial' });

const PROJECT_NAME = 'aomv1b-e2e';
const PORT = 14711;
const HOME = paths.runnerHome('deploy-setup');
const DIR = join(E2E_DIR, 'deploy-setup');
const STACK = join(DIR, 'stack');
const ORIGIN = join(DIR, 'origin.git');
const CLONE = join(DIR, 'repos', 'app');

const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const compose = (...args: string[]) =>
  docker('compose', '-p', PROJECT_NAME, '-f', join(STACK, 'docker-compose.yml'), ...args);
const ids = () =>
  Object.fromEntries(
    ['db', 'other', 'app'].map((s) => [
      s,
      docker(
        'ps',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${PROJECT_NAME}`,
        '--filter',
        `label=com.docker.compose.service=${s}`,
      ),
    ]),
  );
const commit = (msg: string, files: Record<string, string>): string => {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(CLONE, f, '..'), { recursive: true });
    writeFileSync(join(CLONE, f), c);
  }
  git(CLONE, 'add', '-A');
  git(CLONE, 'commit', '-m', msg);
  git(CLONE, 'push', 'origin', 'main');
  return git(CLONE, 'rev-parse', 'HEAD').trim();
};

/** A tiny HTTP server for the throwaway app: a file under /www answers 200 with its content, anything else 404. */
const HANDLER = `#!/bin/sh
read -r line
p=$(echo "$line" | cut -d' ' -f2)
if [ -f "/www$p" ]; then
  body=$(cat "/www$p")
  printf 'HTTP/1.1 200 OK\\r\\nContent-Length: %s\\r\\nConnection: close\\r\\n\\r\\n%s' "\${#body}" "$body"
else
  printf 'HTTP/1.1 404 Not Found\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n'
fi
`;

let page: Page;
let api: APIRequestContext;
let projectId: string;
let before: Record<string, string>;
let volume: string;

test.beforeAll(async ({ browser }) => {
  await inviteAndAccept(await apiAs(ADMIN.email, ADMIN.password), DEPLOYER);
  api = await apiAs(DEPLOYER.email, DEPLOYER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test.afterAll(() => {
  // stop this spec's runner: a runner left behind is another computer of the same person and gets picked by the next spec
  killRunner('SIGTERM', HOME);
  try {
    compose('down', '-v', '--remove-orphans');
  } catch {
    // never started
  }
  try {
    for (const t of docker('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', `${PROJECT_NAME}-app`)
      .split('\n')
      .filter(Boolean))
      docker('image', 'rm', t);
  } catch {
    // already gone
  }
  rmSync(DIR, { recursive: true, force: true });
});

test('setup: a throwaway Compose stack, a repository with a tiny app, a paired runner and the project', async () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(STACK, { recursive: true });
  mkdirSync(join(DIR, 'repos'), { recursive: true });
  git(DIR, 'init', '--bare', '-b', 'main', ORIGIN);
  git(join(DIR, 'repos'), 'clone', ORIGIN, CLONE);
  git(CLONE, 'checkout', '-b', 'main');
  commit('first version', {
    Dockerfile:
      'FROM alpine:latest\nCOPY www /www\nCOPY handler.sh /handler.sh\nRUN chmod +x /handler.sh\nCMD ["sh","-c","while true; do nc -l -p 8080 -e /handler.sh; done"]\n',
    'handler.sh': HANDLER,
    'www/api/health': 'ok v1\n',
  });
  writeFileSync(
    join(STACK, 'docker-compose.yml'),
    `name: ${PROJECT_NAME}
services:
  db:
    image: postgres:18
    environment:
      POSTGRES_PASSWORD: throwaway
      POSTGRES_USER: app
      POSTGRES_DB: app
    volumes:
      - dbdata:/var/lib/postgresql
  app:
    build: ${CLONE}
    ports:
      - "127.0.0.1:${PORT}:8080"
  other:
    image: alpine:latest
    command: ["sleep", "infinity"]
volumes:
  dbdata: {}
`,
  );
  compose('up', '-d', '--build');
  await waitFor(
    'postgres accepts connections',
    async () => {
      try {
        compose('exec', '-T', 'db', 'pg_isready', '-U', 'app');
        return true;
      } catch {
        return false;
      }
    },
    (ok) => ok,
    60_000,
  );
  before = ids();
  volume = docker('volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT_NAME}`);
  expect(volume).toContain('dbdata');

  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Office PC', HOME);
  addRepoRoot(join(DIR, 'repos'), HOME);
  startRunner({ AOM_MOCK_STEP_MS: '100' }, HOME);
  await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  const proj = await api.post('/api/projects', { data: { key: 'DPS', name: 'Deploy setup project' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  const add = await api.post(`/api/projects/${projectId}/repos`, {
    data: { name: 'app', remoteUrl: ORIGIN, workingBranch: 'main' },
  });
  expect(add.status()).toBe(201);
  await waitFor(
    'the workstation holds the repo',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].repos.length,
    (n) => n === 1,
    30_000,
  );
  const caps = await q<{ capabilities: string[] }>('SELECT capabilities FROM workstation_capabilities');
  expect(caps.some((c) => c.capabilities.includes('deploy-setup:1'))).toBe(true);
});

test('a new project says nothing is set up; adding an environment finds the running stack and shows what it will and will not touch', async () => {
  await page.goto('/p/DPS/environments');
  await expect(page.getByTestId('setup-empty')).toContainText('Where does your app run?');
  await page.getByTestId('setup-add').first().click();
  // a test site is the default; the computer is chosen from the places, and the look at it starts by itself
  await page.locator('[data-testid^="place-choice-"]').first().click();
  const stack = page.getByTestId('stack-choice').filter({ hasText: PROJECT_NAME });
  await expect(stack).toBeVisible({ timeout: 60_000 });
  await expect(stack).toContainText('3 parts');
  await expect(stack).toContainText('Running now');
  await stack.click();
  await page.getByTestId('env-next').click();
  const found = page.getByTestId('found-changes');
  await expect(found.getByTestId('changes-reuse')).toContainText('The app part "app"');
  await expect(found.getByTestId('changes-each_deploy')).toContainText('Rebuild and restart only "app"');
  await expect(found.getByTestId('changes-untouched')).toContainText('Part "other"');
  await expect(found.getByTestId('changes-untouched')).toContainText('Part "db"');
  await expect(page.getByTestId('details-app')).toHaveValue('app');
  await expect(page.getByTestId('details-db')).toHaveValue('db');
  await page.screenshot({ path: join(DIR, 'environment-found.png') });
});

test('Save writes the generated files; nothing is approved and nothing runs yet', async () => {
  await page.getByTestId('env-to-review').click();
  await expect(page.getByTestId('review-save')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('review-save').click();
  await expect(page.getByTestId('review-saved')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('review-done').click();
  const row = (
    await q<{ status: string; setup: any; hand_edited: string[] }>(
      'SELECT status, setup, hand_edited FROM delivery_recipes WHERE project_id=$1',
      [projectId],
    )
  )[0];
  expect(row).toMatchObject({ status: 'observed', hand_edited: [] });
  expect(row?.setup.environments[0]).toMatchObject({
    name: 'test-site',
    role: 'test',
    trigger: ['after_merge'],
    releasedBy: 'auto',
    hosting: 'this_computer',
  });
  expect(row?.setup.environments[0].app.composeFile).toContain('docker-compose.yml');
  expect(ids()).toEqual(before);
});

test('approval waits for a dry run; the dry run changes nothing', async () => {
  await page.goto('/p/DPS/environments');
  await expect(page.getByTestId('env-approve-test-site')).toHaveCount(0);
  await page.getByTestId('env-try-test-site').click();
  await expect(page.getByTestId('env-tried-test-site')).toBeVisible({ timeout: 120_000 });
  expect(ids()).toEqual(before);
  expect(readdirSync(STACK)).toEqual(['docker-compose.yml']); // no backup folder: a dry run writes nothing
  await expect(page.getByTestId('env-approve-test-site')).toBeEnabled();
  await page.getByTestId('env-approve-test-site').click();
  await page.getByTestId('approve-confirm').click();
  await waitFor(
    'approved',
    async () =>
      (await q<{ status: string }>('SELECT status FROM delivery_recipes WHERE project_id=$1', [projectId]))[0]
        ?.status,
    (s) => s === 'approved',
    30_000,
  );
  const set = await api.put(`/api/projects/${projectId}/delivery/mode`, { data: { mode: 'recipe' } });
  expect(set.ok(), await set.text()).toBeTruthy();
});

type DeployRow = { status: string; summary: string; log_tail: string };
const release = async (sha: string): Promise<DeployRow> => {
  const res = await api.post(`/api/projects/${projectId}/delivery/deploy`, {
    data: { env: 'test-site', commit: sha },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const run = (await res.json()).runs[0];
  return (await waitFor(
    'the deploy finished',
    async () =>
      (
        await q<{ status: string; summary: string; log_tail: string }>(
          'SELECT status, summary, log_tail FROM deploy_runs WHERE id=$1',
          [run.runId],
        )
      )[0],
    (r) => r?.status === 'succeeded' || r?.status === 'failed' || r?.status === 'refused',
    240_000,
  )) as DeployRow;
};

test('a real release rebuilds ONLY the app from the approved commit; the database, the volume and the bystander keep their ids', async () => {
  const sha = commit('second version', { 'www/api/health': 'ok v2\n' });
  const r = await release(sha);
  expect(r.status, r.log_tail).toBe('succeeded');
  const after = ids();
  expect(after.db).toBe(before.db);
  expect(after.other).toBe(before.other);
  expect(after.app).not.toBe(before.app);
  expect(docker('volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT_NAME}`)).toBe(
    volume,
  );
  expect(docker('inspect', '--format', '{{.Config.Image}}', after.app as string)).toBe(
    `${PROJECT_NAME}-app:${sha.slice(0, 12)}`,
  );
  const body = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).text();
  expect(body.trim()).toBe('ok v2');
  // the backup was taken first, in the stack's own backups folder
  expect(readdirSync(join(STACK, 'backups')).filter((f) => f.startsWith('test-site-before-'))).toHaveLength(
    1,
  );
  expect(r.log_tail).toContain('AOM-DEPLOY');
  before = { ...before, app: after.app as string };
});

test('an unhealthy release is rolled back to the previous image; the database is left alone', async () => {
  test.setTimeout(420_000); // the health check waits up to 120 s, then the rollback waits again
  const previous = docker('inspect', '--format', '{{.Config.Image}}', before.app as string);
  const sha = commit('broken version', { 'www/index.html': 'a page, but no health file' });
  // remove the health file: the site answers 404 and the script puts the previous image back
  git(CLONE, 'rm', '-q', 'www/api/health');
  git(CLONE, 'commit', '-m', 'drop health');
  git(CLONE, 'push', 'origin', 'main');
  const bad = git(CLONE, 'rev-parse', 'HEAD').trim();
  void sha;
  const r = await release(bad);
  expect(r.status).toBe('failed');
  expect(r.log_tail).toContain('rolled back to');
  expect(r.log_tail).toContain('the database was NOT rolled back');
  const now = ids();
  expect(now.db).toBe(before.db);
  expect(docker('inspect', '--format', '{{.Config.Image}}', now.app as string)).toBe(previous);
  expect((await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).text()).trim()).toBe('ok v2');
});

test('Scan with DevOps for deploys: the mock DevOps adopts the same stack; the person reviews it and uses it as the draft', async () => {
  await page.goto('/p/DPS/environments');
  const scan = await api.post(`/api/projects/${projectId}/scan`, {
    data: { area: 'deploy', note: `the stack is called ${PROJECT_NAME}` },
  });
  expect(scan.status(), await scan.text()).toBe(202);
  const open = page.getByTestId('deploy-proposal-open').or(page.getByTestId('needs-answer-open'));
  await expect(open).toBeVisible({ timeout: 120_000 });
  await open.click();
  await expect(page.getByTestId('proposal-review')).toContainText('Mock DevOps adopted the compose stack');
  await expect(page.getByTestId('deploy-proposal-envs')).toContainText('Updates the app part "app"');
  // questions are real fields: the first choice of each is used
  const questions = page.getByTestId('proposal-questions');
  if (await questions.count()) {
    for (const group of await questions
      .getByRole('radiogroup')
      .all()
      .catch(() => []))
      await group.getByRole('radio').first().check();
    for (const fs of await questions.locator('fieldset').all()) await fs.getByRole('radio').first().check();
    await page.getByTestId('answers-submit').click();
  }
  await page.getByTestId('proposal-use').click();
  await waitFor(
    'the proposal is the draft',
    async () =>
      (
        await q<{ proposal_id: string | null }>(
          'SELECT proposal_id FROM delivery_setup_drafts WHERE project_id=$1',
          [projectId],
        )
      )[0]?.proposal_id,
    (id) => !!id,
    30_000,
  );
  // using a proposal wrote nothing to the project files and changed nothing running
  expect(
    (await q<{ status: string }>('SELECT status FROM delivery_recipes WHERE project_id=$1', [projectId]))[0]
      ?.status,
  ).toBe('approved');
});
