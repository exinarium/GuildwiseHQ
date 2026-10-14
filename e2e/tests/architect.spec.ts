import { execFileSync } from 'node:child_process';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, ARCHITECT, BASE_URL, paths } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';
import { makeVault, originFile, originHas, type VaultFixture } from '../support/vault.ts';

// The architect (docs/design/architect-and-workflows.md): a card with the design step goes spec -> investigate
// (architect) -> build -> review -> test -> finalize -> done with the report merged; an investigation-only card ends in
// Finalize with a ledger entry and the PROJECT.md section; a vault report is finalized without a git step. The mock
// architect writes the report, the runner checks it (secrets, scope) and commits it.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('architect');
let page: Page;
let api: APIRequestContext;
let projectId: string;
let repoId: string;
let vault: VaultFixture;

const SPEC = {
  context: 'The toy project needs a feature.',
  requirements: 'Add the thing.',
  acceptanceCriteria: ['It works'],
  affectedAreas: 'index.js',
  constraints: 'None',
  testPlan: 'Run the tests',
};
const SHORT = {
  context: 'Which queue should the toy use?',
  requirements: 'Compare the options and recommend one.',
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Someone Else',
      GIT_AUTHOR_EMAIL: 'else@e2e.test',
      GIT_COMMITTER_NAME: 'Someone Else',
      GIT_COMMITTER_EMAIL: 'else@e2e.test',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
const originFiles = (): string => git(paths.origin, 'ls-tree', '-r', '--name-only', 'main');

interface CardRow {
  id: string;
  ref: string;
  stage: string;
  status: string;
  investigation: { reportPath: string; location: string; summary: string } | null;
  design_needed: boolean;
  investigation_only: boolean;
}
const card = async (ref: string) => (await q<CardRow>('SELECT * FROM cards WHERE ref=$1', [ref]))[0];
const waitCard = async (ref: string, what: string, pred: (c: CardRow | undefined) => boolean, ms = 120_000) =>
  (await waitFor(`${ref} ${what}`, () => card(ref), pred, ms)) as CardRow;
const isDone = (ref: string) => waitCard(ref, 'done', (c) => c?.status === 'done', 180_000);

async function createCard(
  title: string,
  opts: {
    fields?: Record<string, unknown>;
    mock?: Record<string, string[]>;
    extra?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const res = await api.post('/api/cards', {
    data: {
      projectId,
      title,
      cardType: 'feature',
      repoId,
      fields: { ...(opts.fields ?? SPEC), ...(opts.mock ? { mock: opts.mock } : {}) },
      specify: true,
      ...(opts.extra ?? {}),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  expect(body.missing ?? []).toEqual([]);
  return body.card.ref as string;
}

const shiftText = async (ref: string, stage: string): Promise<string> => {
  const rows = await waitFor(
    `${ref} ${stage} shifts ended`,
    () =>
      q<{ status: string; progress_tail: Array<{ text: string }> }>(
        `SELECT s.status, s.progress_tail FROM shifts s JOIN cards c ON c.id = s.card_id WHERE c.ref=$1 AND s.stage=$2`,
        [ref, stage],
      ),
    (r) => r.length > 0 && r.every((x) => x.status === 'ended'),
    60_000,
  );
  return rows.flatMap((r) => r.progress_tail.map((t) => t.text)).join('\n');
};

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, ARCHITECT);
  api = await apiAs(ARCHITECT.email, ARCHITECT.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test('setup: a paired mock runner, the organization vault, project ARC on the toy repo and the whole team', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Architect Box', HOME);
  addRepoRoot(paths.repoRoot, HOME);
  startRunner({ AOM_MOCK_STEP_MS: '200' }, HOME);
  const ws = await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  const workstationId = ws[0].id as string;

  vault = makeVault('architect', { 'projects/arc/PROJECT.md': '# Architect project\n' });
  const v = await api.post('/api/vaults', {
    data: { kind: 'org', remoteUrl: vault.origin, syncIntervalSec: 2 },
  });
  expect(v.status(), await v.text()).toBe(201);
  await waitFor(
    'the runner cloned the vault',
    () => q<{ local_path: string | null }>('SELECT local_path FROM workstation_vaults'),
    (r) => !!r[0]?.local_path,
    30_000,
  );

  const proj = await api.post('/api/projects', { data: { key: 'ARC', name: 'Architect project' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  // Manual QA after Finalize is on for real projects; this spec runs cards to Done, so it is off here.
  expect((await api.put(`/api/projects/${projectId}/manual-qa`, { data: { enabled: false } })).status()).toBe(
    200,
  );
  const add = await api.post(`/api/projects/${projectId}/repos`, {
    data: { name: 'toy', remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(add.status()).toBe(201);
  repoId = (await add.json()).repos[0].id;
  await waitFor(
    'the workstation holds the toy repo',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].repos.length,
    (n) => n === 1,
    30_000,
  );
  for (const [name, roleKey, seniority] of [
    ['Bo', 'builder', 'junior'],
    ['Rae', 'reviewer', 'senior'],
    ['Tess', 'tester', 'junior'],
    ['Ben', 'ba', 'senior'],
    ['Aria', 'architect', 'senior'],
  ] as const) {
    const hire = await api.post('/api/agents', {
      data: { name, roleKey, seniority, workstationId, projectId, runtime: 'mock' },
    });
    expect(hire.status(), `${name}: ${await hire.text()}`).toBe(201);
  }
});

test('the design step is off for a new project; the owner turns it on in the project settings', async () => {
  const detail = (await (await api.get(`/api/projects/${projectId}`)).json()).project;
  expect(detail).toMatchObject({
    designStep: false,
    mergeMainFirst: true,
    investigationPath: 'docs/investigations',
  });
  await page.goto(`/projects/${projectId}/settings#architect`);
  await expect(page.getByTestId('architect-state')).toHaveText('Investigate & design is off');
  await page.getByTestId('design-step-toggle').check();
  // an architect is hired: no warning
  await expect(page.getByTestId('no-architect')).toHaveCount(0);
  await page.getByTestId('architect-save').click();
  await waitFor(
    'design step saved',
    async () =>
      (await q<{ design_step: boolean }>('SELECT design_step FROM projects WHERE key=$1', ['ARC']))[0],
    (p) => p?.design_step === true,
    15_000,
  );
  await expect(page.getByTestId('architect-state')).toHaveText('Investigate & design is on');
  await page.screenshot({ path: `${paths.vaults}/architect-settings.png` });
});

test('a card made on the form takes the design step: spec -> investigate -> build -> review -> test -> done, the report merged', async () => {
  await page.goto('/cards/new?project=ARC');
  const form = page.getByRole('form', { name: 'New card' });
  await form.getByLabel('Title').fill('Add the thing');
  await form.getByLabel('Repository').selectOption(repoId);
  for (const [label, text] of [
    ['Context', SPEC.context],
    ['Requirements', SPEC.requirements],
    ['Acceptance criteria', 'It works'],
    ['Affected areas', SPEC.affectedAreas],
    ['Constraints', SPEC.constraints],
    ['Test plan', SPEC.testPlan],
  ] as const)
    await form.getByLabel(label, { exact: true }).fill(text);
  // the project asked for the design step: the box is ticked and says so
  await expect(form.getByLabel(/Investigate & design before build/)).toBeChecked();
  await expect(form.getByText('On for this project')).toBeVisible();
  await page.screenshot({ path: `${paths.vaults}/architect-new-card.png` });
  await form.getByRole('button', { name: 'Specify' }).click();
  await expect(page).toHaveURL(/\/cards\/ARC-\d+$/);
  const ref = page.url().split('/').pop() as string;
  expect(ref).toBe('ARC-1');

  await waitCard(ref, 'reported by the architect', (c) => !!c?.investigation);
  await isDone(ref);
  const c = await card(ref);
  expect(c?.design_needed).toBe(true);
  expect(c?.investigation).toMatchObject({ location: 'repo' });
  const path = c?.investigation?.reportPath as string;
  expect(path).toMatch(/^docs\/investigations\/ARC-1-add-the-thing\.md$/);

  const stages = (
    await q<{ stage: string; outcome: string }>(
      `SELECT h.stage, h.outcome FROM card_handoffs h JOIN cards c ON c.id=h.card_id WHERE c.ref=$1 ORDER BY h.created_at, h.event_seq`,
      [ref],
    )
  ).map((h) => `${h.stage}:${h.outcome}`);
  expect(stages).toEqual([
    'investigate:handoff',
    'build:handoff',
    'review:approve',
    'test:pass',
    'finalize:finalized',
  ]);
  // the report was committed by the architect and merged with the card
  expect(originFiles()).toContain(path);
  expect(git(paths.origin, 'show', `main:${path}`)).toContain('Mock findings');

  // the card page shows the report
  await page.goto(`/cards/${ref}`);
  await expect(page.getByTestId('investigation')).toContainText('Design report');
  await expect(page.getByTestId('investigation-path')).toContainText(path);
  await expect(page.getByTestId('investigation-summary')).toContainText('Mock design summary');
  await page.screenshot({ path: `${paths.vaults}/architect-report.png` });
});

test('an investigation-only card ends in Finalize with a ledger entry and the PROJECT.md section', async () => {
  const ref = await createCard('Which queue should we use', {
    fields: SHORT,
    extra: { investigationOnly: true },
  });
  const c0 = await card(ref);
  expect(c0).toMatchObject({ design_needed: true, investigation_only: true });
  await isDone(ref);
  const stages = (
    await q<{ stage: string; outcome: string }>(
      `SELECT h.stage, h.outcome FROM card_handoffs h JOIN cards c ON c.id=h.card_id WHERE c.ref=$1 ORDER BY h.created_at, h.event_seq`,
      [ref],
    )
  ).map((h) => `${h.stage}:${h.outcome}`);
  expect(stages).toEqual(['investigate:report', 'finalize:finalized']);

  const entries = await q<{ scope: string; title: string; tags: string[]; body: string }>(
    `SELECT l.scope, l.title, l.tags, l.body FROM ledger_entries l JOIN cards c ON c.id=l.card_id WHERE c.ref=$1`,
    [ref],
  );
  expect(entries).toHaveLength(1);
  expect(entries[0]?.tags).toEqual(expect.arrayContaining(['investigation', ref]));
  expect(entries[0]?.body).toContain('docs/investigations/');
  // the report is in the repository (the finalize merged it); no build ran
  expect(originFiles()).toContain((await card(ref))?.investigation?.reportPath as string);
  expect(stages.join(',')).not.toContain('build');

  // PROJECT.md lists the investigation (written by the runner into the vault, synced to its origin)
  await waitFor(
    'PROJECT.md section in the vault origin',
    async () =>
      originHas(vault, 'projects/arc/PROJECT.md') ? originFile(vault, 'projects/arc/PROJECT.md') : '',
    (t) => t.includes('## Investigations') && t.includes(ref),
    60_000,
  );
  expect(originFile(vault, 'projects/arc/PROJECT.md')).toContain('# Architect project');

  await page.goto(`/cards/${ref}`);
  await expect(page.getByTestId('investigation')).toContainText('Investigation report');
});

test('a report kept in the vault is finalized without a git step', async () => {
  const before = git(paths.origin, 'rev-parse', 'main');
  const ref = await createCard('Vault answer', {
    fields: { ...SHORT, reportPath: 'vault:research' },
    extra: { investigationOnly: true },
  });
  await isDone(ref);
  const c = await card(ref);
  expect(c?.investigation).toMatchObject({ location: 'vault' });
  const vaultPath = c?.investigation?.reportPath as string;
  expect(vaultPath).toBe(`projects/arc/research/${ref}-vault-answer.md`);
  await waitFor(
    'the report in the vault origin',
    async () => originHas(vault, vaultPath),
    (x) => x,
    60_000,
  );
  expect(originFile(vault, vaultPath)).toContain('Mock findings');
  // finalize needed no merge: origin main did not move
  expect(git(paths.origin, 'rev-parse', 'main')).toBe(before);
  const done = await q<{ payload: { action: string } }>(
    `SELECT payload FROM events WHERE type='CardFinalized' AND payload->>'cardId'=$1`,
    [c?.id],
  );
  expect(done[0]?.payload.action).toBe('none');
});

test('the runner refuses a report with a secret; the architect rewrites it and the card goes on', async () => {
  const ref = await createCard('Report with a token', { mock: { investigate: ['secret'] } });
  await waitCard(ref, 'investigated', (c) => !!c?.investigation);
  const log = await shiftText(ref, 'investigate');
  expect(log).toContain('first report refused');
  expect(log).toContain('GitHub token');
  expect(log).not.toContain('ghp_');
  const c = await card(ref);
  const path = c?.investigation?.reportPath as string;
  await waitCard(ref, 'in or past build', (x) => x?.stage !== 'investigate');
  expect(git(paths.toyClone, 'log', '--all', '--format=%s', '--', path)).toContain('mock investigation');
});

test('a report that also changes product code is refused by the post-shift guard', async () => {
  const ref = await createCard('Architect strays', { mock: { investigate: ['edit_outside_scope', 'ok'] } });
  const cardId = (await card(ref))?.id;
  const ended = await waitFor(
    'guard violation recorded',
    () =>
      q<{ payload: { guardViolations: Array<{ rule: string; detail: string }> } }>(
        `SELECT payload FROM events WHERE type='ShiftEnded' AND payload->>'cardId'=$1 AND jsonb_array_length(payload->'guardViolations') > 0`,
        [cardId],
      ),
    (r) => r.length > 0,
    120_000,
  );
  expect(ended[0]?.payload.guardViolations[0]?.rule).toBe('architect_edited_non_docs');
  expect(ended[0]?.payload.guardViolations[0]?.detail).toContain('outside-scope.txt');
  // the next shift is clean and the card goes on
  await waitCard(ref, 'reported', (c) => !!c?.investigation, 180_000);
});

test('a card can opt out of the project default, and then goes straight to build', async () => {
  const ref = await createCard('Typo fix', { extra: { designNeeded: false } });
  expect(await card(ref)).toMatchObject({ design_needed: false, stage: 'build' });
  await isDone(ref);
  const stages = await q<{ stage: string }>(
    `SELECT h.stage FROM card_handoffs h JOIN cards c ON c.id=h.card_id WHERE c.ref=$1`,
    [ref],
  );
  expect(stages.map((s) => s.stage)).not.toContain('investigate');
});
