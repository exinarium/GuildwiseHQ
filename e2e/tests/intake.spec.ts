import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, INTAKER, paths } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';
import { git } from '../support/vault.ts';

// M7: BA intake, the escalation chain and BA finalize (docs/PLAN.md M7 AC). One user, one runner (mock runtime), projects
// INT and OTH on the toy repo, a mock BA (Ben) that reads tickets from fixtures (the "Jira skill") or through a fake `gh`,
// two builders (Bo junior, Sam senior) and a reviewer. No real Jira, GitHub or Claude is ever contacted.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('intake');
const GH_LOG = join(paths.vaults, 'fake-gh.log');
let page: Page;
let api: APIRequestContext;
let workstationId: string;
const projects: Record<string, { id: string; repoId: string }> = {};

const source = (key: string, body: Record<string, unknown>) => {
  const dir = join(HOME, 'mock-sources');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${key}.json`), JSON.stringify(body));
};

const card = (ref: string) => q<any>('SELECT * FROM cards WHERE ref=$1', [ref]).then((r) => r[0]);
const cardWhen = (ref: string, what: string, pred: (c: any) => boolean, ms = 120_000) =>
  waitFor(
    what,
    () => card(ref),
    (c) => !!c && pred(c),
    ms,
  );
const events = (type: string) =>
  q<{ payload: any; actor_kind: string; actor_id: string }>(
    'SELECT payload, actor_kind, actor_id FROM events WHERE type=$1 ORDER BY seq',
    [type],
  );

const SPEC = {
  context: 'A feature for the toy project.',
  requirements: 'Do the thing.',
  acceptanceCriteria: ['It works'],
  affectedAreas: 'index.js',
  constraints: 'None',
  testPlan: 'Run it',
};
async function makeCard(project: string, title: string, mock: Record<string, string[]>, extra = {}) {
  const res = await api.post('/api/cards', {
    data: {
      projectId: projects[project]?.id,
      title,
      cardType: 'feature',
      repoId: projects[project]?.repoId,
      completionAction: 'push_branch',
      fields: { ...SPEC, mock },
      specify: true,
      ...extra,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).card as { id: string; ref: string };
}

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, INTAKER);
  api = await apiAs(INTAKER.email, INTAKER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test('setup: a paired mock runner (fake gh), projects INT and OTH on the toy repo, a BA, two builders and a reviewer', async () => {
  // A fake `gh`: logs its arguments and prints one issue. Nothing talks to GitHub.
  mkdirSync(paths.vaults, { recursive: true });
  const fakeGh = join(paths.vaults, 'fake-gh.sh');
  writeFileSync(
    fakeGh,
    `#!/bin/sh
echo "$@" >> "${GH_LOG}"
# repository setup (aom repo create): a bare repository under the vaults dir stands in for GitHub
D="${join(paths.vaults, 'fake-github')}"
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
cat <<'JSON'
{"title":"Add dark mode","body":"Users want a dark theme for the toy.","state":"OPEN","url":"https://github.com/acme/toy/issues/7","labels":[{"name":"enhancement"}],"comments":[{"author":{"login":"octo"},"body":"Please!","createdAt":"2026-10-01T10:00:00Z"}]}
JSON
`,
  );
  chmodSync(fakeGh, 0o755);

  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Intake Box', HOME);
  addRepoRoot(paths.repoRoot, HOME);
  startRunner({ AOM_MOCK_STEP_MS: '200', AOM_GH_BIN: fakeGh, AOM_MOCK_CHAT_TOKEN_MS: '20' }, HOME);
  const ws = await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  workstationId = ws[0].id;

  for (const [key, name, repo] of [
    ['INT', 'Intake project', 'toy'],
    ['OTH', 'Other project', 'toy-other'],
  ] as const) {
    const proj = await api.post('/api/projects', { data: { key, name } });
    expect(proj.status(), await proj.text()).toBe(201);
    const id = (await proj.json()).project.id as string;
    const add = await api.post(`/api/projects/${id}/repos`, {
      data: { name: repo, remoteUrl: paths.origin, workingBranch: 'main' },
    });
    expect(add.status()).toBe(201);
    projects[key] = { id, repoId: (await add.json()).repos[0].id };
  }
  await waitFor(
    'the workstation holds the toy repo for both projects',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].repos.length,
    (n) => n >= 2,
    30_000,
  );
  for (const [name, roleKey, seniority] of [
    ['Ben', 'ba', 'senior'],
    ['Bo', 'builder', 'junior'],
    ['Sam', 'builder', 'senior'],
    ['Rae', 'reviewer', 'senior'],
  ] as const) {
    const hire = await api.post('/api/agents', {
      data: { name, roleKey, seniority, workstationId, runtime: 'mock' },
    });
    expect(hire.status(), await hire.text()).toBe(201);
  }
  await waitFor(
    'DevOps engineer uses the mock runtime',
    async () => (await (await api.get('/api/agents')).json()).agents as any[],
    (a) => a.some((x) => x.isDevops && x.runtime === 'mock'),
    30_000,
  );
});

test('AC intake: the manager pastes a Jira key, the BA reads it with the skill, maps it and drafts a card with a completion action', async () => {
  source('INT-12', {
    title: 'Add the login page',
    body: 'Users cannot sign in to the toy.',
    completionAction: 'push_branch',
    acceptanceCriteria: ['The form validates the email', 'Errors are shown inline'],
    // the downstream builder stops at the first review (nobody to approve: Rae is busy reviewing nothing)
    mock: { build: ['ok'] },
  });
  await page.goto('/desk');
  await page.getByTestId('intake-button').click();
  await expect(page).toHaveURL(/\/intake$/);
  await page.getByLabel('Ticket or need').fill('INT-12');
  await expect(page.getByTestId('intake-source')).toContainText('Jira ticket INT-12');
  await page.getByRole('button', { name: 'Start intake' }).click();
  await expect(page).toHaveURL(/\/intake\/[0-9a-f-]{36}$/);

  // the conversation: the manager's message, the BA's streamed reply, and the card it created linked on the side
  await expect(page.getByTestId('intake-status')).toHaveText('Mapped to INT', { timeout: 60_000 });
  const cardLink = page.getByTestId('intake-cards').getByRole('link').first();
  await expect(cardLink).toContainText('Add the login page', { timeout: 60_000 });
  await expect(page.getByTestId('chat-panel')).toContainText('Read Jira ticket INT-12 with the Jira skill', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('chat-panel')).toContainText('Created INT-1 from INT-12', {
    timeout: 60_000,
  });
  await page.screenshot({ path: `${paths.vaults}/intake-chat.png`, fullPage: true });

  const c = await card('INT-1');
  expect(c).toMatchObject({
    origin: 'intake',
    completion_action: 'push_branch',
    repo_id: projects.INT?.repoId,
    card_type: 'feature',
  });
  // the ticket key is stored on the card; every field a builder needs is filled in
  expect(c.fields).toMatchObject({
    externalRef: 'INT-12',
    acceptanceCriteria: ['The form validates the email', 'Errors are shown inline'],
    testPlan: expect.any(String),
    affectedAreas: expect.any(String),
    constraints: expect.any(String),
  });
  expect(c.fields.context).toContain('INT-12: Add the login page');
  // IntakeStarted -> TicketMapped (project, then card) -> CardCreated/CardSpecified by the BA agent
  const started = (await events('IntakeStarted')).at(-1)?.payload;
  expect(started).toMatchObject({ externalSystem: 'jira', externalKey: 'INT-12' });
  const mapped = (await events('TicketMapped')).map((e) => e.payload);
  expect(mapped.some((m) => m.projectId === projects.INT?.id && !m.unmapped)).toBe(true);
  expect(mapped.some((m) => m.cardId === c.id)).toBe(true);
  const created = (await events('CardCreated')).find((e) => e.payload.cardId === c.id);
  expect(created).toMatchObject({ actor_kind: 'agent' });
  expect(created?.payload.origin).toBe('intake');
  const specified = (await events('CardSpecified')).find((e) => e.payload.cardId === c.id);
  expect(specified?.actor_kind).toBe('agent');
  // the card page shows the external reference and it is already in the build queue / being built
  await cardLink.click();
  await expect(page).toHaveURL(/\/cards\/INT-1$/);
  await expect(page.getByText('INT-12').first()).toBeVisible();
  // the intake is listed with its card
  await page.goto('/intake');
  await expect(page.getByTestId('intake-list')).toContainText('INT-12');
  await expect(page.getByTestId('intake-list')).toContainText('1 card(s)');
});

test('AC unmapped: a ticket that fits no project becomes a desk question; the answer maps it and the BA carries on', async () => {
  source('ZZZ-9', { title: 'A mystery', body: 'Nobody knows where this belongs.', completionAction: 'pr' });
  await page.goto('/intake');
  await page.getByLabel('Ticket or need').fill('ZZZ-9 please');
  await page.getByRole('button', { name: 'Start intake' }).click();
  await expect(page.getByTestId('intake-status')).toHaveText('Waiting for you to pick the project', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('chat-panel')).toContainText('asked you on the desk', { timeout: 60_000 });
  await expect(page.getByTestId('intake-mapping-note')).toBeVisible();
  const intakeUrl = page.url();

  const item = (
    await q<any>(
      `SELECT id, status, kind, subkind, blocking FROM desk_items WHERE subkind='unmapped_ticket' ORDER BY created_at DESC`,
    )
  )[0];
  expect(item).toMatchObject({ kind: 'question', status: 'open', blocking: false });
  expect(
    (await events('TicketMapped')).some(
      (e) => e.payload.unmapped === true && e.payload.deskItemId === item.id,
    ),
  ).toBe(true);
  expect(
    await q(
      'SELECT 1 FROM intake_cards ic JOIN intakes i ON i.id=ic.intake_id WHERE i.mapping_desk_item_id=$1',
      [item.id],
    ),
  ).toHaveLength(0);

  await page.getByRole('link', { name: 'Pick the project' }).click();
  await expect(page).toHaveURL(/\/desk#desk-item-/);
  const form = page.getByRole('article', { name: 'Which project does ZZZ-9 belong to?' });
  await expect(form).toBeVisible();
  await expect(form).toContainText('Unmapped ticket');
  await expect(form.getByRole('radio')).toHaveCount(2);
  await page.screenshot({ path: `${paths.vaults}/intake-mapping-question.png`, fullPage: true });
  await form.getByRole('radio', { name: 'OTH: Other project' }).check();
  await form.getByRole('button', { name: 'Map to project' }).click();
  await expect(form).toHaveCount(0);

  // the BA is told in the same conversation and creates the card in the chosen project
  await page.goto(intakeUrl);
  await expect(page.getByTestId('intake-status')).toHaveText('Mapped to OTH', { timeout: 60_000 });
  await expect(page.getByTestId('intake-cards')).toContainText('A mystery', { timeout: 60_000 });
  await expect(page.getByTestId('chat-panel')).toContainText('I mapped ZZZ-9 to project OTH');
  const c = await card('OTH-1');
  expect(c).toMatchObject({ origin: 'intake', completion_action: 'pr' });
  expect(c.fields.externalRef).toBe('ZZZ-9');
  // the decision is in the ledger, so the next ticket of this kind needs no question
  const ledger = await q<any>(`SELECT title FROM ledger_entries WHERE source_desk_item_id=$1`, [item.id]);
  expect(ledger[0]?.title).toContain('ZZZ-9 belongs to OTH: Other project');
});

test('AC GitHub: an issue is read with gh on the runner and mapped by its repository; no real GitHub is contacted', async () => {
  await page.goto('/intake');
  await page.getByLabel('Ticket or need').fill('https://github.com/acme/toy/issues/7');
  await expect(page.getByTestId('intake-source')).toContainText('GitHub issue acme/toy#7');
  await page.getByRole('button', { name: 'Start intake' }).click();
  await expect(page.getByTestId('intake-status')).toHaveText('Mapped to INT', { timeout: 60_000 });
  await expect(page.getByTestId('intake-cards')).toContainText('Add dark mode', { timeout: 60_000 });
  await expect(page.getByTestId('chat-panel')).toContainText('Read GitHub issue acme/toy#7: Add dark mode');
  expect(readFileSync(GH_LOG, 'utf8')).toContain('issue view 7 --repo acme/toy --json');
  const c = (await q<any>(`SELECT * FROM cards WHERE fields->>'externalRef'='acme/toy#7'`))[0];
  expect(c).toMatchObject({ origin: 'intake', title: 'Add dark mode' });
});

test('AC intake needs a BA: with none online the intake says so and queues nothing', async () => {
  const before = (await q<any>('SELECT count(*)::int AS n FROM intakes'))[0].n;
  // an unknown organisation member without a BA cannot start one: use the API of the admin (no BA, no workstation)
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  const res = await admin.post('/api/intakes', { data: { note: 'ABC-1' } });
  expect(res.status()).toBe(409);
  expect((await res.json()).error.code).toBe('no_ba');
  expect((await q<any>('SELECT count(*)::int AS n FROM intakes'))[0].n).toBe(before);
});

test('AC escalation: a builder question is answered by a senior builder or the BA without reaching the desk', async () => {
  const c = await makeCard('INT', 'Needs a decision', { build: ['question', 'ok'], question: ['answer'] });
  const item = await waitFor(
    'the question was answered inside the chain',
    async () => (await q<any>(`SELECT * FROM desk_items WHERE card_id=$1`, [c.id]))[0],
    (i) => i?.status === 'answered',
    120_000,
  );
  expect(item.routed_to).toBe('agent');
  expect(item.answered_by_agent_id).not.toBeNull();
  const trail = item.escalation_trail as Array<{ step: string; agentName?: string }>;
  expect(trail[0]?.step).toBe('asked');
  expect(['peer', 'ba']).toContain(trail[1]?.step);
  expect(trail.at(-1)?.step).toBe('answered');
  expect(['Sam', 'Ben']).toContain(trail.at(-1)?.agentName);
  // never on the desk, never in the ledger as a manager decision
  expect(
    await q<any>(
      `SELECT 1 FROM events WHERE type='QuestionEscalated' AND payload->>'deskItemId'=$1 AND payload->>'routedTo'='manager'`,
      [item.id],
    ),
  ).toHaveLength(0);
  // the card carried on and got built with the answer in its thread
  await cardWhen(
    c.ref,
    'built and past build',
    (x) => x.stage !== 'build' || x.status === 'claimed',
    120_000,
  );
  const answer = await q<any>(`SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='answer'`, [
    c.id,
  ]);
  expect(answer[0]?.body).toContain('mock answer');

  await page.goto('/desk');
  await expect(page.getByRole('article', { name: `Mock question for ${c.ref}?` })).toHaveCount(0);
  await page.getByTestId('desk-closed').locator('summary').click();
  const closed = page.getByTestId(`desk-closed-${item.id}`);
  await expect(closed).toContainText('without reaching the desk');
  await expect(closed.getByTestId('escalation-trail')).toContainText('answered by');
  await page.screenshot({ path: `${paths.vaults}/intake-answered-in-chain.png`, fullPage: true });
});

test('AC escalation: when nobody up the chain can answer, the question reaches the desk with its trail', async () => {
  const c = await makeCard('INT', 'Needs the manager', {
    build: ['question', 'ok'],
    question: ['escalate', 'escalate', 'escalate'],
  });
  const item = await waitFor(
    'the question reached the desk',
    async () => (await q<any>(`SELECT * FROM desk_items WHERE card_id=$1`, [c.id]))[0],
    (i) => i?.routed_to === 'manager',
    120_000,
  );
  expect(item.status).toBe('open');
  const steps = (item.escalation_trail as Array<{ step: string }>).map((s) => s.step);
  expect(steps[0]).toBe('asked');
  expect(steps).toContain('ba');
  expect(steps.at(-1)).toBe('desk');

  await page.goto('/desk');
  const el = page.getByRole('article', { name: `Mock question for ${c.ref}?` });
  await expect(el).toBeVisible();
  const trail = el.getByTestId('escalation-trail');
  await expect(trail).toContainText('Ben (ba)');
  await expect(trail.getByTestId('trail-step').last()).toContainText('the desk');
  await expect(trail).toContainText('mock ');
  await page.screenshot({ path: `${paths.vaults}/intake-escalation-trail.png`, fullPage: true });
  // the manager answers as before; the card is unblocked
  await el.getByRole('button', { name: 'Answer' }).click();
  await expect(el).toHaveCount(0);
  await cardWhen(c.ref, 'unblocked and built', (x) => x.status !== 'blocked', 120_000);
});

test('AC finalize: the BA claims Finalize and finalizes a small card without the manager; large merges still wait on the desk', async () => {
  // A small card, built, then moved to Finalize (the reviewer/tester pools are not part of this spec).
  const small = await makeCard('INT', 'Small and ready', { build: ['ok'] });
  await cardWhen(small.ref, 'in review', (x) => x.stage === 'review', 120_000);
  const move = await api.post(`/api/cards/${small.id}/move`, {
    data: { toStage: 'finalize', reason: 'review and test done elsewhere' },
  });
  expect(move.ok(), await move.text()).toBeTruthy();
  await cardWhen(small.ref, 'finalized by the BA', (x) => x.status === 'done', 120_000);
  const ba = (await q<any>(`SELECT id FROM agents WHERE name='Ben'`))[0];
  const handoff = (
    await q<any>(`SELECT agent_id, outcome, data FROM card_handoffs WHERE card_id=$1 AND stage='finalize'`, [
      small.id,
    ])
  )[0];
  expect(handoff).toMatchObject({ agent_id: ba.id, outcome: 'finalized', data: { action: 'push_branch' } });
  const req = (await events('FinalizeRequested')).find((e) => e.payload.cardId === small.id);
  expect(req?.payload).toMatchObject({ action: 'push_branch', requestedBy: ba.id });
  expect(req?.actor_kind).toBe('agent');
  const branch = (await card(small.ref)).branch_name as string;
  expect(git(paths.origin, 'branch', '--list', branch).trim()).toContain(branch);
  // no desk approval was needed
  expect(
    await q('SELECT 1 FROM desk_items WHERE card_id=$1 AND kind=$2', [small.id, 'approval']),
  ).toHaveLength(0);

  // A large card merging into main waits for the manager even though the BA finalizes it.
  const large = await makeCard('INT', 'Large merge', { build: ['ok'] }, { completionAction: 'merge' });
  await cardWhen(large.ref, 'in review', (x) => x.stage === 'review', 120_000);
  const patched = await api.patch(`/api/cards/${large.id}`, {
    data: { riskTier: 'large', reason: 'e2e: a large change' },
  });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  const move2 = await api.post(`/api/cards/${large.id}/move`, {
    data: { toStage: 'finalize', reason: 'skip review in this spec' },
  });
  expect(move2.ok(), await move2.text()).toBeTruthy();
  const approval = await waitFor(
    'a merge approval on the desk',
    () =>
      q<any>(`SELECT id, status, subkind FROM desk_items WHERE card_id=$1 AND kind='approval'`, [large.id]),
    (r) => r.length > 0,
    120_000,
  );
  expect(approval[0]).toMatchObject({ status: 'open', subkind: 'large_merge' });
  expect((await card(large.ref)).status).toBe('waiting');
  expect(existsSync(GH_LOG)).toBe(true);
});

test('AC desk chat: the BA in a plain chat from the desk creates and specifies a card, linked to the conversation', async () => {
  await page.goto('/desk');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Chat' });
  await drawer.getByLabel('Agent').selectOption({ label: 'Ben (ba)' });
  await drawer.getByRole('button', { name: 'Start chat' }).click();
  await expect(drawer.getByTestId('chat-panel')).toBeVisible();
  await drawer.getByLabel('Message').fill('create card INT: Add a settings page');
  await drawer.getByRole('button', { name: 'Send' }).click();
  await expect(drawer.getByTestId('chat-message').last()).toContainText('from this chat', {
    timeout: 60_000,
  });
  const thread = (
    await q<any>(
      `SELECT id, kind FROM threads WHERE kind='chat' AND title LIKE '%Ben%' ORDER BY created_at DESC LIMIT 1`,
    )
  )[0];
  expect(thread.kind).toBe('chat');
  const linked = await q<any>(
    `SELECT c.ref, c.title, c.stage, c.status, c.origin FROM intakes i
       JOIN intake_cards ic ON ic.intake_id = i.id JOIN cards c ON c.id = ic.card_id WHERE i.thread_id=$1`,
    [thread.id],
  );
  expect(linked).toHaveLength(1);
  expect(linked[0]).toMatchObject({ title: 'Add a settings page', origin: 'intake' });
  expect(linked[0].status).not.toBe('draft');
  const started = (await events('IntakeStarted')).filter((e) => e.payload.threadId === thread.id);
  expect(started).toHaveLength(1);
  expect(started[0]?.payload.source).toBe('chat');
});

test('AC repository setup: the BA asks for a repository, the owner approves on the desk, the runner creates it, the project gets it and the BA creates a card on it', async () => {
  const bas = (await (await api.get('/api/agents')).json()).agents as any[];
  const ben = bas.find((a) => a.name === 'Ben');
  const chat = (await (await api.post('/api/chats', { data: { agentId: ben.id } })).json()).chat as {
    threadId: string;
  };
  await page.goto(`/chat/${chat.threadId}`);
  const send = async (text: string, expected: RegExp) => {
    await page.getByLabel('Message').fill(text);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(
      page.locator('[data-testid="chat-message"][data-author-kind="agent"]').filter({ hasText: expected }),
    ).toHaveCount(1, { timeout: 60_000 });
  };
  await send('request repo acme/e2e-new INT private', /Asked the project owner/);

  await page.goto('/desk');
  const item = page.locator('[data-testid^="desk-item-"]', { hasText: 'Create repository acme/e2e-new' });
  await expect(item).toBeVisible();
  await expect(item).toContainText('Visibility: private');
  await expect(item).toContainText('Project: INT');
  await expect(item).toContainText('GitHub login');
  await item.getByRole('button', { name: 'Create repository' }).click();

  const repo = await waitFor(
    'the repository was added to the project',
    async () => (await (await api.get(`/api/projects/${projects.INT?.id}`)).json()).repos as any[],
    (repos) => repos.some((r) => r.name === 'e2e-new'),
    60_000,
  );
  const added = repo.find((r) => r.name === 'e2e-new');
  expect(added.workingBranch).toBe('main');
  expect(existsSync(join(paths.repoRoot, 'e2e-new', 'README.md'))).toBe(true);
  expect(
    git(join(paths.vaults, 'fake-github', 'acme_e2e-new.git'), 'log', '--format=%s', 'main').trim(),
  ).toBe('Initial commit');
  expect(readFileSync(GH_LOG, 'utf8')).toContain('repo create acme/e2e-new --private');

  await page.goto(`/chat/${chat.threadId}`);
  await expect(page.getByText(/Repository acme\/e2e-new is ready/)).toBeVisible();
  await send('create card INT: Use the new repo repo=e2e-new', /from this chat/);
  const made = await q<any>(
    `SELECT c.ref, pr.name AS repo FROM cards c JOIN project_repos pr ON pr.id = c.repo_id WHERE c.title = 'Use the new repo'`,
  );
  expect(made).toHaveLength(1);
  expect(made[0].repo).toBe('e2e-new');
});
