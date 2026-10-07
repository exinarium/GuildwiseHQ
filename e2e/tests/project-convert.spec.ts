import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, CONVERTER, CONVGUEST, paths } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';
import { git, makeVault, originFile, originHas, type VaultFixture } from '../support/vault.ts';

// Part C of the restructure: research is a stage, projects convert. One owner with a mock runtime (a researcher and a
// checker that may work only on the research project, so the other projects keep their research cards queued), a work
// vault, a fake `gh` standing in for GitHub, and a guest on one shared project. No network, no tokens.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('converter');
const GH_LOG = join(paths.vaults, 'convert-gh.log');
let page: Page;
let guestPage: Page;
let api: APIRequestContext;
let guestApi: APIRequestContext;
let workstationId: string;
let vault: VaultFixture;
const projects: Record<string, string> = {};

const claim = (n: number) => ({
  text: `Claim number ${n} about the question`,
  url: `https://convert.example.test/source-${n}`,
  title: `Source ${n}`,
});

const card = async (ref: string) => (await q<any>('SELECT * FROM cards WHERE ref=$1', [ref]))[0];
const project = async (key: string) => (await q<any>('SELECT * FROM projects WHERE key=$1', [key]))[0];
async function researchCard(
  projectKey: string,
  title: string,
  opts: { specify?: boolean; claims?: unknown[] } = {},
): Promise<{ id: string; ref: string }> {
  const res = await api.post('/api/cards', {
    data: {
      projectId: projects[projectKey],
      title,
      cardType: 'research',
      fields: {
        question: title,
        depth: 'standard',
        subCategory: 'ammo',
        ...(opts.claims ? { mockResearch: { claims: opts.claims } } : {}),
      },
      specify: opts.specify ?? true,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const c = (await res.json()).card;
  return { id: c.id as string, ref: c.ref as string };
}

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, CONVERTER);
  await inviteAndAccept(admin, CONVGUEST);
  api = await apiAs(CONVERTER.email, CONVERTER.password);
  guestApi = await apiAs(CONVGUEST.email, CONVGUEST.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
  guestPage = await (await browser.newContext({ storageState: await guestApi.storageState() })).newPage();
});

test('setup: a runner with a work vault and a fake gh, projects RLD and RLN (research) and RLC (code), a researcher and a checker', async () => {
  mkdirSync(paths.vaults, { recursive: true });
  const fakeGh = join(paths.vaults, 'convert-fake-gh.sh');
  writeFileSync(
    fakeGh,
    `#!/bin/sh
echo "$@" >> "${GH_LOG}"
D="${join(paths.vaults, 'convert-fake-github')}"
mkdir -p "$D"
case "$1 $2" in
  "api user") echo octo; exit 0 ;;
  "repo view")
    K=$(echo "$3" | tr '/' '_')
    if [ ! -d "$D/$K.git" ]; then echo "GraphQL: Could not resolve to a Repository" >&2; exit 1; fi
    echo "{\\"url\\":\\"$D/$K.git\\",\\"isEmpty\\":true,\\"owner\\":{\\"login\\":\\"octo\\"}}"
    exit 0 ;;
  "repo create")
    K=$(echo "$3" | tr '/' '_')
    git init --bare -q "$D/$K.git"
    exit 0 ;;
esac
exit 0
`,
  );
  chmodSync(fakeGh, 0o755);
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Convert Box', HOME);
  addRepoRoot(paths.repoRoot, HOME);
  startRunner({ AOM_MOCK_STEP_MS: '200', AOM_GH_BIN: fakeGh }, HOME);
  const ws = await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  workstationId = ws[0].id as string;

  vault = makeVault('convert', { 'projects/rld/PROJECT.md': '# Reload\n\nOur reloading notes.\n' });
  const v = await api.post('/api/vaults', {
    data: { kind: 'work', remoteUrl: vault.origin, syncIntervalSec: 2 },
  });
  expect(v.status(), await v.text()).toBe(201);
  await waitFor(
    'the runner cloned the vault',
    () => q<{ local_path: string | null }>('SELECT local_path FROM workstation_vaults'),
    (r) => !!r[0]?.local_path,
    30_000,
  );

  for (const [key, name, workflowKey] of [
    ['RLD', 'Reload research', 'research'],
    ['RLN', 'Night vision research', 'research'],
    ['RLC', 'Reload tools', 'code'],
  ] as const) {
    const p = await api.post('/api/projects', {
      data: { key, name, workflowKey, subCategories: ['ammo'] },
    });
    expect(p.status(), await p.text()).toBe(201);
    projects[key] = (await p.json()).project.id as string;
  }
  // the researcher and the checker may work RLD only: the other projects' research cards wait
  for (const [name, roleKey] of [
    ['Rhea', 'researcher'],
    ['Chuck', 'checker'],
  ] as const) {
    const hire = await api.post('/api/agents', {
      data: {
        name,
        roleKey,
        seniority: 'junior',
        workstationId,
        runtime: 'mock',
        allowedProjectIds: [projects.RLD],
      },
    });
    expect(hire.status(), await hire.text()).toBe(201);
  }
  // the guest sees RLN only
  const share = await api.post(`/api/projects/${projects.RLN}/members`, { data: { email: CONVGUEST.email } });
  expect(share.status(), await share.text()).toBe(201);
  expect(
    (await guestApi.post(`/api/projects/${projects.RLN}/members/accept`, { data: {} })).ok(),
  ).toBeTruthy();
});

test('AC1: a research-first project has a Research tab, refuses repositories and publishes notes with citations', async () => {
  const first = await researchCard('RLD', 'Which bullet weight for 6mm ARC?', {
    claims: [claim(1), claim(2)],
  });
  await waitFor(
    'the first note is published',
    () => card(first.ref),
    (c) => c?.status === 'done',
    90_000,
  );
  await page.goto('/p/RLD/board');
  const nav = page.getByTestId('nav-research');
  await expect(nav).toBeVisible();
  await nav.click();
  await expect(page).toHaveURL(/\/p\/RLD\/research$/);
  const tab = page.getByTestId('research-tab');
  await expect(tab.getByTestId('research-note')).toHaveCount(1);
  await expect(tab.getByTestId('publication-title')).toHaveText('Which bullet weight for 6mm ARC?');
  await expect(tab.getByTestId('publication-citations').getByRole('link')).toHaveCount(2);
  await page.screenshot({ path: join(paths.vaults, 'convert-research-tab.png') });

  // a research-stage project takes no repository (the API says why; the settings page offers no form)
  const add = await api.post(`/api/projects/${projects.RLD}/repos`, {
    data: { name: 'x', remoteUrl: paths.origin },
  });
  expect(add.status()).toBe(409);
  expect((await add.json()).error.code).toBe('research_stage_no_repos');
  await page.goto(`/projects/${projects.RLD}/settings`);
  await expect(page.getByTestId('stage-current')).toContainText('Research project');
  await expect(page.getByRole('form', { name: 'Add repository' })).toHaveCount(0);
});

test('AC2: convert to Code with an existing repository: keep one card, cancel one, the notes land in PROJECT.md', async () => {
  const keep = await researchCard('RLD', 'Which powder suits subsonic loads?', {
    specify: false,
    claims: [claim(3), claim(4)],
  });
  const cancel = await researchCard('RLD', 'Is a progressive press worth it?', { specify: false });
  await page.goto(`/p/RLD/board`);
  await expect(page.getByTestId('convert-board-open')).toBeVisible();
  await page.getByTestId('convert-board-open').click();
  const dlg = page.getByTestId('convert-dialog');
  await expect(dlg.getByTestId('convert-workflow-code')).toContainText('Usual next step');
  await expect(dlg.getByTestId('convert-needs-repo')).toBeVisible();
  await expect(page.getByTestId('convert-submit')).toBeDisabled();
  await dlg.getByTestId('convert-repo-name').fill('toy');
  await dlg.getByTestId('convert-repo-url').fill(paths.origin);
  await dlg.getByTestId('convert-repo-add').click();
  await expect(dlg.getByTestId('convert-repo-entries')).toContainText('toy');
  await expect(dlg.getByTestId('convert-cards')).toContainText(keep.ref);
  await expect(dlg.getByTestId('convert-cards')).toContainText(cancel.ref);
  await dlg.getByLabel(`Decision for ${cancel.ref}`).selectOption('cancel');
  await expect(dlg.getByTestId('convert-summary')).toContainText('1 card kept, 1 card cancelled');
  await expect(dlg.getByTestId('convert-handover')).toContainText(
    '1 research note will be listed in PROJECT.md',
  );
  await dlg.getByTestId('convert-note').fill('Questions answered: build the loader');
  await page.screenshot({ path: join(paths.vaults, 'convert-dialog.png') });
  await page.getByTestId('convert-submit').click();
  await expect(page.getByText('Reload research converted')).toBeVisible();

  const p = await project('RLD');
  expect(p).toMatchObject({ workflow_key: 'code', started_as: 'research' });
  expect((await card(cancel.ref)).status).toBe('cancelled');
  expect((await card(keep.ref)).status).toBe('draft');
  const cancelled = (
    await q<any>(`SELECT payload FROM events WHERE type='CardCancelled' AND stream_id=$1`, [
      `card-${cancel.id}`,
    ])
  )[0];
  expect(cancelled.payload.reason).toBe('Project converted');

  // PROJECT.md lists the notes (the runner writes the vault; our own text above the section is kept)
  await waitFor(
    'PROJECT.md in the vault',
    async () =>
      originHas(vault, 'projects/rld/PROJECT.md') &&
      originFile(vault, 'projects/rld/PROJECT.md').includes('research-index'),
    (x) => x,
    30_000,
  );
  const md = originFile(vault, 'projects/rld/PROJECT.md');
  expect(md).toContain('Our reloading notes.');
  expect(md).toContain('Which bullet weight for 6mm ARC?');
  expect(md).toContain('2 citations');
  expect(git(vault.origin, 'log', '--format=%s', '-1', 'main').trim()).toContain('research notes');

  // the working-branch question for the new repository
  await page.goto('/desk');
  await expect(page.getByText(/working branch of toy \(RLD\)/)).toBeVisible({ timeout: 60_000 });
  expect(
    (
      await q<any>(`SELECT data FROM desk_items WHERE project_id=$1 AND subkind='working_branch'`, [
        projects.RLD,
      ])
    )[0].data.reason,
  ).toBe('conversion');

  // the Stage panel remembers where the project came from, and the Research tab stays
  await page.goto(`/projects/${projects.RLD}/settings`);
  await expect(page.getByTestId('stage-started-as')).toContainText('Started as Research');
  await expect(page.getByTestId('stage-current')).toContainText('Code project');
  await expect(page.getByRole('form', { name: 'Add repository' })).toBeVisible();
  await page.goto('/p/RLD/board');
  await expect(page.getByTestId('nav-research')).toBeVisible();
});

test('AC3: the kept research card finishes on the research workflow inside the code project, and the tab lists both notes', async () => {
  const keep = (
    await q<any>(`SELECT ref FROM cards WHERE title=$1`, ['Which powder suits subsonic loads?'])
  )[0].ref as string;
  const spec = await api.post(`/api/cards/${keep}/specify`);
  expect(spec.ok(), await spec.text()).toBeTruthy();
  await waitFor(
    'the kept card is published',
    () => card(keep),
    (c) => c?.status === 'done',
    90_000,
  );
  const detail = await (await api.get(`/api/cards/${keep}`)).json();
  expect(detail.card.workflowKey).toBe('research');
  await page.goto('/p/RLD/research');
  await expect(page.getByTestId('research-note')).toHaveCount(2);
  // newest first
  await expect(page.getByTestId('research-note').first()).toContainText('Which powder suits subsonic loads?');
  await expect(page.getByTestId('research-note').last()).toContainText('Which bullet weight');
  await page.screenshot({ path: join(paths.vaults, 'convert-research-tab-after.png') });
});

test('AC4: a research card in a code project shows its own columns and chip; the form asks for the question', async () => {
  await page.goto('/cards/new?project=RLC');
  const form = page.getByRole('form', { name: 'New card' });
  await expect(form.getByLabel('Question')).toHaveCount(0);
  await form.getByLabel('Card type').selectOption('research');
  await expect(form.getByLabel('Question')).toBeVisible();
  await expect(form.getByLabel('Repository')).toHaveCount(0);
  await form.getByLabel('Title').fill('Which loader brand?');
  await form.getByLabel('Question').fill('Which progressive loader brand holds up best?');
  await form.getByLabel('Depth').selectOption('standard');
  await form.getByRole('button', { name: 'Specify' }).click();
  await expect(page).toHaveURL(/\/cards\/RLC-\d+$/);
  await page.goto('/p/RLC/board');
  const board = page.getByTestId('board');
  await expect(board).toContainText('Which loader brand?');
  await expect(board.getByRole('heading', { name: /^Research/ })).toBeVisible();
  // its other column is there too, folded while empty
  await expect(board.getByRole('button', { name: 'Fact check, no cards. Show the column' })).toBeVisible();
  await expect(page.getByTestId('workflow-chip')).toContainText('Research');
  await page.screenshot({ path: join(paths.vaults, 'convert-code-board-research.png') });
  // no agent may work RLC research cards: it is still queued
  expect(
    (await card((await q<any>(`SELECT ref FROM cards WHERE title='Which loader brand?'`))[0].ref)).status,
  ).toBe('queued');
});

test('AC5: a new repository is requested from the dialog; the project converts when the owner approves and the runner creates it', async () => {
  await page.goto(`/projects/${projects.RLN}/settings`);
  await page.getByTestId('convert-open').click();
  const dlg = page.getByTestId('convert-dialog');
  await dlg.getByTestId('convert-new-name').fill('acme/e2e-convert');
  await dlg.getByTestId('convert-new-add').click();
  await expect(dlg.getByTestId('convert-waiting-note')).toBeVisible();
  await expect(page.getByTestId('convert-submit')).toHaveText('Request the repository');
  await page.getByTestId('convert-submit').click();
  const pending = page.getByTestId('pending-conversion');
  await expect(pending).toContainText('acme/e2e-convert');
  await expect(pending).toContainText('pending');
  expect((await project('RLN')).workflow_key).toBe('research');
  await page.screenshot({ path: join(paths.vaults, 'convert-waiting.png') });

  await page.goto('/desk');
  const item = page.locator('[data-testid^="desk-item-"]', { hasText: 'Create repository acme/e2e-convert' });
  await expect(item).toBeVisible();
  await expect(item).toContainText('GitHub login');
  await item.getByRole('button', { name: 'Create repository' }).click();
  await waitFor(
    'the project converted',
    () => project('RLN'),
    (p) => p?.workflow_key === 'code',
    60_000,
  );
  expect(readFileSync(GH_LOG, 'utf8')).toContain('repo create acme/e2e-convert --private');
  expect(existsSync(join(paths.repoRoot, 'e2e-convert', 'README.md'))).toBe(true);
  const repos = (await (await api.get(`/api/projects/${projects.RLN}`)).json()).repos as any[];
  expect(repos.map((r) => r.name)).toEqual(['e2e-convert']);
  await page.goto(`/projects/${projects.RLN}/settings`);
  await expect(page.getByTestId('stage-started-as')).toContainText('Started as Research');
  await expect(page.getByTestId('pending-conversion')).toHaveCount(0);
});

test('AC6: only Owner and Admins convert; a guest sees no button and the API says no', async () => {
  const guestProject = await guestApi.get('/api/projects');
  expect(((await guestProject.json()).projects as any[]).map((p) => p.key)).toEqual(['RLN']);
  await guestPage.goto(`/projects/${projects.RLN}/settings`);
  await expect(guestPage.getByTestId('stage-panel')).toBeVisible();
  await expect(guestPage.getByTestId('convert-open')).toHaveCount(0);
  await expect(guestPage.getByText(/Only the organization's Owner and Admins can convert/)).toBeVisible();
  const denied = await guestApi.post(`/api/projects/${projects.RLN}/convert`, {
    data: { toWorkflowKey: 'research', repos: [] },
  });
  expect(denied.status()).toBe(403);
});

test('the convert dialog fits a phone', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${projects.RLN}/settings`);
  await page.getByTestId('convert-open').click();
  const dlg = page.getByTestId('convert-dialog');
  await expect(dlg).toBeVisible();
  const overflow = await dlg.evaluate((el) => {
    const box = el.closest('[role="dialog"]');
    return box ? box.scrollWidth - box.clientWidth : 0;
  });
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: join(paths.vaults, 'convert-dialog-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
});
