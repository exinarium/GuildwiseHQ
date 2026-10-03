import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, paths, SCHOLAR } from '../support/env.ts';
import { pairRunner, startRunner } from '../support/runner.ts';
import { git, makeVault, originFile, originHas, type VaultFixture } from '../support/vault.ts';

test.describe.configure({ mode: 'serial' });

// M6: research projects. A researcher gathers and writes, a checker verifies every claim against its source and the
// verified note is published to the project's vault folder with its citations. Mock researcher and checker drive
// scripted claims (no network, no tokens); the runner enforces "no citations, no publication".

const HOME = paths.runnerHome('research');
let page: Page;
let api: APIRequestContext;
let workstationId: string;
let projectId: string;
let vault: VaultFixture;

const claim = (n: number, over: Record<string, unknown> = {}) => ({
  text: `Claim number ${n} about the question`,
  url: `https://research.example.test/source-${n}`,
  title: `Source ${n}`,
  ...over,
});

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, SCHOLAR);
  api = await apiAs(SCHOLAR.email, SCHOLAR.password);
  const ctx = await browser.newContext({ storageState: await api.storageState() });
  page = await ctx.newPage();
});

const card = (ref: string) => q<any>('SELECT * FROM cards WHERE ref=$1', [ref]);
const done = (ref: string, ms = 90_000) =>
  waitFor(
    `${ref} done`,
    () => card(ref),
    (r) => r[0]?.status === 'done',
    ms,
  );
const handoffs = (ref: string) =>
  q<{ stage: string; outcome: string; note: string }>(
    `SELECT h.stage, h.outcome, h.note FROM card_handoffs h JOIN cards c ON c.id=h.card_id WHERE c.ref=$1 ORDER BY h.created_at, h.event_seq`,
    [ref],
  );
const publication = async (ref: string) =>
  (
    await q<any>(`SELECT p.* FROM research_publications p JOIN cards c ON c.id=p.card_id WHERE c.ref=$1`, [
      ref,
    ])
  )[0];
const noteFor = async (ref: string): Promise<string> => {
  const pub = await waitFor(
    'publication',
    () => publication(ref),
    (p) => !!p,
    30_000,
  );
  await waitFor(
    'note in the vault',
    async () => originHas(vault, pub.vault_path),
    (x) => x,
    30_000,
  );
  return originFile(vault, pub.vault_path);
};
const shiftLog = async (ref: string, stage: string): Promise<string> => {
  const rows = await waitFor(
    `${ref} ${stage} shifts ended`,
    () =>
      q<{ status: string; progress_tail: Array<{ text: string }> }>(
        `SELECT s.status, s.progress_tail FROM shifts s JOIN cards c ON c.id = s.card_id WHERE c.ref=$1 AND s.stage=$2`,
        [ref, stage],
      ),
    (r) => r.length > 0 && r.every((x) => x.status === 'ended'),
    30_000,
  );
  return rows.flatMap((r) => r.progress_tail.map((t) => t.text)).join('\n');
};

async function createResearchCard(title: string, fields: Record<string, unknown>): Promise<string> {
  const res = await api.post('/api/cards', {
    data: {
      projectId,
      title,
      cardType: 'research',
      fields: { question: `${title}`, depth: 'standard', subCategory: 'hunting', ...fields },
      specify: true,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).card.ref as string;
}

test('setup: a paired workstation with a personal vault, a research project, a researcher and a checker', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Research Box', HOME);
  startRunner({ AOM_MOCK_STEP_MS: '200' }, HOME);
  await waitFor(
    'workstation connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0],
    (w) => w?.connected === true,
    30_000,
  );
  workstationId = (await (await api.get('/api/workstations')).json()).workstations[0].id;

  vault = makeVault('research', { 'projects/shoot/PROJECT.md': '# Shooting research\n' });
  const v = await api.post('/api/vaults', {
    data: { kind: 'personal', remoteUrl: vault.origin, syncIntervalSec: 2 },
  });
  expect(v.status(), await v.text()).toBe(201);
  await waitFor(
    'the runner cloned the vault',
    () => q<{ local_path: string | null }>('SELECT local_path FROM workstation_vaults'),
    (r) => !!r[0]?.local_path,
    30_000,
  );

  const proj = await api.post('/api/projects', {
    data: {
      key: 'SHOOT',
      name: 'Shooting',
      workflowKey: 'research',
      domain: 'personal',
      subCategories: ['hunting', 'reloading'],
    },
  });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  for (const [name, roleKey] of [
    ['Rhea', 'researcher'],
    ['Chuck', 'checker'],
  ] as const) {
    const hire = await api.post('/api/agents', {
      data: { name, roleKey, seniority: 'junior', workstationId, runtime: 'mock' },
    });
    expect(hire.status(), await hire.text()).toBe(201);
  }
});

test('AC1: a research card made on the form flows question -> research -> fact-check -> a published note with citations', async () => {
  await page.goto('/cards/new?project=SHOOT');
  const form = page.getByRole('form', { name: 'New card' });
  await expect(form.getByLabel('Repository')).toHaveCount(0);
  await form.getByLabel('Title').fill('Is 6mm ARC enough for deer?');
  await form.getByLabel('Question').fill('Is the 6mm ARC enough for deer at 300 yards?');
  await form.getByLabel('Scope').fill('Factory loads, ethical shot energy');
  await form.getByLabel('Depth').selectOption('standard');
  await form.getByLabel('Sub-category').fill('Hunting');
  await form.getByLabel('Preferred sites').fill('https://hunting.example.test');
  await form
    .getByLabel('Mock research claims')
    .fill(JSON.stringify({ claims: [claim(1), claim(2), claim(3)] }));
  await page.screenshot({ path: `${paths.vaults}/research-form.png` });
  await form.getByRole('button', { name: 'Specify' }).click();
  await expect(page).toHaveURL(/\/cards\/SHOOT-\d+$/);
  const ref = page.url().split('/').pop() as string;

  await done(ref);
  const h = await handoffs(ref);
  expect(h.map((x) => `${x.stage}:${x.outcome}`)).toEqual(['research:handoff', 'factcheck:published']);
  // the researcher's draft carries every claim with a numbered reference
  expect(h[0]?.note).toContain('Claim number 2 about the question [2]');
  expect(h[0]?.note).toContain('3. Source 3 - https://research.example.test/source-3');

  const pub = await publication(ref);
  expect(pub.vault_path).toBe('projects/shoot/hunting/is-6mm-arc-enough-for-deer.md');
  expect(pub.citations.map((c: any) => c.url)).toEqual([claim(1).url, claim(2).url, claim(3).url]);
  const note = await noteFor(ref);
  expect(note.startsWith('---\ntitle: "Is 6mm ARC enough for deer?"')).toBe(true);
  expect(note).toContain(`card: ${ref}`);
  expect(note).toContain('subCategory: "Hunting"');
  for (const n of [1, 2, 3]) expect(note).toContain(`  - url: ${claim(n).url}`);
  expect(note).toContain('Claim number 1 about the question [1]');
  expect(git(vault.origin, 'log', '--format=%an|%s', '-1', 'main').trim()).toMatch(
    /^[^|]+\|aom: research SHOOT-\d+ Is 6mm ARC enough for deer\?/,
  );

  // the card page links the published note and shows a preview and the citations
  await page.goto(`/cards/${ref}`);
  const panel = page.getByTestId('publication');
  await expect(panel.getByTestId('publication-path')).toHaveText(
    'projects/shoot/hunting/is-6mm-arc-enough-for-deer.md',
  );
  await expect(panel.getByTestId('publication-preview')).toContainText('Claim number 1');
  await expect(panel.getByTestId('publication-citations').getByRole('link')).toHaveCount(3);
  await expect(panel).toContainText('Citations (3)');
  await page.screenshot({ path: `${paths.vaults}/research-published.png` });
});

test('AC2: a fact-check failure returns the card to the researcher as rework; nothing is published until it holds up', async () => {
  const ref = await createResearchCard('Does 6mm ARC kill elk?', {
    mockResearch: { claims: [claim(4), claim(5, { supported: false }), claim(6)] },
  });
  await done(ref);
  const h = await handoffs(ref);
  expect(h.map((x) => `${x.stage}:${x.outcome}`)).toEqual([
    'research:handoff',
    'factcheck:unsupported',
    'research:handoff',
    'factcheck:published',
  ]);
  expect(h[1]?.note).toContain('Claim number 5 about the question');
  expect(h[2]?.note).not.toContain('Claim number 5');
  const c = (await card(ref))[0];
  expect(c.rework_round).toBe(1);
  const t = await q<{ from_stage: string; to_stage: string }>(
    `SELECT from_stage, to_stage FROM card_transitions t JOIN cards c ON c.id=t.card_id WHERE c.ref=$1 ORDER BY t.id`,
    [ref],
  );
  expect(t.map((x) => `${x.from_stage ?? '-'}>${x.to_stage}`)).toContain('factcheck>research');

  const note = await noteFor(ref);
  expect(note).toContain('Claim number 4');
  expect(note).toContain('Claim number 6');
  expect(note).not.toContain('Claim number 5');
  const pub = await publication(ref);
  expect(pub.citations.map((x: any) => x.url)).toEqual([claim(4).url, claim(6).url]);
  // published once: a single commit for the note
  expect(
    git(vault.origin, 'log', '--format=%s', 'main', '--', pub.vault_path).trim().split('\n'),
  ).toHaveLength(1);

  await page.goto(`/cards/${ref}`);
  await expect(page.getByTestId('publication')).toBeVisible();
});

test('AC3: the runner refuses a note without citations; the checker then publishes it with them', async () => {
  const ref = await createResearchCard('Is 6.5 Creedmoor better?', {
    mock: { factcheck: ['uncited'] },
    mockResearch: { claims: [claim(7), claim(8)] },
  });
  await done(ref);
  expect(await shiftLog(ref, 'factcheck')).toMatch(
    /publishing without citations was refused.*No citations, no publication/s,
  );
  // exactly one publication, with citations in the vault note
  expect(
    await q('SELECT 1 FROM research_publications p JOIN cards c ON c.id=p.card_id WHERE c.ref=$1', [ref]),
  ).toHaveLength(1);
  const note = await noteFor(ref);
  expect(note).toMatch(/citations:\n {2}- url: https:\/\/research\.example\.test\/source-7/);
});

test('AC4: open questions go to the desk like on any card and the research continues after the answer', async () => {
  const ref = await createResearchCard('Which state laws apply?', {
    mock: { research: ['question'] },
    mockResearch: { claims: [claim(9)] },
  });
  await waitFor(
    'card blocked',
    () => card(ref),
    (r) => r[0]?.status === 'blocked',
    60_000,
  );
  await page.goto('/desk');
  const item = page.getByRole('article', { name: `Mock question for ${ref}?` });
  await expect(item).toBeVisible();
  await expect(item.getByTestId('asked-by')).toContainText('Rhea');
  await expect(item.getByTestId('asked-by')).toContainText('researcher');
  await expect(item.getByTestId('item-card')).toContainText(ref);
  await item.getByRole('button', { name: 'Answer' }).click();
  await expect(item).toHaveCount(0);
  await done(ref);
  expect(await publication(ref)).toBeTruthy();
  const h = await handoffs(ref);
  expect(h.map((x) => `${x.stage}:${x.outcome}`)).toEqual(['research:handoff', 'factcheck:published']);
  await page.screenshot({ path: `${paths.vaults}/research-desk.png` });
});

test('the research project lists its published notes', async () => {
  const res = await api.get(`/api/research/publications?projectId=${projectId}`);
  expect(res.ok()).toBeTruthy();
  const list = (await res.json()).publications as Array<{ cardRef: string; vaultPath: string }>;
  expect(list).toHaveLength(4);
  expect(list.every((p) => p.vaultPath.startsWith('projects/shoot/hunting/'))).toBe(true);
});
