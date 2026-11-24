import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { q, waitFor } from '../../support/db.ts';
import { E2E_DIR } from '../../support/env.ts';
import { git, makeRemote, type Remote } from '../fixtures/remotes.ts';
import { addRepo, createCard, createProject, hire, newOwner, person, waitBuilt } from '../support/flow.ts';
import { type Host, startHost } from '../support/host.ts';

// A10 (round 3 item 10): a new code project asks "Commit as" (prefilled with the account); the first shift has no
// no_commit_identity; New card shows the prompt when the project has none. The runner host has NO git identity at all
// (no global config, no system config, no GIT_AUTHOR_*), so an identity in a commit can only come from the project.
test.describe.configure({ mode: 'serial' });

const OWNER = person('a10owner');
let api: APIRequestContext;
let page: Page;
let host: Host;
let withId: Remote;
let withoutId: Remote;
let projectId: string;
let workstationId: string;

test.afterAll(async () => {
  await host?.stop();
});

test('[A10] setup: a runner with no git identity at all, two repositories', async ({ browser }) => {
  api = await newOwner(OWNER);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
  const roots = join(E2E_DIR, 'combined', 'a10-repos');
  withId = makeRemote('a10a', { 'README.md': '# a\n', 'index.js': "console.log('a');\n" }, roots);
  withoutId = makeRemote('a10b', { 'README.md': '# b\n', 'index.js': "console.log('b');\n" }, roots);
  host = await startHost(api, {
    password: OWNER.password,
    name: 'a10-box',
    repoRoot: roots,
    identity: false,
  });
  workstationId = host.workstationId;
  // the clones really have no identity (otherwise the check below would pass for the wrong reason)
  for (const r of [withId, withoutId]) {
    let name = '';
    try {
      name = git(r.clone, '-c', 'include.path=/dev/null', 'config', '--global', 'user.name');
    } catch {
      name = '';
    }
    expect(name.trim()).toBe('');
  }
});

test('[A10] the new project dialog asks Commit as, prefilled with the account, and the first shift commits as it', async () => {
  await page.goto('/projects');
  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog');
  const fields = dialog.getByTestId('new-project-commit-as');
  await expect(fields).toBeVisible();
  await expect(fields.getByLabel('Name')).toHaveValue(OWNER.name);
  await expect(fields.getByLabel('E-mail')).toHaveValue(OWNER.email);
  await dialog.getByLabel('Name', { exact: true }).first().fill('Commit as project');
  await dialog.getByLabel('Key').fill('CMA');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  projectId = (
    await waitFor(
      'the project exists',
      () => q<{ id: string }>(`SELECT id FROM projects WHERE key='CMA'`),
      (r) => r.length === 1,
      30_000,
    )
  )[0]?.id as string;
  const saved = await q<{ commit_as: { name: string; email: string } | null }>(
    `SELECT commit_as FROM projects WHERE id=$1`,
    [projectId],
  );
  expect(saved[0]?.commit_as).toMatchObject({ name: OWNER.name, email: OWNER.email });

  const repoId = await addRepo(api, projectId, withId.origin, 'a10a');
  await hire(api, { name: 'Bo', roleKey: 'builder', workstationId, projectId });
  await hire(api, { name: 'Rae', roleKey: 'reviewer', seniority: 'senior', workstationId, projectId });
  const ref = await createCard(api, { projectId, repoId, title: 'First card' });
  await waitBuilt(ref, 120_000);
  // no shift was turned away for a missing identity, and no notice says so
  const rejected = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM shifts s JOIN cards c ON c.id=s.card_id WHERE c.ref=$1 AND s.outcome='rejected'`,
    [ref],
  );
  expect(rejected[0]?.n).toBe(0);
  const events = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM events WHERE payload::text LIKE '%no_commit_identity%'`,
  );
  expect(events[0]?.n).toBe(0);
  // the builder's commit carries the project's identity (the host has none of its own)
  const authors = git(withId.clone, 'log', '--all', '--format=%an <%ae>').split('\n').filter(Boolean);
  expect(
    authors.some((a) => a === `${OWNER.name} <${OWNER.email}>`),
    authors.join(' | '),
  ).toBe(true);
  expect(authors.every((a) => !a.includes('Combined Tester'))).toBe(true);
});

test('[A10] a project with no Commit as: New card shows the prompt, prefilled; the other project shows none', async () => {
  const bare = await createProject(api, 'CMB', 'No commit as project');
  await addRepo(api, bare, withoutId.origin, 'a10b');
  await waitFor(
    'the workstation reports both clones',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].repos.length,
    (n) => n >= 2,
    60_000,
  );
  await page.goto('/cards/new?project=CMB');
  const prompt = page.getByTestId('commit-as-prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt.getByLabel('Name')).toHaveValue(OWNER.name);
  await expect(prompt.getByLabel('E-mail')).toHaveValue(OWNER.email);
  await page.goto('/cards/new?project=CMA');
  await expect(page.getByRole('form', { name: 'New card' })).toBeVisible();
  await expect(page.getByTestId('commit-as-prompt')).toHaveCount(0);
  // saving the prompt on the bare project makes it go away
  await page.goto('/cards/new?project=CMB');
  await page.getByTestId('commit-as-prompt-save').click();
  await expect(page.getByTestId('commit-as-prompt')).toHaveCount(0);
});
