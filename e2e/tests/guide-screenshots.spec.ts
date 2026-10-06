import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { pool, q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, paths } from '../support/env.ts';
import { ADMIN_DEMO, loadState, MAYA, PIETER, saveState, snap, snapColumn } from '../support/guide.ts';
import { waitForMail } from '../support/mail.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';
import { expandWorkstation } from '../support/ui.ts';
import { git, makeVault } from '../support/vault.ts';

/**
 * The screenshot run of docs/guide (project `guide`, never part of `pnpm e2e`):
 *   AOM_E2E_GUIDE=1 AOM_GUIDE_KEEP=1 AOM_E2E_DB=aom_e2e_b AOM_E2E_PORT=4611 AOM_E2E_DIR=/tmp/aom-e2e-b \
 *     pnpm --filter @aom/e2e exec playwright test --project=guide
 * Part 1 (tests "seed: ...") builds a realistic demo world with fake data through the real API and the mock runtime
 * (no real Claude, GitHub or Jira is ever contacted). Each seed step is recorded in the state file and skipped on a
 * re-run with AOM_GUIDE_REUSE=1. Part 2 lives in guide-capture.ts.
 */

const A = paths.runnerHome('guide-a');
const B = paths.runnerHome('guide-b');
const GH_LOG = join(paths.vaults, 'guide-gh.log');
const GH_FAIL = join(paths.vaults, 'guide-gh.fail');
const S = loadState();

const apis: Record<string, APIRequestContext> = {};
async function api(u: { email: string; password: string }): Promise<APIRequestContext> {
  apis[u.email] ??= await apiAs(u.email, u.password);
  return apis[u.email] as APIRequestContext;
}
const pieter = () => api(PIETER);
const maya = () => api(MAYA);

function step(name: string, fn: (browser: Browser) => Promise<void>, timeout = 900_000): void {
  test(`seed: ${name}`, async ({ browser }) => {
    test.setTimeout(timeout);
    test.skip(!!S.done[name], 'already seeded');
    await fn(browser);
    S.done[name] = true;
    saveState(S);
  });
}

test.afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------------------------------------------
// helpers

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const card = async (ref: string) => (await q<any>('SELECT * FROM cards WHERE ref=$1', [ref]))[0];
const waitCard = (ref: string, what: string, pred: (c: any) => boolean, ms = 180_000) =>
  waitFor(
    `${ref} ${what}`,
    () => card(ref),
    (c) => !!c && pred(c),
    ms,
  );
const done = (ref: string) => waitCard(ref, 'done', (c) => c.status === 'done');
const inStage = (ref: string, stage: string, status: string) =>
  waitCard(ref, `${stage}/${status}`, (c) => c.stage === stage && c.status === status);

interface CardSpec {
  title: string;
  context: string;
  requirements: string;
  criteria: string[];
  areas?: string;
  testPlan?: string;
}
const CARDS: Record<string, CardSpec> = {};
const spec = (title: string, context: string, requirements: string, criteria: string[]): CardSpec => ({
  title,
  context,
  requirements,
  criteria,
});

async function makeCard(
  who: APIRequestContext,
  projectKey: string,
  c: CardSpec,
  o: {
    mock?: Record<string, string[]>;
    extra?: Record<string, unknown>;
    action?: string;
    specify?: boolean;
    docs?: boolean;
    deps?: string[];
    fields?: Record<string, unknown>;
  } = {},
): Promise<{ id: string; ref: string }> {
  const projectId = S.ids[`project:${projectKey}`];
  const res = await who.post('/api/cards', {
    data: {
      projectId,
      title: c.title,
      cardType: 'feature',
      repoId: S.ids[`repo:${projectKey}`],
      completionAction: o.action ?? 'push_branch',
      docsNeeded: o.docs ?? false,
      ...(o.deps ? { dependencies: o.deps } : {}),
      fields: {
        context: c.context,
        requirements: c.requirements,
        acceptanceCriteria: c.criteria,
        affectedAreas: c.areas ?? 'src/',
        constraints: 'Keep the public API unchanged. No new runtime dependencies.',
        testPlan: c.testPlan ?? 'Run the unit tests and walk through the screen in the browser.',
        ...(o.mock ? { mock: o.mock } : {}),
        ...(o.fields ?? {}),
      },
      specify: o.specify ?? true,
      ...(o.extra ?? {}),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const b = (await res.json()).card as { id: string; ref: string };
  return b;
}

/** Wait for the open desk item of a card, give it realistic text (the mock agents use a fixed sentence), return its id. */
async function reword(
  cardId: string,
  text: { title: string; body: string; doing: string; options: Array<[string, string]>; recommend: number },
): Promise<string> {
  const item = await waitFor(
    'desk item of the card',
    () =>
      q<any>(`SELECT id FROM desk_items WHERE card_id=$1 AND kind='question' AND status='open'`, [cardId]),
    (r) => r.length > 0,
    180_000,
  );
  const id = item[0].id as string;
  const options = text.options.map(([label, description], i) => ({ id: `o${i + 1}`, label, description }));
  await q(
    `UPDATE desk_items SET title=$2, body=$3, doing=$4, options=$5::jsonb, recommendation=$6 WHERE id=$1`,
    [id, text.title, text.body, text.doing, JSON.stringify(options), `o${text.recommend + 1}`],
  );
  return id;
}

// ---------------------------------------------------------------------------------------------------------------
// seed

step('users, invitations, the admin', async () => {
  await q(`UPDATE users SET email=$1, display_name=$2 WHERE email=$3`, [
    ADMIN_DEMO.email,
    ADMIN_DEMO.name,
    ADMIN.email,
  ]);
  const admin = await apiAs(ADMIN_DEMO.email, ADMIN.password);
  await inviteAndAccept(admin, PIETER);
  await inviteAndAccept(admin, MAYA);
  for (const email of ['sam@demo.local', 'lee@demo.local']) {
    const r = await admin.post('/api/admin/invitations', { data: { email, role: 'member' } });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  const mail = await waitForMail('sam@demo.local');
  S.ids.samToken = /\/invite\/([A-Za-z0-9_-]+)/.exec(mail.text)?.[1] ?? '';
  expect(S.ids.samToken).toBeTruthy();
  const invs = (await (await admin.get('/api/admin/invitations')).json()) as any;
  const list: any[] = invs.invitations ?? invs;
  const lee = list.find((i) => i.email === 'lee@demo.local');
  expect((await admin.post(`/api/admin/invitations/${lee.id}/revoke`, { data: {} })).ok()).toBeTruthy();
});

step('fakes: gh, a Jira ticket, the vaults', async () => {
  mkdirSync(paths.vaults, { recursive: true });
  rmSync(GH_LOG, { force: true });
  rmSync(GH_FAIL, { force: true });
  const fakeGh = join(paths.vaults, 'guide-gh.sh');
  writeFileSync(
    fakeGh,
    `#!/bin/sh
echo "$@" >> "${GH_LOG}"
case "$2" in
  comment|close)
    if [ -f "${GH_FAIL}" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
    echo "https://github.com/example/web/issues/$3#issuecomment-$3001" ;;
  *)
    case "$3" in
      12) echo '{"title":"Export the order history as CSV","body":"Customers ask for a CSV download of their past orders.","state":"OPEN","url":"https://github.com/example/web/issues/12","labels":[{"name":"enhancement"}],"comments":[]}' ;;
      31) echo '{"title":"Show the delivery cut-off time at checkout","body":"People do not know until when they can order for next-day delivery.","state":"OPEN","url":"https://github.com/example/web/issues/31","labels":[],"comments":[]}' ;;
      *) echo '{"title":"Fix the broken coupon field","body":"The coupon field rejects valid codes with a trailing space.","state":"OPEN","url":"https://github.com/example/web/issues/40","labels":[{"name":"bug"}],"comments":[]}' ;;
    esac ;;
esac
`,
  );
  chmodSync(fakeGh, 0o755);
  S.ids.fakeGh = fakeGh;
  const owner = (n: string) =>
    makeVault(n, { 'README.md': `# ${n} vault\n\nMarkdown notes of Pieter Demo.\n` });
  makeVault('personal', {
    'projects/shoot/PROJECT.md': '# Shooting research\n\nResearch notes about shooting and reloading.\n',
    'projects/news/PROJECT.md': '# AI news feed\n\nDaily digest of AI news.\n',
  });
  owner('work');
  owner('project');
});

step('workstation A, projects, agents', async () => {
  const p = await pieter();
  const code = (await (await p.post('/api/workstations/pairing-codes', { data: {} })).json()).code as string;
  pairRunner(BASE_URL, code, "Pieter's desktop (WSL2)", A);
  addRepoRoot(paths.repoRoot, A);
  startRunner(
    { AOM_MOCK_STEP_MS: '250', AOM_MOCK_CHAT_TOKEN_MS: '60', AOM_GH_BIN: S.ids.fakeGh as string },
    A,
  );
  const ws = await waitFor(
    'runner A connected',
    async () => (await (await p.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  S.ids.wsA = ws[0].id;

  for (const [key, name, workflowKey, domain, extra] of [
    ['WEB', 'Web shop', 'code', 'work', {}],
    ['SHOOT', 'Shooting research', 'research', 'personal', { subCategories: ['hunting', 'reloading'] }],
    ['NEWS', 'AI news feed', 'feed', 'personal', {}],
  ] as const) {
    const r = await p.post('/api/projects', { data: { key, name, workflowKey, domain, ...extra } });
    expect(r.status(), await r.text()).toBe(201);
    S.ids[`project:${key}`] = (await r.json()).project.id;
  }
  const add = await p.post(`/api/projects/${S.ids['project:WEB']}/repos`, {
    data: { name: 'web', remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(add.status()).toBe(201);
  S.ids['repo:WEB'] = (await add.json()).repos[0].id;
  await waitFor(
    'workstation holds the repo',
    async () => (await (await p.get('/api/workstations')).json()).workstations[0].repos.length,
    (n) => n >= 1,
    30_000,
  );
  for (const [kind, name, projectId] of [
    ['personal', 'personal', undefined],
    ['work', 'work', undefined],
    ['project', 'project', S.ids['project:WEB']],
  ] as const) {
    const origin = join(paths.vaults, name, 'origin.git');
    const r = await p.post('/api/vaults', {
      data: { kind, remoteUrl: origin, syncIntervalSec: 3, ...(projectId ? { projectId } : {}) },
    });
    expect(r.status(), await r.text()).toBe(201);
  }
  await waitFor(
    'vaults cloned',
    () => q<any>('SELECT local_path FROM workstation_vaults'),
    (r) => r.length >= 3 && r.every((x) => !!x.local_path),
    60_000,
  );
  const devops = (await (await p.get('/api/agents')).json()).agents.find((a: any) => a.isDevops);
  expect((await p.patch(`/api/agents/${devops.id}`, { data: { runtime: 'mock', model: 'mock' } })).ok()).toBe(
    true,
  );

  const hire = async (name: string, roleKey: string, seniority: string, model: string, scoped = true) => {
    const r = await p.post('/api/agents', {
      data: {
        name,
        roleKey,
        seniority,
        workstationId: S.ids.wsA,
        runtime: 'mock',
        model,
        ...(scoped ? { projectId: S.ids['project:WEB'] } : {}),
      },
    });
    expect(r.status(), await r.text()).toBe(201);
    S.ids[`agent:${name}`] = (await r.json()).agent?.id ?? '';
  };
  await hire('Ada', 'builder', 'senior', 'opus');
  await hire('Linus', 'reviewer', 'senior', 'sonnet');
  await hire('Tess', 'tester', 'junior', 'sonnet');
  await hire('Olga', 'ba', 'senior', 'opus', false);
});

CARDS.csv = spec(
  'Add CSV export to the order history',
  'Customers ask support for a spreadsheet of their past orders every month.',
  'Add an "Export CSV" button to the order history page. The file has one row per order line with date, order number, product, quantity and price.',
  ['The button downloads orders.csv for the signed-in customer', 'Amounts use a dot as decimal separator'],
);
CARDS.last_login = spec(
  'Show the last login time on the profile page',
  'Customers want to check whether someone else used their account.',
  'Show "Last signed in" with date and time in the customer time zone on the profile page.',
  ['The time is shown in the customer time zone', 'A first-time user sees "Never"'],
);
CARDS.typo = spec(
  'Fix the typo in the checkout confirmation email',
  'The confirmation email says "Your order has been recieved".',
  'Correct the spelling in the email template and in the plain-text version.',
  ['Both versions read "received"'],
);
CARDS.cache = spec(
  'Cache the product catalogue for five minutes',
  'The catalogue page is the slowest page in the shop under load.',
  'Cache the catalogue response for five minutes and drop the cache when a product changes.',
  ['A second request within five minutes is served from the cache', 'Editing a product clears the cache'],
);
CARDS.docs = spec(
  'Add webhook settings to the admin area',
  'Shop owners need to tell the shop where to send payment events.',
  'Add a page where an admin enters a webhook URL and a signing secret. Document the new setting for shop owners.',
  ['The URL must be https', 'The secret is never shown again after saving'],
);

step('history: four clean cards, a docs card', async () => {
  const p = await pieter();
  const refs: string[] = [];
  for (const [key, action] of [
    ['csv', 'merge'],
    ['last_login', 'push_branch'],
    ['typo', 'push_branch'],
    ['cache', 'push_branch'],
  ] as const) {
    const c = await makeCard(p, 'WEB', CARDS[key] as CardSpec, { action });
    refs.push(c.ref);
    S.ids[`card:${key}`] = c.ref;
  }
  for (const r of refs) await done(r);
  // the merge spawned a full-suite card for the tester
  await waitFor(
    'full suite card done',
    () => q<any>(`SELECT status FROM cards WHERE origin='full_suite'`),
    (r) => r.length > 0 && r.every((x) => x.status === 'done'),
    180_000,
  );
  const d = await makeCard(p, 'WEB', CARDS.docs as CardSpec, { docs: true });
  S.ids['card:docs'] = d.ref;
  await inStage(d.ref, 'docs', 'queued');
});

CARDS.hang_build = spec(
  'Add rate limiting to the public API',
  'A client script hammered the API last week and slowed the shop down for everybody.',
  'Limit each API key to 120 requests per minute and answer with 429 and a Retry-After header when the limit is hit.',
  ['The 121st request in a minute gets 429', 'The limit is configurable per key'],
);

step('Ada works on a long card, Grace is hired and her cards are bounced by review', async () => {
  const p = await pieter();
  const h = await makeCard(p, 'WEB', CARDS.hang_build as CardSpec, { mock: { build: ['hang'] } });
  S.ids['card:hang_build'] = h.ref;
  await inStage(h.ref, 'build', 'claimed');
  const r = await p.post('/api/agents', {
    data: {
      name: 'Grace',
      roleKey: 'builder',
      seniority: 'junior',
      workstationId: S.ids.wsA,
      projectId: S.ids['project:WEB'],
      runtime: 'mock',
      model: 'sonnet',
    },
  });
  expect(r.status(), await r.text()).toBe(201);
  const bounced = [
    spec(
      'Dark mode for the settings page',
      'Several customers use the shop at night and find the settings page too bright.',
      'Add a dark colour scheme to the settings page that follows the operating system setting.',
      ['Follows the system preference', 'Text keeps a contrast ratio of at least 4.5'],
    ),
    spec(
      'Validate the postcode format at checkout',
      'Orders with a mistyped postcode are returned by the courier.',
      'Check the postcode against the country format before the order is placed.',
      ['A wrong postcode shows an inline error', 'Valid postcodes with a space are accepted'],
    ),
    spec(
      'Paginate the audit log',
      'The audit log page loads for ten seconds when there are many entries.',
      'Show 50 entries per page with next and previous links.',
      ['50 entries per page', 'The page number is kept in the URL'],
    ),
  ];
  for (const [i, b] of bounced.entries()) {
    const c = await makeCard(p, 'WEB', b, { mock: { review: ['changes', 'ok'] } });
    S.ids[`card:bounced${i}`] = c.ref;
    await done(c.ref);
  }
});

step('questions: answered in the chain, answered by the manager, still waiting', async () => {
  const p = await pieter();
  // 1. answered inside the chain by the BA
  const lang = await makeCard(
    p,
    'WEB',
    spec(
      'Remember the selected language',
      'Returning customers have to pick their language on every visit.',
      'Store the language choice for a year and use it on the next visit.',
      ['The choice survives closing the browser'],
    ),
    { mock: { build: ['question', 'ok'], question: ['answer'] } },
  );
  S.ids['card:lang'] = lang.ref;
  await done(lang.ref);
  // 2. escalated to the manager, answered, then built
  const timeout = await makeCard(
    p,
    'WEB',
    spec(
      'Shorten the admin session timeout',
      'The security review asked for shorter admin sessions.',
      'Sign admins out after a period of inactivity.',
      ['An idle admin is signed out', 'The timeout is a setting'],
    ),
    { mock: { build: ['question', 'ok'], question: ['escalate', 'escalate'] } },
  );
  S.ids['card:timeout'] = timeout.ref;
  const q1 = await reword(timeout.id, {
    title: 'After how many minutes of inactivity should an admin be signed out?',
    body: 'The security review only says "shorter". Staff leave their desk for coffee, so very short timeouts are annoying.',
    doing: 'Reading the session code before changing the timeout',
    options: [
      ['15 minutes', 'Strict, as the review suggests'],
      ['30 minutes', 'Balanced: survives a long phone call'],
    ],
    recommend: 0,
  });
  const ans = await p.post(`/api/desk/${q1}/answer`, {
    data: {
      answer: '15 minutes',
      optionId: 'o1',
      ledger: { scope: 'decision', title: 'Admin sessions time out after 15 minutes of inactivity' },
    },
  });
  expect(ans.ok(), await ans.text()).toBeTruthy();
  await done(timeout.ref);
  const entry = (
    await q<any>(`SELECT id FROM ledger_entries WHERE title LIKE 'Admin sessions time out%'`)
  )[0];
  S.ids.ledgerTimeout = entry.id;
  // 3. escalated, still waiting; the ledger already has a similar entry
  const guest = await makeCard(
    p,
    'WEB',
    spec(
      'Let guests check out without an account',
      'About a third of visitors leave at the account creation step.',
      'Offer "Continue as guest" at checkout and keep the order linked to the email address.',
      ['A guest can pay and gets the confirmation email', 'A guest can create an account afterwards'],
    ),
    { mock: { build: ['question', 'ok'], question: ['escalate', 'escalate'] } },
  );
  S.ids['card:guest'] = guest.ref;
  const q3 = await reword(guest.id, {
    title: 'How long may we keep the personal data of a guest who never creates an account?',
    body: 'A guest order stores a name, an address and a phone number. The retention period decides how the cleanup job is built.',
    doing: 'Designing the guest order table',
    options: [
      ['12 months', 'Matches the return period'],
      ['7 years', 'Matches the tax record rule for invoices'],
    ],
    recommend: 0,
  });
  await q(`UPDATE desk_items SET dedup_ledger_ids=ARRAY[$2::uuid] WHERE id=$1`, [q3, S.ids.ledgerTimeout]);
  S.ids.deskGuest = q3;
  await waitCard(guest.ref, 'blocked', (c) => c.status === 'blocked');
});

step('ledger: standing orders and requirements', async () => {
  const p = await pieter();
  const post = async (d: Record<string, unknown>) =>
    expect((await p.post('/api/ledger', { data: { tags: [], ...d } })).ok()).toBeTruthy();
  await post({
    scope: 'standing_order',
    title: 'Write a unit test for every change',
    body: 'Every card that changes behaviour ships with at least one unit test. Say in the handoff which test covers which acceptance criterion.',
  });
  await post({
    scope: 'standing_order',
    projectId: S.ids['project:WEB'],
    title: 'Never push to main',
    body: 'Work only on the card branch. The BA finalizes the card; nobody else merges.',
  });
  await post({
    scope: 'feature',
    projectId: S.ids['project:WEB'],
    title: 'Prices are always shown with two decimals',
    body: 'Every amount in the shop, the emails and the exports uses two decimals and a dot as decimal separator.',
  });
  await post({
    scope: 'decision',
    projectId: S.ids['project:WEB'],
    title: 'Use the existing date picker library',
    body: 'We stay on the current date picker. Replacing it is out of scope until the redesign.',
  });
});

step('workstation B (unsandboxed), Maya, Gus, sharing', async () => {
  const p = await pieter();
  const m = await maya();
  // workstation B reports that the mock runtime runs without an OS sandbox
  const code = (await (await p.post('/api/workstations/pairing-codes', { data: {} })).json()).code as string;
  pairRunner(BASE_URL, code, 'Build mini-PC', B);
  startRunner(
    { AOM_MOCK_STEP_MS: '250', AOM_RUNNER_MOCK_SANDBOX: 'unsandboxed', AOM_GH_BIN: S.ids.fakeGh as string },
    B,
  );
  const wsB = await waitFor(
    'runner B with its sandbox state',
    async () => (await (await p.get('/api/workstations')).json()).workstations as any[],
    (w) =>
      w.some(
        (x) =>
          x.name === 'Build mini-PC' &&
          x.connected &&
          x.runtimes?.some((r: any) => r.sandbox === 'unsandboxed'),
      ),
    30_000,
  );
  S.ids.wsB = wsB.find((x: any) => x.name === 'Build mini-PC').id;
  const devopsB = (await (await p.get('/api/agents')).json()).agents.find(
    (a: any) => a.isDevops && a.workstationId === S.ids.wsB,
  );
  if (devopsB) await p.patch(`/api/agents/${devopsB.id}`, { data: { runtime: 'mock', model: 'mock' } });
  const nope = await p.post('/api/agents', {
    data: { name: 'Sal', roleKey: 'writer', seniority: 'junior', workstationId: S.ids.wsB, runtime: 'mock' },
  });
  expect(nope.status()).toBe(409);
  const sal = await p.post('/api/agents', {
    data: {
      name: 'Sal',
      roleKey: 'writer',
      seniority: 'junior',
      workstationId: S.ids.wsB,
      runtime: 'mock',
      model: 'haiku',
      acknowledgeUnsandboxed: true,
    },
  });
  expect(sal.status(), await sal.text()).toBe(201);

  // sharing: WEB accepted, SHOOT still waiting
  const web = S.ids['project:WEB'];
  expect((await p.post(`/api/projects/${web}/members`, { data: { email: MAYA.email } })).status()).toBe(201);
  expect((await m.post(`/api/projects/${web}/members/accept`, { data: {} })).status()).toBe(200);
  expect(
    (
      await p.post(`/api/projects/${S.ids['project:SHOOT']}/members`, { data: { email: MAYA.email } })
    ).status(),
  ).toBe(201);
  // Maya's own workstation (paired over the API, not running) and her builder Gus
  const mcode = (await (await m.post('/api/workstations/pairing-codes', { data: {} })).json()).code as string;
  const paired = await (await import('@playwright/test')).request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Origin: BASE_URL },
  });
  const r = await paired.post('/api/runner/pair', {
    data: {
      code: mcode,
      name: "Maya's laptop",
      platform: 'darwin',
      hostname: 'maya-laptop',
      runnerVersion: '1.0.0',
    },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  S.ids.wsM = ((await r.json()) as { workstationId: string }).workstationId;
  await paired.dispose();
  const gus = await m.post('/api/agents', {
    data: {
      name: 'Gus',
      roleKey: 'builder',
      seniority: 'junior',
      workstationId: S.ids.wsM,
      projectId: web,
      runtime: 'mock',
      model: 'sonnet',
    },
  });
  expect(gus.status(), await gus.text()).toBe(201);
});

step('intake and the outbox', async () => {
  const p = await pieter();
  const srcDir = join(A, 'mock-sources');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, 'SUP-231.json'),
    JSON.stringify({
      title: 'Customers cannot reset their password on mobile',
      body: 'The reset link opens the desktop page and the form is cut off on phones.',
      project: 'WEB',
      completionAction: 'push_branch',
      acceptanceCriteria: ['The reset form fits a 360 px wide screen', 'The link works from the email app'],
    }),
  );
  writeFileSync(
    join(srcDir, 'OPS-77.json'),
    JSON.stringify({
      title: 'Backup alerts fire every night',
      body: 'The nightly backup job reports a warning at 02:00 and nobody knows which system owns it.',
    }),
  );
  const start = async (note: string) => {
    const r = await p.post('/api/intakes', { data: { note } });
    expect(r.status(), await r.text()).toBeLessThan(300);
    return (await r.json()) as any;
  };
  const i1 = await start('SUP-231');
  S.ids.intakeJira = i1.id ?? i1.intake?.id;
  const i2 = await start('https://github.com/example/web/issues/12');
  S.ids.intakeGh12 = i2.id ?? i2.intake?.id;
  const i3 = await start('https://github.com/example/web/issues/31');
  S.ids.intakeGh31 = i3.id ?? i3.intake?.id;
  const i4 = await start('OPS-77 please look at the backup alerts');
  S.ids.intakeUnmapped = i4.id ?? i4.intake?.id;
  await waitFor(
    'tickets mapped and cards drafted',
    () => q<any>(`SELECT ref, fields->>'externalRef' AS ext FROM cards WHERE origin='intake'`),
    (r) => r.length >= 3,
    180_000,
  );
  const byExt = async (ext: string) =>
    (
      await waitFor(
        `card of ${ext}`,
        () => q<any>(`SELECT ref FROM cards WHERE fields->>'externalRef'=$1`, [ext]),
        (r) => r.length > 0,
        60_000,
      )
    )[0].ref as string;
  const refJira = await byExt('SUP-231');
  const ref12 = await byExt('example/web#12');
  const ref31 = await byExt('example/web#31');
  S.ids.cardJira = refJira;
  S.ids.card12 = ref12;
  S.ids.card31 = ref31;
  for (const r of [refJira, ref12, ref31]) await done(r);
  // approve #12 with an edit; it is posted by the runner with the fake gh
  const item = async (cardRef: string) =>
    (
      await waitFor(
        `outbound approval of ${cardRef}`,
        () =>
          q<any>(
            `SELECT d.id, d.body FROM desk_items d JOIN cards c ON c.id=d.card_id WHERE c.ref=$1 AND d.subkind='outbound' AND d.status='open'`,
            [cardRef],
          ),
        (r) => r.length > 0,
        120_000,
      )
    )[0];
  const d12 = await item(ref12);
  const edited = `${String(d12.body).trim()} You can now download your order history as a CSV file from the account page.`;
  const ok = await p.post(`/api/desk/${d12.id}/resolve`, {
    data: { resolution: 'approved', editedBody: edited },
  });
  expect(ok.ok(), await ok.text()).toBeTruthy();
  await waitFor(
    'draft posted',
    () =>
      q<any>(`SELECT status FROM outbound_drafts WHERE card_id=(SELECT id FROM cards WHERE ref=$1)`, [ref12]),
    (r) => r.some((x) => x.status === 'posted'),
    60_000,
  );
  await item(refJira);
  await item(ref31);
});

step('a ticket card whose first update is blocked, and a failed post', async () => {
  const p = await pieter();
  writeFileSync(GH_FAIL, 'fail');
  const c = await makeCard(
    p,
    'WEB',
    spec(
      'Fix the coupon field rejecting codes with a trailing space',
      'Reported on GitHub: valid coupon codes are rejected when the customer pastes a trailing space.',
      'Trim whitespace around the coupon code before checking it.',
      ['A code with a trailing space is accepted'],
    ),
    {
      fields: {
        externalRef: 'example/web#40',
        mockOutbound: {
          kind: 'comment',
          body: 'Ada built the fix and Linus approved it with a score of 4 out of 5.',
        },
      },
    },
  );
  S.ids.card40 = c.ref;
  await done(c.ref);
  const d = (
    await waitFor(
      'outbound approval',
      () =>
        q<any>(
          `SELECT d.id FROM desk_items d WHERE d.card_id=$1 AND d.subkind='outbound' AND d.status='open'`,
          [c.id],
        ),
      (r) => r.length > 0,
      120_000,
    )
  )[0];
  const r = await p.post(`/api/desk/${d.id}/resolve`, { data: { resolution: 'approved' } });
  expect(r.ok(), await r.text()).toBeTruthy();
  await waitFor(
    'post failed',
    () => q<any>(`SELECT status FROM outbound_drafts WHERE card_id=$1`, [c.id]),
    (rows) => rows.some((x) => x.status === 'failed'),
    60_000,
  );
  rmSync(GH_FAIL, { force: true });
});

step('research and the feed', async () => {
  const p = await pieter();
  const hire = async (name: string, roleKey: string, model: string) => {
    const r = await p.post('/api/agents', {
      data: { name, roleKey, seniority: 'junior', workstationId: S.ids.wsA, runtime: 'mock', model },
    });
    expect(r.status(), await r.text()).toBe(201);
  };
  await hire('Rhea', 'researcher', 'sonnet');
  await hire('Chuck', 'checker', 'haiku');
  await hire('Sky', 'scout', 'haiku');
  await hire('Cora', 'curator', 'sonnet');
  const claim = (n: number, text: string, over: Record<string, unknown> = {}) => ({
    text,
    url: `https://research.example.com/source-${n}`,
    title: `Source ${n}`,
    ...over,
  });
  const research = async (title: string, question: string, claims: unknown[]) => {
    const r = await p.post('/api/cards', {
      data: {
        projectId: S.ids['project:SHOOT'],
        title,
        cardType: 'research',
        fields: { question, depth: 'standard', subCategory: 'hunting', mockResearch: { claims } },
        specify: true,
      },
    });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()).card.ref as string;
  };
  const r1 = await research(
    'Is a 6mm bullet enough for deer at 300 yards?',
    'Is a 6mm bullet enough for deer at 300 yards with factory loads?',
    [
      claim(1, 'Most hunting regulations set a minimum bullet diameter and energy, not a calibre'),
      claim(2, 'A well-built 6mm bullet retains enough energy for deer at 300 yards'),
      claim(3, 'Shot placement matters more than calibre'),
    ],
  );
  S.ids.research1 = r1;
  await done(r1);
  const r2 = await research(
    'How long does a barrel last with hot handloads?',
    'How many rounds does a barrel last when loads run hot?',
    [
      claim(4, 'Barrel life is measured in accuracy, not in rounds fired'),
      claim(5, 'Hot loads always halve barrel life', { supported: false }),
      claim(6, 'Cleaning has a smaller effect on life than round count'),
    ],
  );
  S.ids.research2 = r2;
  await done(r2);
  const draft = await p.post('/api/cards', {
    data: {
      projectId: S.ids['project:SHOOT'],
      title: 'Which suppressor materials resist heat best?',
      cardType: 'research',
      fields: {
        question: 'Which suppressor materials resist heat best?',
        depth: 'deep',
        subCategory: 'reloading',
      },
      specify: false,
    },
  });
  expect(draft.status(), await draft.text()).toBe(201);

  // feed: schedules and two runs
  const news = S.ids['project:NEWS'];
  const item = (n: number, title: string, summary: string, over: Record<string, string> = {}) => ({
    kind: 'article',
    url: `https://news.example.com/ai/story-${n}`,
    title,
    source: 'Example AI Weekly',
    publishedAt: '2026-10-02',
    summary,
    ...over,
  });
  const run1 = [
    item(
      1,
      'Open-weight model matches larger rivals on coding benchmark',
      'A 30B model reaches the score of models three times its size on a public coding benchmark.',
    ),
    item(
      2,
      'Ten prompts that make your chatbot sound like a pirate',
      'A light list of novelty prompts with no technical content.',
    ),
    item(
      3,
      'New evaluation harness tests agents on long tasks',
      'The harness runs agents for hours and scores whether the task was finished.',
      {},
    ),
    item(
      4,
      'Talk: building reliable agent loops',
      'Conference talk about retries, timeouts and tool errors.',
      {
        kind: 'video',
        url: 'https://video.example.com/agent-loops',
      },
    ),
  ];
  const mk = async (title: string, items: unknown[], rule?: string) => {
    const r = await p.post('/api/cards', {
      data: {
        projectId: news,
        title,
        cardType: 'feed',
        fields: {
          topic: 'AI agents and coding assistants',
          preferredSites: ['https://news.example.com'],
          maxItems: 10,
          mockFeed: { items, ...(rule ? { proposeRule: rule } : {}) },
        },
        specify: true,
      },
    });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()).card.ref as string;
  };
  const f1 = await mk('AI news, Monday', run1);
  await done(f1);
  const digest1 = await waitFor(
    'digest items',
    () => q<any>(`SELECT id, title FROM digest_items ORDER BY created_at`),
    (r) => r.length >= 4,
    60_000,
  );
  const rate = async (title: string, verdict: string, reason?: string) => {
    const it = digest1.find((d: any) => d.title === title);
    const r = await p.post(`/api/digest-items/${it.id}/rate`, {
      data: { verdict, ...(reason ? { reason } : {}) },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
  };
  await rate(
    'Open-weight model matches larger rivals on coding benchmark',
    'useful',
    'Has benchmark numbers',
  );
  await rate('Ten prompts that make your chatbot sound like a pirate', 'irrelevant', 'Not about engineering');
  await rate('New evaluation harness tests agents on long tasks', 'useful');
  await rate('Talk: building reliable agent loops', 'boring', 'Too basic');
  const run2 = [
    item(
      5,
      'Vendor adds an agent debugger to its code editor',
      'The debugger replays an agent run step by step and shows every tool call.',
    ),
    item(
      6,
      'Study: code review by a second model catches more bugs',
      'Two-model review found 31 percent more defects in a controlled study.',
    ),
    item(7, 'Opinion: will agents replace junior developers?', 'A long opinion piece without data.'),
  ];
  const f2 = await mk('AI news, Tuesday', run2, 'Prefer posts that include benchmark or study data');
  await done(f2);
  for (const [name, cron, tz, enabled] of [
    ['Daily AI news', '0 7 * * *', 'Africa/Johannesburg', true],
    ['Weekend long reads', '0 8 * * 6', 'Africa/Johannesburg', false],
  ] as const) {
    const r = await p.post('/api/schedules', {
      data: {
        projectId: news,
        name,
        cron,
        timezone: tz,
        enabled,
        cardTemplate: {
          title: name,
          fields: {
            topic: 'AI agents and coding assistants',
            preferredSites: ['https://news.example.com'],
            maxItems: 10,
            mockFeed: { items: [] },
          },
        },
      },
    });
    expect(r.status(), await r.text()).toBe(201);
  }
});

step('devops requests and the access of workstation A', async () => {
  const p = await pieter();
  for (const summary of [
    'Start the app on port 3000 so the tester can open it',
    'Install Docker so the end-to-end suite can run',
  ]) {
    const r = await p.post('/api/devops/requests', { data: { workstationId: S.ids.wsA, summary } });
    expect(r.status(), await r.text()).toBeLessThan(300);
    await sleep(500);
  }
  await waitFor(
    'devops requests settled',
    () => q<any>(`SELECT status FROM devops_requests`),
    (r) => r.length >= 2 && r.every((x) => ['done', 'needs_approval'].includes(x.status)),
    90_000,
  );
});

step('organization: custom roles, workflow, departments, extensions', async () => {
  const p = await pieter();
  const role = (key: string, name: string, purpose: string, stage: string, senior = false) => ({
    key,
    name,
    purpose,
    department: 'support',
    instructions: `Work only on ${purpose.toLowerCase()} Report when done.`,
    coreRules: ['Never promise refunds.'],
    seniorityLevels: senior ? ['senior'] : ['junior', 'senior'],
    defaultModel: { runtime: 'mock', model: 'mock' },
    permissions: {
      allowedTools: ['read'],
      deniedShellPatterns: [],
      writableGlobs: null,
      mayCommit: false,
      browser: false,
      riskTiers: ['small', 'large'],
      repoIds: null,
    },
    skills: [],
    claimableStages: [{ workflowKey: 'support', stageId: stage }],
  });
  const outcome = (id: string, to: string, kind = 'success', extra: Record<string, unknown> = {}) => ({
    id,
    label: id,
    kind,
    to,
    event: 'StageCompleted',
    ...extra,
  });
  const wf = {
    key: 'support',
    name: 'Support triage',
    department: 'support',
    fieldSet: 'custom',
    customFields: [{ key: 'customer', label: 'Customer', type: 'text', required: true }],
    cardTypes: ['support'],
    initialStage: 'intake',
    stages: [
      {
        id: 'intake',
        label: 'Intake',
        column: 'Intake',
        kind: 'manual',
        claimRole: null,
        doneCriteria: '',
        outcomes: [outcome('ready', 'triage', 'success', { event: 'CardSpecified' })],
      },
      {
        id: 'triage',
        label: 'Triage',
        column: 'Triage',
        kind: 'agent',
        claimRole: 'triager',
        requiredFields: ['customer'],
        doneCriteria: 'The ticket has a category and a priority.',
        outcomes: [outcome('triaged', 'resolve')],
      },
      {
        id: 'resolve',
        label: 'Resolve',
        column: 'Resolve',
        kind: 'agent',
        claimRole: 'responder',
        doneCriteria: 'The customer has an answer.',
        outcomes: [outcome('resolved', 'done'), outcome('escalate', 'triage', 'failure', { rework: true })],
      },
      {
        id: 'done',
        label: 'Done',
        column: 'Done',
        kind: 'terminal',
        claimRole: null,
        doneCriteria: '',
        outcomes: [],
      },
    ],
  };
  const dept = await p.post('/api/departments', { data: { name: 'support' } });
  expect(dept.status(), await dept.text()).toBeLessThan(300);
  const drafts: Array<[string, any, string]> = [
    ['roles', role('triager', 'Triager', 'Sorts incoming support tickets.', 'triage'), 'role'],
    ['roles', role('responder', 'Responder', 'Answers the customer.', 'resolve', true), 'role'],
  ];
  for (const [, body] of drafts) {
    const r = await p.post('/api/roles', { data: body });
    expect(r.status(), await r.text()).toBeLessThan(300);
    const id = (await r.json()).id as string;
    expect((await p.post(`/api/roles/${id}/submit`, { data: {} })).ok()).toBeTruthy();
  }
  const w = await p.post('/api/workflows', { data: wf });
  expect(w.status(), await w.text()).toBeLessThan(300);
  const wid = (await w.json()).id as string;
  // approve roles first, then the workflow
  const open = async () => (await (await p.get('/api/desk')).json()).items as any[];
  for (const it of (await open()).filter((i) => i.subkind === 'definition' && /role/.test(i.title))) {
    expect(
      (await p.post(`/api/desk/${it.id}/resolve`, { data: { resolution: 'approved' } })).ok(),
    ).toBeTruthy();
  }
  expect((await p.post(`/api/workflows/${wid}/submit`, { data: {} })).ok()).toBeTruthy();
  for (const it of (await open()).filter((i) => i.subkind === 'definition' && /workflow/.test(i.title))) {
    expect(
      (await p.post(`/api/desk/${it.id}/resolve`, { data: { resolution: 'approved' } })).ok(),
    ).toBeTruthy();
  }
  // one more role still waiting for approval
  const rel = await p.post('/api/roles', {
    data: role('release-manager', 'Release manager', 'Plans and announces releases.', 'resolve', true),
  });
  expect(rel.status(), await rel.text()).toBeLessThan(300);
  expect((await p.post(`/api/roles/${(await rel.json()).id}/submit`, { data: {} })).ok()).toBeTruthy();
  // reviewer extended by the owner; tester extended against an older default (the HR board offers a reset)
  const ext = await p.put('/api/roles/reviewer/extensions', {
    data: {
      instructions: 'Check that every new screen has a keyboard path.',
      skills: ['accessibility'],
      standingOrders: ['Reject changes that add a dependency without a card'],
    },
  });
  expect(ext.ok(), await ext.text()).toBeTruthy();
  const ownerId = (await q<any>(`SELECT id FROM users WHERE email=$1`, [PIETER.email]))[0].id;
  await q(
    `INSERT INTO role_extensions (org_id, role_key, base_version, extensions, updated_at) VALUES ($1,'tester',1,$2,now())
     ON CONFLICT (org_id, role_key) DO UPDATE SET base_version=1, extensions=$2`,
    [
      ownerId,
      JSON.stringify({
        instructions: 'Always run the linter first.',
        skills: ['lint'],
        standingOrders: ['Never skip the end-to-end suite'],
      }),
    ],
  );
});

step(
  'chats and the design chat (screenshots are taken here: the chat needs a free shift slot)',
  async (browser) => {
    const p = await pieter();
    const ctx = await browser.newContext({
      storageState: await p.storageState(),
      viewport: { width: 1280, height: 800 },
    });
    const page = await ctx.newPage();
    const chat = async (agent: string, message: string, shotName: string) => {
      await page.goto('/desk');
      await page.getByRole('button', { name: 'Chat', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: 'Chat' });
      const existing = drawer.getByTestId('chat-list').getByRole('button', { name: new RegExp(agent) });
      if (await existing.count()) await existing.first().click();
      else {
        const opt = (await drawer.getByLabel('Agent').locator('option').allInnerTexts()).find((t) =>
          t.startsWith(agent),
        );
        await drawer.getByLabel('Agent').selectOption({ label: opt as string });
        await drawer.getByRole('button', { name: 'Start chat' }).click();
      }
      await expect(drawer.getByTestId('chat-panel')).toBeVisible();
      await drawer.getByLabel('Message').fill(message);
      await drawer.getByRole('button', { name: 'Send' }).click();
      await expect(drawer.getByTestId('chat-message').last()).toContainText('heard', { timeout: 60_000 });
      await expect(drawer.getByTestId('chat-streaming')).toHaveCount(0);
      await snap(page, shotName, { sel: drawer });
    };
    await chat('Olga', 'Can you check whether the SUP-231 ticket has a screenshot attached?', 'chat-ba');
    await chat('Olga', 'Thanks. Please draft a card for the password reset form on phones.', 'chat-ba-2');
    await chat('Linus', 'Which review comments came up most often this week?', 'chat-reviewer');
    // the start screen with earlier conversations
    await page.goto('/desk');
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await snap(page, 'chat-start', { sel: page.getByRole('dialog', { name: 'Chat' }) });
    // design chat: the BA asks what it needs to know
    await page.goto('/org?tab=design');
    await page.getByRole('button', { name: 'Start a design chat' }).click();
    const dc = page.getByTestId('design-chat');
    await dc.getByRole('textbox').fill('design a support pipeline for me');
    await dc.getByRole('button', { name: 'Send' }).click();
    await expect(dc).toContainText('which role claims each stage', { timeout: 60_000 });
    await snap(page, 'org-design-chat', { noHeader: false, maxH: 900 });
    await ctx.close();
  },
);

step('test stage: bug loop, conflict, review queue, large merge, busy agents, to do', async () => {
  const p = await pieter();
  const m = await maya();
  const web = 'WEB';
  const mk = (title: string, ctx: string, req: string, ac: string[]) => spec(title, ctx, req, ac);

  // a card of the second manager that waits for a decision only she may give
  const mc = await makeCard(
    m,
    web,
    mk(
      'Add a returns policy page',
      'The shop has no page that explains returns.',
      'Add a returns policy page and link it from the footer.',
      ['The page is linked from the footer'],
    ),
    { mock: { build: ['question', 'ok'], question: ['escalate', 'escalate'] } },
  );
  S.ids['card:maya'] = mc.ref;
  await reword(mc.id, {
    title: 'How many days do customers have to return an item?',
    body: 'The page must state the period. The terms of service say 14 days, the supplier contract says 30.',
    doing: 'Drafting the returns policy page',
    options: [
      ['14 days', 'As in the terms of service'],
      ['30 days', 'As in the supplier contract'],
    ],
    recommend: 0,
  });

  // Tess takes a long test and keeps it
  const ta = await makeCard(
    p,
    web,
    mk(
      'Add webhook retries for failed payments',
      'Payment provider webhooks fail when the shop is deployed.',
      'Retry a failed webhook delivery with growing pauses for up to a day.',
      ['Retries stop after 24 hours'],
    ),
    { mock: { test: ['hang'] } },
  );
  S.ids['card:ta'] = ta.ref;
  await inStage(ta.ref, 'test', 'claimed');
  // a card that will conflict with a change on the working branch
  const cc = await makeCard(
    p,
    web,
    mk(
      'Update the footer links',
      'The footer still links to the old terms page.',
      'Point the footer links to the new terms and privacy pages.',
      ['All footer links open the new pages'],
    ),
  );
  S.ids['card:conflict'] = cc.ref;
  await inStage(cc.ref, 'test', 'queued');
  const other = join(paths.vaults, 'conflict-clone');
  rmSync(other, { recursive: true, force: true });
  git(paths.vaults, 'clone', paths.origin, other);
  writeFileSync(join(other, 'aom-mock', `${cc.ref}.txt`), 'a colleague changed the footer first\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-m', `Change the footer links (${cc.ref})`);
  git(other, 'push', 'origin', 'main');
  const tb = await makeCard(
    p,
    web,
    mk(
      'Show the delivery estimate in the basket',
      'Customers ask when the order arrives before they pay.',
      'Show an estimated delivery date next to the basket total.',
      ['The estimate skips Sundays'],
    ),
    { mock: { test: ['fail', 'ok'] } },
  );
  S.ids['card:tb'] = tb.ref;
  const tc = await makeCard(
    p,
    web,
    mk(
      'Send a receipt email after payment',
      'Customers only get the order confirmation, not a receipt.',
      'Send a PDF receipt when the payment is confirmed.',
      ['The receipt has the VAT number'],
    ),
    { mock: { test: ['hang'] } },
  );
  S.ids['card:tc'] = tc.ref;
  for (const r of [tb.ref, tc.ref]) await inStage(r, 'test', 'queued');

  // large merge: reviewed elsewhere, waits for the manager at Finalize
  const lm = await makeCard(
    p,
    web,
    mk(
      'Switch the session store to Redis',
      'Sessions are kept in the database and slow every request.',
      'Store sessions in Redis with the same lifetime as today.',
      ['Existing sessions survive the switch'],
    ),
    { action: 'merge' },
  );
  S.ids['card:large'] = lm.ref;
  await inStage(lm.ref, 'test', 'queued');
  await p.patch(`/api/cards/${lm.ref}`, { data: { riskTier: 'large', reason: 'Touches the sign-in flow' } });
  const mv = await p.post(`/api/cards/${lm.id}/move`, {
    data: { toStage: 'finalize', reason: 'Reviewed together in a pairing session' },
  });
  expect(mv.ok(), await mv.text()).toBeTruthy();

  // a card waits for review
  const rq = await makeCard(
    p,
    web,
    mk(
      'Add keyboard shortcuts to the product list',
      'Power users want to move through the list without the mouse.',
      'Add j and k to move and Enter to open a product.',
      ['j and k move the selection'],
    ),
    { mock: { review: ['hang'] } },
  );
  S.ids['card:rh'] = rq.ref;
  await inStage(rq.ref, 'review', 'claimed');
  const rq2 = await makeCard(
    p,
    web,
    mk(
      'Add a "remember me" option to sign-in',
      'Staff sign in many times a day.',
      'Add a checkbox that keeps the session for 30 days on trusted devices.',
      ['The cookie lasts 30 days'],
    ),
  );
  S.ids['card:rq'] = rq2.ref;
  await inStage(rq2.ref, 'review', 'queued');

  // release the tester: conflict, then the bug loop, then the second long test
  expect(
    (await p.post(`/api/cards/${ta.ref}/cancel`, { data: { reason: 'Replaced by a later card' } })).ok(),
  ).toBeTruthy();
  await waitCard(cc.ref, 'back in build after the conflict', (c) => c.rework_round >= 1);
  await waitCard(tb.ref, 'waiting on its bug', (c) => c.status === 'waiting');
  await inStage(tc.ref, 'test', 'claimed');
  const bug = (
    await q<any>(
      `SELECT ref FROM cards WHERE parent_card_id=(SELECT id FROM cards WHERE ref=$1) AND card_type='bug'`,
      [tb.ref],
    )
  )[0].ref as string;
  await q(`UPDATE cards SET title='Bug: the delivery estimate says Sunday' WHERE ref=$1`, [bug]);
  S.ids['card:bug'] = bug;
  // the builders fix the bug and rebuild the conflicting card; both end up waiting for the reviewer
  await inStage(bug, 'review', 'queued');
  await waitCard(
    cc.ref,
    'rebuilt and waiting for review',
    (c) => c.stage === 'review' && c.status === 'queued',
  );
  // Grace takes a long build too: from here nobody is free to build
  const gh = await makeCard(
    p,
    web,
    mk(
      'Add pagination to the customer list',
      'The customer list loads all 4,000 customers at once.',
      'Show 25 customers per page with a search box.',
      ['Search works across pages'],
    ),
    { mock: { build: ['hang'] } },
  );
  S.ids['card:gh'] = gh.ref;
  await inStage(gh.ref, 'build', 'claimed');
  // the manager sends the bug fix and the conflicting card back to build, and a reviewed card to test
  const idOf = async (ref: string) => (await card(ref)).id as string;
  for (const ref of [bug, cc.ref]) {
    const r = await p.post(`/api/cards/${await idOf(ref)}/move`, {
      data: { toStage: 'build', reason: 'The change needs another round before review' },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  const r2 = await p.post(`/api/cards/${rq2.id}/move`, {
    data: { toStage: 'test', reason: 'Reviewed together in a pairing session' },
  });
  expect(r2.ok(), await r2.text()).toBeTruthy();

  // to do and drafts
  await makeCard(
    p,
    web,
    mk(
      'Upgrade the date picker library',
      'The date picker is two major versions behind.',
      'Upgrade the date picker and fix the breaking changes.',
      ['All date fields still work'],
    ),
  );
  await makeCard(
    p,
    web,
    mk(
      'Add Swedish translations',
      'A new customer in Sweden wants the shop in Swedish.',
      'Translate the customer-facing screens to Swedish.',
      ['No untranslated key is shown'],
    ),
  );
  const dr = await p.post('/api/cards', {
    data: {
      projectId: S.ids['project:WEB'],
      title: 'Redesign the order confirmation page',
      cardType: 'feature',
      fields: { context: 'Marketing wants the page to suggest related products.' },
      specify: false,
    },
  });
  expect(dr.status(), await dr.text()).toBe(201);
  const dr2 = await p.post('/api/cards', {
    data: {
      projectId: S.ids['project:WEB'],
      title: 'Support gift wrapping',
      cardType: 'feature',
      repoId: S.ids['repo:WEB'],
      fields: {
        context: 'Customers ask for gift wrapping before the holidays.',
        requirements: 'Let customers choose gift wrapping for each order line.',
        acceptanceCriteria: ['Gift wrapping adds a fixed fee'],
      },
      specify: false,
    },
  });
  expect(dr2.status(), await dr2.text()).toBe(201);
  // E2E work waits for the busy tester for more than five minutes: the bottleneck alert
  await q(`UPDATE cards SET queued_at = now() - interval '7 minutes' WHERE ref=$1`, [rq2.ref]);
  await waitFor(
    'bottleneck alert',
    () => q<any>(`SELECT id FROM desk_items WHERE subkind='tester_bottleneck' AND status='open'`),
    (r) => r.length > 0,
    90_000,
  );
});

step('an edited card and a risk override', async () => {
  const p = await pieter();
  const rq = await card(S.ids['card:rq'] as string);
  const edited = await p.patch(`/api/cards/${rq.id}`, {
    data: { fields: { ...rq.fields, affectedAreas: 'src/auth/, src/session/' } },
  });
  expect(edited.ok(), await edited.text()).toBeTruthy();
  const risk = await p.patch(`/api/cards/${rq.id}`, {
    data: { riskTier: 'large', reason: 'It changes how sessions are stored' },
  });
  expect(risk.ok(), await risk.text()).toBeTruthy();
});

step('polish: realistic wording for the questions the mock agents raised', async () => {
  const swap = async (ref: string, title: string, options: string) => {
    const mock = `Mock question for ${ref}?`;
    await q(
      `UPDATE thread_messages SET body = replace(replace(body, $1, $2), 'Options: yes / no', $3) WHERE body LIKE '%' || $1 || '%'`,
      [mock, title, `Options: ${options}`],
    );
    await q(
      `UPDATE ledger_entries SET title = replace(title, $1, $2), body = replace(replace(body, $1, $2), 'mock answer: go with the recommended option', 'A year. Go with the recommended option.') WHERE title LIKE '%' || $1 || '%' OR body LIKE '%' || $1 || '%'`,
      [mock, title],
    );
    await q(
      `UPDATE desk_items SET title = replace(title, $1, $2), answer = replace(answer, 'mock answer: go with the recommended option', 'A year. Go with the recommended option.') WHERE title LIKE '%' || $1 || '%'`,
      [mock, title],
    );
  };
  await swap(
    S.ids['card:lang'] as string,
    'Should the language choice be kept for a year or only for the session?',
    'a year / this session',
  );
  await swap(
    S.ids['card:timeout'] as string,
    'After how many minutes of inactivity should an admin be signed out?',
    '15 minutes / 30 minutes',
  );
  await swap(
    S.ids['card:guest'] as string,
    'How long may we keep the personal data of a guest who never creates an account?',
    '12 months / 7 years',
  );
  await swap(
    S.ids['card:maya'] as string,
    'How many days do customers have to return an item?',
    '14 days / 30 days',
  );
});

test('seed: finished', async () => {
  expect(Object.keys(S.done).length).toBeGreaterThan(5);
});

// ---------------------------------------------------------------------------------------------------------------
// capture: every screen of the guide. Nothing here changes the demo world, except where a comment says so.

let pPage: Page;
let mPage: Page;
let aPage: Page;
let phone: Page;
const ctxs: Record<string, BrowserContext> = {};
async function pageFor(
  browser: Browser,
  key: string,
  user: { email: string; password: string } | null,
  viewport = { width: 1280, height: 800 },
): Promise<Page> {
  if (!ctxs[key]) {
    const storageState = user ? await (await api(user)).storageState() : undefined;
    ctxs[key] = await browser.newContext({ viewport, ...(storageState ? { storageState } : {}) });
  }
  return ctxs[key]!.newPage();
}

function cap(name: string, fn: () => Promise<void>): void {
  test(`capture: ${name}`, async ({ browser }) => {
    test.setTimeout(180_000);
    const mk = async () => {
      pPage = await pageFor(browser, 'p', PIETER);
      mPage = await pageFor(browser, 'm', MAYA);
      aPage = await pageFor(browser, 'a', { email: ADMIN_DEMO.email, password: ADMIN.password });
      phone = await pageFor(browser, 'ph', PIETER, { width: 390, height: 844 });
    };
    await mk();
    try {
      await fn();
    } finally {
      for (const pg of [pPage, mPage, aPage, phone]) await pg.close();
    }
  });
}

const refId = async (ref: string) => (await card(ref)).id as string;
const open = async (page: Page, path: string) => {
  await page.goto(path);
  await page.waitForLoadState('networkidle').catch(() => undefined);
};
const idOfAgent = async (name: string) =>
  (await q<any>(`SELECT id FROM agents WHERE name=$1`, [name]))[0].id as string;

cap('sign-in, invitations, admin', async () => {
  const anon = await ctxs.anon?.newPage();
  void anon;
  const ctx = await pPage
    .context()
    .browser()!
    .newContext({ viewport: { width: 1280, height: 520 } });
  const a = await ctx.newPage();
  await open(a, '/login');
  await snap(a, 'login', { maxH: 520, cx: { x: 420, width: 440 } });
  await a.getByLabel('Email').fill('pieter@demo.local');
  await a.getByLabel('Password').fill('not-the-password');
  await a.getByRole('button', { name: 'Sign in' }).click();
  await expect(a.getByText('Incorrect email or password')).toBeVisible();
  await snap(a, 'login-error', { maxH: 520, cx: { x: 420, width: 440 } });
  await open(a, `/invite/${S.ids.samToken}`);
  await snap(a, 'invite-accept', { maxH: 520, cx: { x: 420, width: 440 } });
  await a.getByLabel('Display name').fill('Sam Demo');
  await a.getByLabel('Password', { exact: true }).fill('short');
  await a.getByLabel('Confirm password').fill('different');
  await a.getByRole('button', { name: 'Create account' }).click();
  await snap(a, 'invite-errors', { maxH: 520, cx: { x: 420, width: 440 } });
  await open(a, '/invite/not-a-real-token');
  await snap(a, 'invite-invalid', { maxH: 300, cx: { x: 420, width: 440 } });
  await ctx.close();
  await open(aPage, '/admin');
  await snap(aPage, 'admin', { maxH: 1500, noHeader: true, cx: { x: 190, width: 900 } });
});

cap('the board', async () => {
  await open(pPage, '/p/WEB/board');
  const board = pPage.getByTestId('board');
  await snap(pPage, 'board-left', { maxH: 820 });
  await board.evaluate((el) => {
    el.scrollLeft = 1050;
  });
  await snap(pPage, 'board-mid', { maxH: 820 });
  await board.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await snap(pPage, 'board-right', { maxH: 820 });
  // the hero of the cover: a wide window
  await pPage.setViewportSize({ width: 1700, height: 900 });
  await board.evaluate((el) => {
    el.scrollLeft = 0;
  });
  await snap(pPage, 'board-hero', { maxH: 640 });
  await pPage.setViewportSize({ width: 1280, height: 800 });
  for (const [id, col] of [
    ['spec', 'Spec'],
    ['todo', 'To do'],
    ['rework', 'Rework'],
    ['inprogress', 'In progress'],
    ['blocked', 'Blocked'],
    ['review', 'Review'],
    ['test', 'Test'],
    ['waiting', 'Test (waiting on bug)'],
    ['docs', 'Docs'],
    ['finalize', 'Finalize'],
    ['done', 'Done'],
  ] as const) {
    await snapColumn(pPage, `col-${id}`, pPage.getByTestId(`column-${col}`));
  }
  await open(pPage, '/p/NEWS/board');
  await snap(pPage, 'board-feed', { maxH: 700 });
  await open(pPage, '/p/SHOOT/board');
  await snap(pPage, 'board-research', { maxH: 700 });
  await open(pPage, '/p/WEB/board');
  await pPage.getByTestId('regression-open').click();
  await snap(pPage, 'dlg-regression', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
});

cap('new card', async () => {
  await open(pPage, '/cards/new?project=WEB');
  await snap(pPage, 'card-new', { maxH: 1500, noHeader: true, cx: { x: 230, width: 820 } });
  await pPage.getByRole('button', { name: 'Specify' }).click();
  await snap(pPage, 'card-new-errors', { maxH: 1900, noHeader: true, cx: { x: 230, width: 820 } });
  await open(pPage, '/cards/new?project=SHOOT');
  await snap(pPage, 'card-new-research', { maxH: 1300, noHeader: true, cx: { x: 230, width: 820 } });
  await open(pPage, '/cards/new?project=NEWS');
  await snap(pPage, 'card-new-feed', { maxH: 1100, noHeader: true, cx: { x: 230, width: 820 } });
  {
    // creates one more draft card (once)
    await open(pPage, '/cards/new?project=WEB');
    const form = pPage.getByRole('form', { name: 'New card' });
    await form.getByLabel('Title').fill('Show stock level on the product page');
    await form.getByLabel('Context').fill('Customers ask whether an item is in stock before they order.');
    await form.getByRole('button', { name: 'Specify' }).click();
    await expect(
      pPage.getByText('still missing').or(pPage.getByText('Fix the highlighted fields')),
    ).toBeVisible();
    await snap(pPage, 'card-new-missing', { maxH: 1900, noHeader: true, cx: { x: 230, width: 820 } });
  }
});

cap('card detail', async () => {
  const detail = async (name: string, ref: string, o: Parameters<typeof snap>[2] = { maxH: 1700 }) => {
    await open(pPage, `/cards/${ref}`);
    await snap(pPage, name, o);
  };
  await detail('card-detail', S.ids['card:bounced0'] as string, { maxH: 1100 });
  await detail('card-handoffs', S.ids['card:bounced0'] as string, { maxH: 2000, top: 0 });
  await detail('card-live', 'WEB-10', { maxH: 900 });
  await detail('card-blocked', S.ids['card:guest'] as string, { maxH: 900 });
  await detail('card-waiting', S.ids['card:tb'] as string, { maxH: 1100 });
  await detail('card-bug', S.ids['card:bug'] as string, { maxH: 900 });
  await detail('card-large', S.ids['card:large'] as string, { maxH: 1100 });
  await detail('card-conflict', S.ids['card:conflict'] as string, { maxH: 1400 });
  await detail('card-evidence', 'WEB-1', { maxH: 1700 });
  await detail('card-outbound-edited', S.ids.card12 as string, { maxH: 1700 });
  await detail('card-outbound-failed', S.ids.card40 as string, { maxH: 1700 });
  await detail('card-published', S.ids.research1 as string, { maxH: 1500 });
  await detail('card-research-rework', S.ids.research2 as string, { maxH: 1500 });
  await detail('card-draft', 'WEB-43', { maxH: 900 });
  // Edit card dialog (a draft) and the risk tier dialog (a queued card)
  await pPage.setViewportSize({ width: 1280, height: 1500 });
  await open(pPage, '/cards/WEB-43');
  await pPage.getByTestId('edit-card').click();
  await snap(pPage, 'dlg-edit-card', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
  await pPage.setViewportSize({ width: 1280, height: 800 });
  await open(pPage, `/cards/${S.ids['card:rq']}`);
  await pPage.getByTestId('set-risk').click();
  await snap(pPage, 'dlg-risk', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
  await detail('card-feed-run', 'NEWS-2', { maxH: 1100 });
  const panel = async (name: string, ref: string, heading: RegExp) => {
    await open(pPage, `/cards/${ref}`);
    const el = pPage
      .locator('section')
      .filter({ has: pPage.getByRole('heading', { name: heading }) })
      .last();
    await snap(pPage, name, { sel: el });
  };
  await panel('panel-details', S.ids['card:bounced0'] as string, /^Details$/);
  await panel('panel-handoffs', S.ids['card:bounced0'] as string, /^Handoffs/);
  await panel('panel-thread', S.ids['card:bounced0'] as string, /^Thread$/);
  await panel('panel-timeline', S.ids['card:bounced0'] as string, /^Timeline$/);
  await panel('panel-risk', S.ids['card:rq'] as string, /^Details$/);
  await panel('panel-timeline-edit', S.ids['card:rq'] as string, /^Timeline$/);
  await panel('panel-live', 'WEB-10', /^Live shift/);
  await panel('panel-finalize', S.ids['card:large'] as string, /^Finalize$/);
  await panel('panel-evidence', 'WEB-1', /^Test evidence/);
  await panel('panel-outbound', S.ids.card12 as string, /^Updates to/);
  await panel('panel-outbound-failed', S.ids.card40 as string, /^Updates to/);
  await panel('panel-published', S.ids.research1 as string, /^Published note/);
  await open(pPage, `/cards/${S.ids['card:tc']}`);
  await pPage.getByRole('button', { name: 'Move' }).click();
  await snap(pPage, 'dlg-move', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
  await pPage.getByRole('button', { name: 'Cancel card' }).click();
  await snap(pPage, 'dlg-cancel', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
  await open(mPage, `/cards/${S.ids['card:maya']}`);
  await snap(mPage, 'card-maya', { maxH: 1100 });
});

cap('the decision desk', async () => {
  await open(pPage, '/desk');
  await snap(pPage, 'desk', { maxH: 1500, cx: { x: 190, width: 900 } });
  const item = (title: string | RegExp) => pPage.getByRole('article', { name: title });
  const shots: Array<[string, string | RegExp]> = [
    ['desk-question', /How long may we keep the personal data/],
    ['desk-outbound', /Approve resolution for Jira SUP-231/],
    ['desk-failed', /Could not post the update/],
    ['desk-digest', /Rate the AI news feed digest/],
    ['desk-taste', /Add a taste rule/],
    ['desk-devops', /DevOps needs approval/],
    ['desk-large-merge', /Approve merge of/],
    ['desk-definition', /Approve role "Release manager"/],
    ['desk-alert', /waiting for a tester/],
  ];
  for (const [name, title] of shots) {
    const el = item(title).first();
    if (await el.count()) await snap(pPage, name, { sel: el });
    else console.log(`missing desk item for ${name}`);
  }
  await pPage.getByRole('button', { name: 'Add to ledger' }).first().click();
  await snap(pPage, 'desk-ledger-form', { maxH: 700, noHeader: true, cx: { x: 190, width: 900 } });
  await pPage.getByRole('button', { name: 'Add to ledger' }).first().click();
  const closed = pPage.getByTestId('desk-closed');
  if (await closed.count()) {
    await closed.getByText(/Answered and closed/).click();
    await snap(pPage, 'desk-closed', { sel: closed });
  }
  // an outbound draft being edited: the diff of the manager's own words
  const ob = item(/Approve resolution for GitHub example\/web#31/).first();
  if (await ob.count()) {
    const box = ob.getByLabel(/Update \(edit it/);
    const text = await box.inputValue();
    await box.fill(`${text} The cut-off is 3 pm on weekdays.`);
    await snap(pPage, 'desk-outbound-edit', { sel: ob });
    await box.fill(text);
  }
  // the unmapped ticket
  const un = item(/Which project does OPS-77 belong to/).first();
  if (await un.count()) await snap(pPage, 'desk-unmapped', { sel: un });
  // the second manager sees the same desk, with the questions of cards she does not own read-only
  await open(mPage, '/desk');
  await snap(mPage, 'desk-maya', { maxH: 1400, cx: { x: 190, width: 900 } });
});

cap('ledger', async () => {
  await open(pPage, '/ledger');
  await snap(pPage, 'ledger', { noHeader: true, maxH: 1100, cx: { x: 130, width: 1020 } });
  await pPage.getByLabel('Search', { exact: true }).fill('session');
  await snap(pPage, 'ledger-search', { noHeader: true, maxH: 600, cx: { x: 130, width: 1020 } });
});

cap('chat (offline) and chat on a phone', async () => {
  const gus = await idOfAgent('Gus');
  void gus;
  await open(pPage, '/desk');
  await pPage.getByRole('button', { name: 'Chat', exact: true }).click();
  const drawer = pPage.getByRole('dialog', { name: 'Chat' });
  const opt = (await drawer.getByLabel('Agent').locator('option').allInnerTexts()).find((t) =>
    t.startsWith('Gus'),
  );
  if (opt) {
    await drawer.getByLabel('Agent').selectOption({ label: opt });
    await drawer.getByRole('button', { name: 'Start chat' }).click();
    await expect(drawer.getByTestId('chat-offline')).toBeVisible();
    await drawer.getByLabel('Message').fill('Are you there?');
    await drawer.getByRole('button', { name: 'Send' }).click();
    await expect(drawer.getByTestId('chat-error')).toBeVisible();
    await snap(pPage, 'chat-offline', { sel: drawer });
  }
  const thread = (await q<any>(`SELECT id FROM threads WHERE kind='chat' ORDER BY created_at LIMIT 1`))[0];
  await open(phone, `/chat/${thread.id}`);
  await snap(phone, 'm-chat', { maxH: 844 });
});

cap('HR board', async () => {
  await pPage.setViewportSize({ width: 1280, height: 1300 });
  await open(pPage, '/agents');
  await snap(pPage, 'hr', { maxH: 1700 });
  await snap(pPage, 'hr-ada', { sel: pPage.getByTestId('agent-Ada') });
  await snap(pPage, 'hr-grace', { sel: pPage.getByTestId('agent-Grace') });
  await snap(pPage, 'hr-sal', { sel: pPage.getByTestId('agent-Sal') });
  const devops = pPage
    .getByTestId('agents')
    .getByRole('listitem')
    .filter({ hasText: 'DevOps engineer' })
    .first();
  await snap(pPage, 'hr-devops', { sel: devops });
  const recs = pPage.getByTestId('recommendations');
  for (const d of await recs.locator('details').all()) await d.locator('summary').click();
  await snap(pPage, 'hr-recs', { sel: recs });
  await snap(pPage, 'hr-role-update', { sel: pPage.getByTestId('role-updates') });
  await pPage.getByTestId('reset-tester').click();
  await snap(pPage, 'dlg-reset-role', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
  // hire form, name generator, the unsandboxed warning
  await pPage.getByRole('button', { name: 'Hire agent' }).first().click();
  const form = pPage.getByRole('form', { name: 'Hire agent' });
  await form.getByLabel('Role', { exact: true }).selectOption({ label: 'Builder' });
  await form.getByLabel('Name theme').selectOption('birds');
  await snap(pPage, 'dlg-hire', { sel: pPage.getByRole('dialog') });
  const ws = await form.getByLabel('Workstation').locator('option').allInnerTexts();
  const mini = ws.find((t) => t.startsWith('Build mini-PC'));
  if (mini) await form.getByLabel('Workstation').selectOption({ label: mini });
  await form.getByLabel('Runtime').selectOption('mock');
  await form.getByLabel('Name', { exact: true }).fill('Tom');
  await form.getByRole('button', { name: 'Hire', exact: true }).click();
  await expect(form.getByText('Confirm that you accept')).toBeVisible();
  await snap(pPage, 'dlg-hire-unsandboxed', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
  await pPage.getByRole('button', { name: 'Fire Grace' }).click();
  await snap(pPage, 'dlg-fire', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
  await pPage.getByRole('button', { name: 'Change model of Ada' }).click();
  await snap(pPage, 'dlg-model', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
  await pPage.getByRole('button', { name: 'Change role of Ada' }).click();
  await snap(pPage, 'dlg-role', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
  await open(pPage, '/agents?hire=tester');
  await snap(pPage, 'dlg-hire-tester', { sel: pPage.getByRole('dialog') });
  // the second manager sees the owner's agents read-only
  await open(mPage, '/agents');
  await snap(mPage, 'hr-maya', { maxH: 1500 });
});

cap('metrics', async () => {
  await open(pPage, '/metrics');
  await snap(pPage, 'metrics', { noHeader: true, maxH: 1400, cx: { x: 130, width: 1020 } });
});

cap('intake', async () => {
  await open(pPage, '/intake');
  await snap(pPage, 'intake-new', { maxH: 600, noHeader: true, cx: { x: 290, width: 700 } });
  await pPage.getByLabel('Ticket or need').fill('SUP-231');
  await snap(pPage, 'intake-typed', { maxH: 330, noHeader: true, cx: { x: 290, width: 700 } });
  await open(pPage, `/intake/${S.ids.intakeJira}`);
  await snap(pPage, 'intake-view', { maxH: 800, noHeader: true, cx: { x: 130, width: 1020 } });
  await open(pPage, `/intake/${S.ids.intakeUnmapped}`);
  await snap(pPage, 'intake-unmapped', { maxH: 800, noHeader: true, cx: { x: 130, width: 1020 } });
  await open(pPage, `/intake/${S.ids.intakeGh12}`);
  await snap(pPage, 'intake-gh', { maxH: 800, noHeader: true, cx: { x: 130, width: 1020 } });
});

cap('feeds, schedules, research', async () => {
  await open(pPage, '/p/NEWS/feed');
  await snap(pPage, 'feed', { maxH: 1700, noHeader: true, cx: { x: 190, width: 900 } });
  await open(pPage, '/schedules');
  await snap(pPage, 'schedules', { maxH: 1500, noHeader: true, cx: { x: 190, width: 900 } });
  await open(pPage, `/p/SHOOT/board`);
});

cap('projects, sharing, vaults', async () => {
  await open(pPage, '/projects');
  await snap(pPage, 'projects', { maxH: 520, noHeader: true, cx: { x: 190, width: 900 } });
  await pPage.getByRole('button', { name: 'New project' }).click();
  await snap(pPage, 'dlg-new-project', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
  await open(pPage, `/projects/${S.ids['project:WEB']}/settings`);
  await snap(pPage, 'project-settings', { maxH: 1800, noHeader: true, cx: { x: 250, width: 780 } });
  const maya = pPage.getByTestId('members').getByRole('listitem').filter({ hasText: 'Maya' });
  await maya.getByRole('button').first().click();
  await expect(pPage.getByTestId('removal-preview')).toBeVisible();
  await snap(pPage, 'dlg-remove-member', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
  await open(mPage, '/projects');
  await snap(mPage, 'projects-maya', { maxH: 520, noHeader: true, cx: { x: 190, width: 900 } });
  await open(mPage, `/projects/${S.ids['project:WEB']}/settings`);
  await snap(mPage, 'project-settings-maya', { maxH: 1500, noHeader: true, cx: { x: 250, width: 780 } });
  await open(pPage, '/settings/vaults');
  await snap(pPage, 'vaults', { maxH: 1500, noHeader: true, cx: { x: 190, width: 900 } });
});

cap('workstations and the DevOps engineer', async () => {
  await open(pPage, '/workstations');
  for (const card of await pPage
    .locator('[data-testid^="workstation-"]:has([data-testid="workstation-toggle"])')
    .all())
    await expandWorkstation(card);
  await snap(pPage, 'workstations', { maxH: 1900, noHeader: true, cx: { x: 190, width: 900 } });
  await snap(pPage, 'ws-sandbox', { sel: pPage.getByTestId('workstation-Build mini-PC') });
  const dv = pPage.getByTestId("workstation-Pieter's desktop (WSL2)").locator('section').first();
  await snap(pPage, 'ws-devops', { sel: dv });
  await pPage.getByRole('button', { name: 'Pair workstation' }).click();
  await pPage.getByRole('button', { name: 'Generate pairing code' }).click();
  await expect(pPage.getByTestId('pairing-code')).toBeVisible();
  await snap(pPage, 'dlg-pair', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
});

cap('organization', async () => {
  await open(pPage, '/org');
  await snap(pPage, 'org-roles', { maxH: 1800 });
  await pPage.getByRole('button', { name: 'Extend reviewer' }).click();
  await snap(pPage, 'dlg-extend', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
  await open(pPage, '/org?tab=workflows');
  await pPage.getByRole('button', { name: 'View support v1' }).click();
  await snap(pPage, 'org-workflows', { maxH: 1800 });
  await pPage.getByRole('button', { name: 'New custom workflow' }).click();
  const editor = pPage.getByTestId('workflow-editor');
  await editor.getByLabel('Key', { exact: true }).fill('bad-flow');
  await editor.getByLabel('Name', { exact: true }).fill('Bad flow');
  await editor.getByRole('button', { name: 'Add stage' }).click();
  await snap(pPage, 'org-workflow-editor', { maxH: 1800 });
  await open(pPage, '/org?tab=departments');
  await snap(pPage, 'org-departments', { maxH: 800 });
  await open(mPage, `/org?project=${S.ids['project:WEB']}`);
  await snap(mPage, 'org-maya', { maxH: 900 });
  await open(pPage, '/org?tab=roles');
  await pPage.getByRole('button', { name: 'New custom role' }).click();
  await snap(pPage, 'org-role-editor', { maxH: 1800 });
});

cap('on a phone', async () => {
  const shots: Array<[string, string]> = [
    ['m-board', '/p/WEB/board'],
    ['m-desk', '/desk'],
    ['m-card', `/cards/${S.ids['card:guest']}`],
    ['m-hr', '/agents'],
    ['m-new-card', '/cards/new?project=WEB'],
    ['m-workstations', '/workstations'],
    ['m-ledger', '/ledger'],
    ['m-metrics', '/metrics'],
  ];
  for (const [name, path] of shots) {
    await open(phone, path);
    await snap(phone, name, { maxH: 1000 });
  }
});
