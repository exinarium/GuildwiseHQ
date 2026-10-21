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
import {
  ADMIN_DEMO,
  ARI,
  loadState,
  MAYA,
  NOOR,
  PIETER,
  SUPER_DEMO,
  SUPPORT_INBOX,
  saveState,
  snap,
  snapColumn,
} from '../support/guide.ts';
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
      completionAction: o.action ?? 'pr',
      docsNeeded: o.docs ?? false,
      ...(o.deps ? { dependencies: o.deps } : {}),
      fields: {
        context: c.context,
        requirements: c.requirements,
        acceptanceCriteria: c.criteria,
        mockUsage: { inputTokens: 300_000, outputTokens: 20_000 },
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

step('users and the admin', async () => {
  // The demo organization is Pieter's. The e2e admin account (and its empty organization) is renamed so nothing says e2e.
  await q(`UPDATE users SET email=$1, display_name=$2 WHERE email=$3`, [
    ADMIN_DEMO.email,
    ADMIN_DEMO.name,
    ADMIN.email,
  ]);
  await q(`UPDATE organizations SET name='Admin Demo''s organization' WHERE name ILIKE '%e2e%'`);
  const admin = await apiAs(ADMIN_DEMO.email, ADMIN.password);
  await inviteAndAccept(admin, PIETER);
  await inviteAndAccept(admin, MAYA);
});

step(
  'people: Pieter invites an Admin and a Member, a third invitation waits, a fourth is revoked',
  async () => {
    const p = await pieter();
    const accept = async (email: string, person: { name: string; password: string }) => {
      const mail = await waitForMail(email);
      const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(mail.text)?.[1] ?? '';
      expect(token).toBeTruthy();
      const ctx = await (await import('@playwright/test')).request.newContext({
        baseURL: BASE_URL,
        extraHTTPHeaders: { Origin: BASE_URL },
      });
      const r = await ctx.post(`/api/invitations/${token}/accept`, {
        data: { displayName: person.name, password: person.password },
      });
      expect(r.ok(), await r.text()).toBeTruthy();
      await ctx.dispose();
    };
    for (const [who, role] of [
      [ARI, 'admin'],
      [NOOR, 'member'],
    ] as const) {
      const r = await p.post('/api/org/invitations', { data: { email: who.email, role } });
      expect(r.ok(), await r.text()).toBeTruthy();
      await accept(who.email, who);
    }
    for (const email of ['sam@demo.local', 'lee@demo.local']) {
      const r = await p.post('/api/org/invitations', { data: { email, role: 'member' } });
      expect(r.ok(), await r.text()).toBeTruthy();
    }
    const mail = await waitForMail('sam@demo.local');
    S.ids.samToken = /\/invite\/([A-Za-z0-9_-]+)/.exec(mail.text)?.[1] ?? '';
    expect(S.ids.samToken).toBeTruthy();
    const invs = (await (await p.get('/api/org/invitations')).json()) as any;
    const list: any[] = invs.invitations ?? invs;
    const lee = list.find((i) => i.email === 'lee@demo.local');
    expect((await p.post(`/api/org/invitations/${lee.id}/revoke`, { data: {} })).ok()).toBeTruthy();
  },
);

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
  makeVault('org', {
    'README.md': '# org vault\n\nMarkdown notes of Pieter Demo.\n',
    'projects/shoot/PROJECT.md': '# Shooting research\n\nResearch notes about shooting and reloading.\n',
  });
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

  for (const [key, name, workflowKey, extra] of [
    ['WEB', 'Web shop', 'code', {}],
    ['SHOOT', 'Shooting research', 'research', { subCategories: ['hunting', 'reloading'] }],
  ] as const) {
    const r = await p.post('/api/projects', { data: { key, name, workflowKey, ...extra } });
    expect(r.status(), await r.text()).toBe(201);
    S.ids[`project:${key}`] = (await r.json()).project.id;
  }
  // Manual QA is on by default: the seeded history goes straight to Done; the QA scene is made at the end
  const noQa = await p.put(`/api/projects/${S.ids['project:WEB']}/manual-qa`, { data: { enabled: false } });
  expect(noQa.status(), await noQa.text()).toBe(200);
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
    ['org', 'org', undefined],
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
    (r) => r.length >= 2 && r.every((x) => !!x.local_path),
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
    ['last_login', 'pr'],
    ['typo', 'pr'],
    ['cache', 'pr'],
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

step('a phase of two cards that is finished and waits for approval', async () => {
  const p = await pieter();
  const web = S.ids['project:WEB'] as string;
  const target = await p.post(`/api/projects/${web}/deploy-targets`, {
    data: {
      name: 'local',
      kind: 'local_docker',
      appUrl: 'http://localhost:3000',
      notes: 'docker compose up -d in the web repository',
    },
  });
  expect(target.status(), await target.text()).toBeLessThan(300);
  const targets = (await (await p.get(`/api/projects/${web}/deploy-targets`)).json()) as any;
  const targetId = (targets.targets as any[]).find((t) => t.name === 'local').id as string;
  const defaults = await p.put(`/api/projects/${web}/followup-defaults`, {
    data: {
      followups: [
        { kind: 'deploy', targetId },
        { kind: 'regression', platform: 'web', targetId },
      ],
    },
  });
  expect(defaults.ok(), await defaults.text()).toBeTruthy();
  const ph = await p.post(`/api/projects/${web}/phases`, {
    data: {
      name: 'Phase 1: checkout polish',
      description: 'Small improvements to the checkout that ship together.',
      followups: [
        { kind: 'deploy', targetId },
        { kind: 'regression', platform: 'web', targetId },
      ],
    },
  });
  expect(ph.status(), await ph.text()).toBe(201);
  const phase = (await ph.json()) as { id: string; ref: string };
  S.ids['phase:ref'] = phase.ref;
  const phaseRefs: string[] = [];
  for (const c of [
    spec(
      'Show the order total in words on the receipt',
      'Some customers ask for the total written out for their accounting.',
      'Print the total in words under the number on the receipt.',
      ['The total is printed in words'],
    ),
    spec(
      'Remember the last used payment method',
      'Returning customers pick the same payment method every time.',
      'Preselect the payment method of the last order.',
      ['The last used method is preselected'],
    ),
  ]) {
    const card = await makeCard(p, 'WEB', c, { action: 'merge' });
    const put = await p.put(`/api/cards/${card.id}/phase`, { data: { phaseId: phase.id } });
    expect(put.status(), await put.text()).toBe(200);
    phaseRefs.push(card.ref);
  }
  for (const r of phaseRefs) await done(r);
  await waitFor(
    'the phase waits for approval',
    () => q<any>(`SELECT status FROM phases WHERE id=$1`, [phase.id]),
    (r) => r[0]?.status === 'awaiting_approval',
    240_000,
  );
});

step('a card whose shifts keep failing: the loop breaker backs it off', async () => {
  const p = await pieter();
  const c = await makeCard(
    p,
    'WEB',
    spec(
      'Sync the product feed with the warehouse system',
      'Stock levels in the shop drift from the warehouse system during the day.',
      'Pull the warehouse stock feed every 15 minutes and update the product stock levels.',
      ['Stock levels match the warehouse feed', 'A failed pull is retried on the next run'],
    ),
    { mock: { build: Array.from({ length: 24 }, () => 'no_report') } },
  );
  S.ids['card:backoff'] = c.ref;
  await waitFor(
    'the loop breaker alert',
    () => q<any>(`SELECT id FROM desk_items WHERE subkind='loop_backoff' AND card_id=$1`, [c.id]),
    (r) => r.length > 0,
    240_000,
  );
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

step('a repository whose working branch is not confirmed: hygiene asks on the desk', async (browser) => {
  const p = await pieter();
  const origin = join(paths.vaults, 'notes-origin.git');
  const clone = join(paths.repoRoot, 'notes-app');
  rmSync(origin, { recursive: true, force: true });
  rmSync(clone, { recursive: true, force: true });
  mkdirSync(paths.vaults, { recursive: true });
  // no main or master: simple mode confirms the working branch of a repository that has one of them without asking
  git(paths.vaults, 'init', '--bare', '-b', 'trunk', origin);
  git(paths.repoRoot, 'clone', origin, 'notes-app');
  git(clone, 'checkout', '-b', 'trunk');
  writeFileSync(join(clone, 'README.md'), '# Team notes\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-m', 'Initial commit');
  git(clone, 'push', '-u', 'origin', 'trunk');
  git(clone, 'branch', 'develop');
  git(clone, 'push', 'origin', 'develop');
  const proj = await p.post('/api/projects', {
    data: { key: 'NOTES', name: 'Team notes', workflowKey: 'code' },
  });
  expect(proj.status(), await proj.text()).toBe(201);
  const notes = (await proj.json()).project.id as string;
  S.ids['project:NOTES'] = notes;
  const add = await p.post(`/api/projects/${notes}/repos`, {
    data: { name: 'notes-app', remoteUrl: origin },
  });
  expect(add.status(), await add.text()).toBe(201);
  await waitFor(
    'the workstation holds notes-app',
    async () => (await (await p.get('/api/workstations')).json()).workstations[0].repos.length,
    (n) => n >= 2,
    30_000,
  );
  writeFileSync(join(clone, 'todo.md'), 'meeting notes that were never saved\n');
  writeFileSync(join(clone, 'README.md'), '# Team notes\n\nedited by hand\n');
  const ctx = await browser.newContext({
    storageState: await p.storageState(),
    viewport: { width: 1280, height: 1000 },
  });
  const page = await ctx.newPage();
  await page.goto('/workstations');
  await expandWorkstation(page.getByTestId("workstation-Pieter's desktop (WSL2)"));
  await page.getByRole('button', { name: 'Run hygiene now' }).click();
  await waitFor(
    'the working-branch question',
    () =>
      q<any>(`SELECT id FROM desk_items WHERE title LIKE 'Which branch is the working branch of notes-app%'`),
    (r) => r.length > 0,
    90_000,
  );
  await ctx.close();
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
  // Noor is a Member of the organization and works on WEB only
  const addNoor = await p.post(`/api/projects/${web}/members`, { data: { email: NOOR.email } });
  expect(addNoor.status(), await addNoor.text()).toBeLessThan(300);
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
      completionAction: 'pr',
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

  // the interest: an org-level feed with its own run and delivery schedules, and two runs
  const created = await p.post('/api/interests', {
    data: {
      name: 'AI news feed',
      description: 'Practical agent engineering and coding assistants. No hype, no press releases.',
      subCategory: 'ai/agents',
      preferredSites: ['https://news.example.com'],
      scan: { cron: '0 7 * * *', timezone: 'Africa/Johannesburg', maxItems: 10 },
      delivery: { mode: 'immediate' },
      tasteRules: ['Prefer primary sources over summaries'],
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const interestId = (await created.json()).id as string;
  S.ids['interest:NEWS'] = interestId;
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
  const mk = async (items: unknown[], rule?: string) => {
    const r = await p.post(`/api/interests/${interestId}/run`, {
      data: { mock: { mockFeed: { items, ...(rule ? { proposeRule: rule } : {}) } } },
    });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()).ref as string;
  };
  const f1 = await mk(run1);
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
  const f2 = await mk(run2, 'Prefer posts that include benchmark or study data');
  S.ids['ref:feed2'] = f2;
  await done(f2);
  // a second interest that only runs when asked, with a delivery time
  const weekend = await p.post('/api/interests', {
    data: {
      name: 'Weekend long reads',
      description: 'Long essays worth a slow Saturday.',
      scan: { cron: '0 8 * * 6', timezone: 'Africa/Johannesburg', maxItems: 5 },
      delivery: { mode: 'scheduled', cron: '0 7 * * 6', timezone: 'Africa/Johannesburg' },
      status: 'paused',
    },
  });
  expect(weekend.status(), await weekend.text()).toBe(201);
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
  const orgId = (
    await q<any>(
      `SELECT m.org_id FROM org_members m JOIN users u ON u.id=m.user_id WHERE u.email=$1 AND m.status='active'`,
      [PIETER.email],
    )
  )[0].org_id;
  await q(
    `INSERT INTO role_extensions (org_id, role_key, base_version, extensions, updated_at) VALUES ($1,'tester',1,$2,now())
     ON CONFLICT (org_id, role_key) DO UPDATE SET base_version=1, extensions=$2`,
    [
      orgId,
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
    const chat = async (agent: string, message: string, shotName?: string) => {
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
      await drawer.getByLabel('Message', { exact: true }).fill(message);
      await drawer.getByRole('button', { name: 'Send' }).click();
      await expect(drawer.getByTestId('chat-message').last()).toContainText('heard', { timeout: 60_000 });
      await expect(drawer.getByTestId('chat-streaming')).toHaveCount(0);
      if (shotName) await snap(page, shotName, { sel: drawer });
    };
    await chat('Olga', 'Can you check whether the SUP-231 ticket has a screenshot attached?', 'chat-ba');
    await chat('Olga', 'Thanks. Please draft a card for the password reset form on phones.');
    await chat('Linus', 'Which review comments came up most often this week?');
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
  await inStage(tb.ref, 'test', 'queued');

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
  await waitCard(cc.ref, 'back in build after the conflict', (c) => c.rework_round >= 1, 300_000);
  await waitCard(tb.ref, 'waiting on its bug', (c) => c.status === 'waiting', 300_000);
  // the second long test is made only now: if the runner turns the conflicting card's shift away because it is still
  // tearing down the cancelled one, the card goes to the back of the queue and a hanging test would starve it
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
  // the reviewer is busy with the long review: the manager sends the card to test herself
  await inStage(tc.ref, 'review', 'queued');
  const tcMove = await p.post(`/api/cards/${tc.id}/move`, {
    data: { toStage: 'test', reason: 'Reviewed together in a pairing session' },
  });
  expect(tcMove.ok(), await tcMove.text()).toBeTruthy();
  await inStage(tc.ref, 'test', 'claimed');
  const bug = (
    await q<any>(
      `SELECT ref FROM cards WHERE parent_card_id=(SELECT id FROM cards WHERE ref=$1) AND card_type='bug'`,
      [tb.ref],
    )
  )[0].ref as string;
  await q(`UPDATE cards SET title='Bug: the delivery estimate says Sunday' WHERE ref=$1`, [bug]);
  S.ids['card:bug'] = bug;
  // the builder fixes the bug and waits for the reviewer; the conflicting card waits while DevOps tries to resolve the
  // conflict on a separate branch (it needs the manager's approval on the desk)
  await inStage(bug, 'review', 'queued');
  await waitFor(
    'DevOps request for the conflict',
    () =>
      q<any>(`SELECT status FROM devops_requests WHERE card_id=(SELECT id FROM cards WHERE ref=$1)`, [
        cc.ref,
      ]),
    (r) => r.length > 0,
    120_000,
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
  // the manager sends the bug fix back to build, and a reviewed card to test
  const idOf = async (ref: string) => (await card(ref)).id as string;
  for (const ref of [bug]) {
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

step('schedules and integrations', async () => {
  const p = await pieter();
  const web = S.ids['project:WEB'] as string;
  for (const old of ((await (await p.get('/api/schedules')).json()) as any).schedules as any[]) {
    await p.delete(`/api/schedules/${old.id}`);
  }
  const post = async (data: Record<string, unknown>) => {
    const r = await p.post('/api/schedules', { data });
    expect(r.status(), await r.text()).toBe(201);
  };
  await post({
    name: 'Weekly dependency check',
    trigger: { kind: 'cron', cron: '0 7 * * 1', timezone: 'Africa/Johannesburg' },
    action: {
      kind: 'create_card',
      projectId: web,
      template: {
        title: 'Weekly dependency check {date}',
        cardType: 'feature',
        fields: {
          context: 'Outdated packages are a security risk.',
          requirements: 'List the packages with a newer version and upgrade the safe ones.',
          acceptanceCriteria: ['A list of upgrades is in the handoff', 'The tests still pass'],
          affectedAreas: 'package.json',
          constraints: 'Patch and minor upgrades only.',
          testPlan: 'Run the unit tests.',
        },
      },
    },
  });
  await post({
    name: 'Tell the team when a phase is done',
    trigger: { kind: 'event', event: 'phase_completed', projectId: web },
    action: {
      kind: 'integration',
      integration: 'webhook',
      operation: 'post',
      url: 'https://hooks.example.com/services/T000/B000/demo',
      format: 'slack',
      message: 'A phase of the web shop is done: {ref}',
      digest: null,
    },
  });
  await post({
    name: 'Floor report by e-mail',
    trigger: { kind: 'cron', cron: '0 17 * * 5', timezone: 'Africa/Johannesburg' },
    action: {
      kind: 'integration',
      integration: 'email',
      operation: 'digest',
      to: [PIETER.email],
      subject: 'Floor report of the week',
      digest: 'floor_report',
    },
  });
  await post({
    name: 'New issues labelled aom',
    trigger: {
      kind: 'issue_labelled',
      provider: 'github',
      workstationId: S.ids.wsA,
      query: 'example/web',
      label: 'aom',
      cron: '*/15 * * * *',
      timezone: 'Africa/Johannesburg',
    },
    action: {
      kind: 'create_card',
      projectId: web,
      template: {
        title: '{issue.title}',
        cardType: 'feature',
        fields: { context: 'Reported on GitHub: {issue.title}' },
      },
    },
  });
  await post({
    name: 'Friday review',
    trigger: { kind: 'manual' },
    action: {
      kind: 'ba_task',
      projectId: null,
      prompt: 'Summarize what is open on {date} and what needs my attention.',
      deliver: 'desk_notice',
    },
  });
});

step('the budget of the web shop', async () => {
  const p = await pieter();
  const web = S.ids['project:WEB'] as string;
  const spend = Number(
    (
      await q<any>(`SELECT COALESCE(sum(cost_usd_micros),0) AS s FROM shift_costs WHERE project_id=$1`, [web])
    )[0].s,
  );
  S.ids.spendWeb = String(spend / 1e6);
  const monthly = Math.max(5, Math.ceil(spend / 1e6 / 0.62));
  S.ids.budgetWeb = String(monthly);
  const r = await p.put(`/api/projects/${web}/budget`, { data: { monthly } });
  expect(r.ok(), await r.text()).toBeTruthy();
});

step('platform: the administrator, other organizations, support requests', async (browser) => {
  const { freshTotp } = await import('../support/totp.ts');
  const pw = await import('@playwright/test');
  // a second customer organization (its owner is never used again) that the platform suspends
  const hana = { email: 'hana@demo.local', name: 'Hana Harbor', password: 'hana-demo-pass-2026' };
  if (!(await q<any>(`SELECT 1 FROM users WHERE email=$1`, [hana.email])).length)
    await inviteAndAccept(await pieter(), hana);
  await q(
    `UPDATE organizations SET name='Harbor Cafe' WHERE owner_user_id=(SELECT id FROM users WHERE email=$1)`,
    [hana.email],
  );

  const staffCtx = await browser.newContext();
  const staff = await staffCtx.newPage();
  await staff.goto('/login');
  await staff.getByLabel('Email').fill(SUPER_DEMO.email);
  await staff.getByLabel('Password').fill(SUPER_DEMO.password);
  await staff.getByRole('button', { name: 'Sign in' }).click();
  await staff.getByLabel('Your password').fill(SUPER_DEMO.password);
  await staff.getByRole('button', { name: 'Continue' }).click();
  const secret = (await staff.locator('code').first().innerText()).trim();
  S.ids.superSecret = secret;
  await staff.getByTestId('totp-code').fill(await freshTotp(secret));
  await staff.getByRole('button', { name: 'Turn on two-factor login' }).click();
  await staff.getByLabel('I saved my recovery codes somewhere safe').check();
  await staff.getByRole('button', { name: 'Done' }).click();
  await expect(staff).toHaveURL(/\/platform/);
  const sapi = staffCtx.request;
  const hdr = { Origin: BASE_URL };
  expect(
    (
      await sapi.patch('/api/platform/settings', { data: { supportEmail: SUPPORT_INBOX }, headers: hdr })
    ).ok(),
  ).toBeTruthy();
  const inv = await sapi.post('/api/platform/invitations', {
    data: {
      email: 'northwind@demo.local',
      proposedOrgName: 'Northwind Traders',
      plan: 'founding',
      status: 'active',
    },
    headers: hdr,
  });
  expect(inv.ok(), await inv.text()).toBeTruthy();
  const orgs = (await (await sapi.get('/api/platform/orgs')).json()) as any;
  const harbor = (orgs.orgs ?? orgs.organizations ?? orgs).find((o: any) => o.name === 'Harbor Cafe');
  const sus = await sapi.post(`/api/platform/orgs/${harbor.id}/suspend`, {
    data: { reason: 'Invoice 2026-091 is unpaid', note: 'Reminder sent on 1 October' },
    headers: hdr,
  });
  expect(sus.ok(), await sus.text()).toBeTruthy();

  // support requests: Maya (signed in) and a visitor; the platform answers Maya's
  const m = await maya();
  const t1 = await m.post('/api/support/tickets', {
    data: {
      kind: 'question',
      subject: 'How do I move a card back to Build?',
      message: 'A reviewer sent my card back twice. Can I move it to Build myself, or only the owner?',
      context: { page: '/cards/WEB-12', appVersion: '1.0.0', browser: 'Chrome 140', viewport: '1280x800' },
    },
  });
  expect(t1.status(), await t1.text()).toBe(201);
  const ref1 = ((await t1.json()) as any).ref ?? ((await t1.json()) as any).ticket?.ref;
  const anon = await pw.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Origin: BASE_URL } });
  const t2 = await anon.post('/api/support/tickets', {
    data: {
      kind: 'feature',
      subject: 'Dark mode for the landing page',
      message: 'The sign-in page is bright at night. Could it follow the system theme?',
      name: 'Vera Visitor',
      email: 'vera@example.com',
    },
  });
  expect(t2.status(), await t2.text()).toBe(201);
  await anon.dispose();
  const list = (await (await sapi.get('/api/platform/support/tickets')).json()) as any;
  const mine = (list.tickets as any[]).find((t) => t.subject.startsWith('How do I move'));
  expect(mine, JSON.stringify(ref1)).toBeTruthy();
  S.ids.ticketMaya = mine.id;
  const rep = await sapi.post(`/api/platform/support/tickets/${mine.id}/replies`, {
    data: {
      body: 'Hi Maya. Only the card owner, an Owner or an Admin can move a card. Ask Pieter to move it, or open the card and use Release if the card is yours and unclaimed.',
    },
    headers: hdr,
  });
  expect(rep.ok(), await rep.text()).toBeTruthy();
  await staffCtx.close();
});

step(
  'the daily floor report of the next morning (the test clock moves; keep this step last)',
  async (browser) => {
    const p = await pieter();
    const ZONE = 'Africa/Johannesburg';
    const ctx = await browser.newContext({ storageState: await p.storageState(), timezoneId: ZONE });
    const page = await ctx.newPage();
    await page.goto('/settings');
    await waitFor(
      'the browser time zone is stored',
      async () => q<any>(`SELECT timezone FROM users WHERE email=$1`, [PIETER.email]),
      (r) => r[0]?.timezone === ZONE,
      30_000,
    );
    await ctx.close();
    const orgId = (
      await q<any>(
        `SELECT m.org_id FROM org_members m JOIN users u ON u.id=m.user_id WHERE u.email=$1 AND m.status='active'`,
        [PIETER.email],
      )
    )[0].org_id as string;
    const clock = (advanceMs: number) =>
      fetch(`${BASE_URL}/api/test/clock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE_URL },
        body: JSON.stringify({ advanceMs }),
      });
    const now = new Date(((await (await clock(0)).json()) as { now: string }).now);
    const local = new Date(now.getTime() + 2 * 3_600_000);
    const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 7, 0, 0);
    expect((await clock(target - now.getTime())).ok).toBe(true);
    await waitFor(
      'the floor report',
      () => q<any>(`SELECT id FROM desk_items WHERE subkind='floor_report' AND org_id=$1`, [orgId]),
      (r) => r.length > 0,
      180_000,
    );
  },
);

step('batch intake: tickets pasted in a list, one already has a card, one waits for an answer', async () => {
  const p = await pieter();
  // Known product bug (found while making the guide): migration 1867 makes intake_batches.org_id reference users(id)
  // instead of organizations(id), so a batch of an organization whose id is not a user id fails with a 500. The guide
  // database drops the constraint so the screens can be shot; the repository's migration is not touched here.
  await q(`ALTER TABLE intake_batches DROP CONSTRAINT IF EXISTS intake_batches_org_id_fkey`);
  const srcDir = join(A, 'mock-sources');
  const tickets: Array<[string, string, string]> = [
    [
      'SUP-240',
      'Show the delivery estimate on the order confirmation page',
      'Customers ask when the parcel arrives.',
    ],
    [
      'SUP-241',
      'Add a "reorder" button to past orders',
      'Returning customers want to repeat an order in one click.',
    ],
    [
      'SUP-242',
      'Let customers change the delivery address until the order ships',
      'Support gets this request every week.',
    ],
  ];
  for (const [key, title, body] of tickets)
    writeFileSync(join(srcDir, `${key}.json`), JSON.stringify({ title, body, project: 'WEB' }));
  const web = S.ids['project:WEB'] as string;
  const start = async (data: Record<string, unknown>) => {
    const r = await p.post('/api/intake/batches', { data });
    expect(r.status(), await r.text()).toBeLessThan(300);
    const b = (await r.json()) as any;
    return (b.id ?? b.batch?.id) as string;
  };
  const old = await q<any>(`SELECT id FROM intake_batches ORDER BY created_at LIMIT 1`);
  const first =
    (old[0]?.id as string | undefined) ??
    (await start({ tickets: ['SUP-240', 'SUP-241', 'SUP-231', 'SUP-242'], projectId: web }));
  S.ids.batch = first;
  await waitFor(
    'the batch is processed',
    async () => ((await (await p.get(`/api/intake/batches/${first}`)).json()) as any).batch.items as any[],
    (items) => items.length === 4 && items.every((i) => ['done', 'skipped', 'failed'].includes(i.status)),
    240_000,
  );
  // the mock BA names its cards "Ticket <key>": give them the ticket's title
  for (const [key, title, body] of tickets)
    await q(
      `UPDATE cards SET title=$2, fields = jsonb_set(jsonb_set(fields,'{context}',to_jsonb($3::text)),'{requirements}',to_jsonb($2::text)) WHERE title=$1`,
      [`Ticket ${key}`, title, body],
    );
  // a second batch where the BA has a question (the mock BA asks when the note says [ask])
  writeFileSync(
    join(srcDir, 'SUP-250.json'),
    JSON.stringify({ title: 'Export invoices as PDF', body: 'Finance wants PDF invoices.' }),
  );
  S.ids.batchAsk = await start({ tickets: ['SUP-250'], note: '[ask] check which shop this is for' });
  await waitFor(
    'the batch question',
    async () =>
      ((await (await p.get(`/api/intake/batches/${S.ids.batchAsk}`)).json()) as any).batch.items as any[],
    (items) => items.some((i) => i.status === 'waiting'),
    240_000,
  );
});

step('a run of the Web shop on its working branch', async () => {
  const p = await pieter();
  const r = await p.post('/api/runs', {
    data: { projectId: S.ids['project:WEB'], workstationId: S.ids.wsA },
  });
  expect(r.status(), await r.text()).toBeLessThan(300);
  const b = (await r.json()) as any;
  S.ids.runEnv = (b.environment?.id ?? b.id) as string;
});

step('manual QA: a finalized card waits for the person who started it', async () => {
  const p = await pieter();
  const on = await p.put(`/api/projects/${S.ids['project:WEB']}/manual-qa`, { data: { enabled: true } });
  expect(on.status(), await on.text()).toBe(200);
  const c = await makeCard(
    p,
    'WEB',
    spec(
      'Show the order status as a progress bar',
      'Customers do not see at a glance whether their order is packed or shipped.',
      'Show a four-step progress bar (received, packed, shipped, delivered) on the order page.',
      ['The current step is highlighted', 'The bar fits a phone screen'],
    ),
    { action: 'pr' },
  );
  S.ids['card:qa'] = c.ref;
  await waitCard(c.ref, 'waiting for QA', (x) => x.stage === 'manual_qa' && x.status === 'waiting', 300_000);
});

step('polish: realistic test steps on the QA card', async () => {
  const steps = [
    '## Happy path',
    '- [ ] Open an order that has shipped: the bar shows "Shipped" highlighted',
    '- [ ] Open an order that was only received: only the first step is highlighted',
    '## Edge cases',
    '- [ ] A cancelled order shows "Cancelled" instead of the bar',
    '## UI and data checks',
    '- [ ] On a phone (360 px wide) the four steps still fit on one line',
  ].join('\n');
  await q(`UPDATE cards SET qa = jsonb_set(qa, '{steps}', to_jsonb($2::text)) WHERE ref=$1`, [
    S.ids['card:qa'],
    steps,
  ]);
  // the mock BA asks because the note holds [ask]; the reader should see a plain note
  await q(`UPDATE intake_batches SET note = btrim(replace(note, '[ask]', '')) WHERE note LIKE '%[ask]%'`);
  // Manual QA was switched on while cards were still in flight: the manager has tested all but three of them
  const p = await pieter();
  const keep = [S.ids['card:qa'], 'WEB-49', 'WEB-41'];
  for (const c of await q<any>(`SELECT id, ref FROM cards WHERE stage='manual_qa' AND status='waiting'`)) {
    if (keep.includes(c.ref)) continue;
    const r = await p.post(`/api/cards/${c.id}/qa/pass`, { data: {} });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  // two of the first cards were finished days ago: they have left the board and are in the Archive
  await q(`UPDATE cards SET finished_at = finished_at - interval '3 days' WHERE ref = ANY($1::text[])`, [
    [S.ids['card:typo'], S.ids['card:cache']],
  ]);
});

test('seed: finished', async () => {
  expect(Object.keys(S.done).length).toBeGreaterThan(5);
});

// ---------------------------------------------------------------------------------------------------------------
// capture: every screen of the guide. Nothing here changes the demo world, except where a comment says so.

const ctxs: Record<string, BrowserContext> = {};
let pPage: Page; // Pieter, the Owner
let mPage: Page; // Maya, a Guest of Pieter's organization
let nPage: Page; // Noor, a Member
let phone: Page;
async function pageFor(
  browser: Browser,
  key: string,
  user: { email: string; password: string },
  viewport = { width: 1280, height: 800 },
): Promise<Page> {
  if (!ctxs[key]) {
    const storageState = await (await api(user)).storageState();
    ctxs[key] = await browser.newContext({ viewport, storageState });
  }
  return ctxs[key]!.newPage();
}

function cap(name: string, fn: () => Promise<void>): void {
  test(`capture: ${name}`, async ({ browser }) => {
    test.setTimeout(240_000);
    pPage = await pageFor(browser, 'p', PIETER);
    mPage = await pageFor(browser, 'm', MAYA);
    nPage = await pageFor(browser, 'n', NOOR);
    phone = await pageFor(browser, 'ph', PIETER, { width: 390, height: 844 });
    try {
      await fn();
    } finally {
      for (const pg of [pPage, mPage, nPage, phone]) await pg.close();
    }
  });
}

const open = async (page: Page, path: string) => {
  await page.goto(path);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  // a card, a desk or a board that is still loading shows skeletons for a moment
  await expect(page.locator('[aria-busy="true"]'))
    .toHaveCount(0, { timeout: 15_000 })
    .catch(() => undefined);
};
/** The section (panel) of a page that has this heading. */
const section = (page: Page, heading: RegExp | string) =>
  page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: heading }) })
    .last();
const NARROW = { x: 0, width: 760 };

cap('sign-in, invitations, two-factor code', async () => {
  const ctx = await pPage
    .context()
    .browser()!
    .newContext({ viewport: { width: 1280, height: 720 } });
  const a = await ctx.newPage();
  await open(a, '/login');
  await snap(a, 'login', { maxH: 720 });
  await a.getByLabel('Email').fill('pieter@demo.local');
  await a.getByLabel('Password').fill('not-the-password');
  await a.getByRole('button', { name: 'Sign in' }).click();
  await expect(a.getByRole('alert').first()).toBeVisible();
  await snap(a, 'login-error', { maxH: 720 });
  await open(a, `/invite/${S.ids.samToken}`);
  await snap(a, 'invite-accept', { maxH: 720 });
  await open(a, '/invite/not-a-real-token');
  await snap(a, 'invite-invalid', { maxH: 720 });
  // the platform administrator has two-factor login: the code step after the password
  await open(a, '/login');
  await a.getByLabel('Email').fill(SUPER_DEMO.email);
  await a.getByLabel('Password').fill(SUPER_DEMO.password);
  await a.getByRole('button', { name: 'Sign in' }).click();
  await expect(a.getByTestId('login-code')).toBeVisible();
  await snap(a, 'login-2fa', { maxH: 720 });
  // the landing page that visitors see
  await open(a, '/');
  await snap(a, 'landing', { maxH: 900 });
  await ctx.close();
});

cap('the shell: board, palette, help, tour', async () => {
  await open(pPage, '/p/WEB/board');
  await pPage.setViewportSize({ width: 1700, height: 900 });
  await snap(pPage, 'board-hero', { maxH: 900 });
  await pPage.setViewportSize({ width: 1280, height: 800 });
  await open(pPage, '/p/WEB/board');
  await snap(pPage, 'board-left', { maxH: 800 });
  await open(pPage, '/desk');
  await pPage.keyboard.press('Control+k');
  await expect(pPage.getByTestId('command-palette')).toBeVisible();
  await pPage.keyboard.type('contact');
  await snap(pPage, 'palette', { sel: pPage.getByTestId('command-palette') });
  await pPage.keyboard.press('Escape');
  await open(pPage, '/help');
  await snap(pPage, 'help-centre', { maxH: 900, content: true });
  await open(pPage, '/help/install-troubleshooting');
  await snap(pPage, 'help-install', { maxH: 900, content: true });
  // the tour starts from Help ("Replay the tour")
  await open(pPage, '/help');
  await pPage.getByTestId('help-replay-tour').click();
  await expect(pPage.getByTestId('tour')).toBeVisible();
  await snap(pPage, 'tour-1', { maxH: 800 });
  await pPage.keyboard.press('Escape');
});

cap('cards', async () => {
  await open(pPage, '/cards/new?project=WEB');
  await snap(pPage, 'card-new', { maxH: 1400, content: true });
  const form = pPage.getByRole('form', { name: 'New card' });
  await form.getByLabel('Title').fill('Show stock level on the product page');
  await form.getByLabel('Context').fill('Customers ask whether an item is in stock before they order.');
  await form.getByRole('button', { name: 'Specify' }).click();
  await expect(pPage.getByText(/still missing|Fix the highlighted/).first()).toBeVisible();
  await snap(pPage, 'card-new-missing', { maxH: 1500, content: true });
  await open(pPage, `/cards/${S.ids['card:bounced0']}`);
  await snap(pPage, 'card-detail', { maxH: 1300, content: true });
  await open(pPage, `/cards/${S.ids['card:hang_build']}`);
  await snap(pPage, 'card-live', { maxH: 1000, content: true });
  await open(pPage, `/cards/${S.ids['card:backoff']}`);
  await snap(pPage, 'card-backoff', { maxH: 700, content: true });
  await open(pPage, `/cards/${S.ids.research1}`);
  await snap(pPage, 'card-published', { maxH: 1300, content: true });
  await open(pPage, `/cards/${S.ids['card:backoff']}`);
  await pPage.getByTestId('set-risk').click();
  await snap(pPage, 'dlg-risk', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
});

cap('the desk and the ledger', async () => {
  await open(pPage, '/desk');
  await snap(pPage, 'desk', { maxH: 1500, content: true });
  const item = (title: string | RegExp) => pPage.getByRole('article', { name: title }).first();
  const shots: Array<[string, string | RegExp]> = [
    ['desk-question', /How long may we keep the personal data/],
    ['desk-outbound', /Approve resolution for Jira SUP-231/],
    ['desk-large-merge', /Approve merge of/],
    ['desk-branch', /Which branch is the working branch of notes-app/],
    ['desk-phase-done', /is done: approve/],
    ['desk-floor-report', /^Floor report /],
  ];
  for (const [name, title] of shots) {
    const el = item(title);
    await expect(el, name).toBeVisible();
    await snap(pPage, name, { sel: el });
  }
  await open(pPage, '/ledger');
  await snap(pPage, 'ledger', { maxH: 1100, content: true });
});

cap('agents', async () => {
  await pPage.setViewportSize({ width: 1280, height: 1300 });
  await open(pPage, '/agents');
  await snap(pPage, 'hr', { maxH: 1300, content: true });
  const recs = pPage.getByTestId('recommendations');
  for (const d of await recs.locator('details').all()) await d.locator('summary').click();
  await snap(pPage, 'hr-recs', { sel: recs });
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
  await pPage.getByRole('button', { name: 'Allowed projects of Ada' }).click();
  await snap(pPage, 'dlg-allowlist', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
});

cap('projects, settings, phases, conversion', async () => {
  await open(pPage, '/projects');
  await snap(pPage, 'projects-ranked', { maxH: 900, content: true });
  await pPage.getByRole('button', { name: 'New project' }).click();
  await snap(pPage, 'dlg-new-project', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
  await pPage.setViewportSize({ width: 1280, height: 1000 });
  await open(pPage, `/projects/${S.ids['project:WEB']}/settings`);
  await snap(pPage, 'project-settings', { maxH: 1000, content: true });
  await snap(pPage, 'budget-panel', { sel: section(pPage, /Monthly budget/) });
  await open(pPage, '/settings/vaults');
  await snap(pPage, 'vaults', { maxH: 1300, content: true });
  await open(pPage, `/p/WEB/phases/${String(S.ids['phase:ref']).replace(/^.*-P/, '')}`);
  await snap(pPage, 'phase', { maxH: 1300, content: true });
  await open(pPage, '/p/SHOOT/research');
  await snap(pPage, 'research-tab', { maxH: 1200, content: true });
  await open(pPage, '/p/SHOOT/board');
  await pPage
    .getByRole('button', { name: /Convert to project/ })
    .first()
    .click();
  await snap(pPage, 'dlg-convert', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
  await open(pPage, `/projects/${S.ids['project:WEB']}/settings`);
  await pPage.getByRole('button', { name: 'Archive project' }).click();
  await snap(pPage, 'dlg-archive', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
});

cap('budgets: a project over its budget (restored at the end)', async () => {
  const web = S.ids['project:WEB'] as string;
  const p = await pieter();
  const spend = Number(S.ids.spendWeb);
  const monthly = Number(S.ids.budgetWeb);
  try {
    expect(
      (await p.put(`/api/projects/${web}/budget`, { data: { monthly: Math.max(0.01, spend * 0.9) } })).ok(),
    ).toBeTruthy();
    await open(pPage, '/p/WEB/board');
    await expect(pPage.getByTestId('budget-banner')).toBeVisible({ timeout: 30_000 });
    await snap(pPage, 'budget-banner', { maxH: 420, content: true });
  } finally {
    expect((await p.put(`/api/projects/${web}/budget`, { data: { monthly } })).ok()).toBeTruthy();
  }
  await open(pPage, '/costs');
  await snap(pPage, 'costs', { maxH: 1500, content: true });
});

cap('workstations and the installer', async () => {
  await pPage.setViewportSize({ width: 1280, height: 1200 });
  await open(pPage, '/workstations');
  await expandWorkstation(pPage.getByTestId("workstation-Pieter's desktop (WSL2)"));
  await snap(pPage, 'ws-hygiene', { sel: pPage.getByTestId("hygiene-Pieter's desktop (WSL2)") });
  await open(mPage, '/workstations');
  const laptop = mPage.getByTestId("workstation-Maya's laptop");
  await expect(laptop).toBeVisible();
  await expandWorkstation(laptop);
  await snap(mPage, 'ws-offline', { sel: laptop });
  // the wizard (the script is never run: the progress is reported the way the script does it)
  await open(pPage, '/workstations');
  await pPage.setViewportSize({ width: 1280, height: 1800 });
  await pPage.getByTestId('add-workstation-button').click();
  const wiz = pPage.getByRole('dialog');
  await expect(wiz.getByTestId('install-command')).toBeVisible();
  await snap(pPage, 'installer-choose', { sel: wiz, crop: { top: 0, height: 330 } });
  const command = (await pPage.getByTestId('install-command').innerText()).trim();
  const token = /\/install\/([^/]+)\//.exec(command)?.[1] as string;
  await snap(pPage, 'installer-command', { sel: wiz, crop: { top: 330, height: 640 } });
  const report = (body: Record<string, string>) =>
    fetch(`${BASE_URL}/install/${token}/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  await report({ step: 'installer', status: 'start', detail: 'linux' });
  await report({ step: 'Paired', status: 'ok', detail: 'Office PC' });
  for (const [step, status, detail] of [
    ['doctor:node', 'ok', 'v22.23.2'],
    ['doctor:git', 'ok', 'git version 2.47.1'],
    ['doctor:claude', 'ok', 'signed in'],
    ['doctor:docker', 'warn', 'not found (optional)'],
  ] as const)
    await report({ step, status, detail });
  await expect(pPage.getByTestId('doctor-node')).toBeVisible({ timeout: 20_000 });
  await snap(pPage, 'installer-progress', { sel: wiz, crop: { top: 940, height: 520 } });
  await pPage.keyboard.press('Escape');
});

cap('organization', async () => {
  await pPage.setViewportSize({ width: 1280, height: 1100 });
  await open(pPage, '/settings/org');
  await snap(pPage, 'org-general', { maxH: 1000, content: true });
  await open(pPage, '/settings/org?tab=members');
  await snap(pPage, 'org-members', { maxH: 900, content: true });
  await open(pPage, '/settings/org?tab=invitations');
  await snap(pPage, 'org-invitations', { maxH: 800, content: true });
  await pPage
    .getByTestId('invite-member')
    .click()
    .catch(() => undefined);
  await open(pPage, '/settings/org?tab=members');
  await pPage.getByTestId('invite-member').click();
  await snap(pPage, 'dlg-invite', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
  await open(pPage, '/settings/org?tab=guests');
  await snap(pPage, 'org-guests', { maxH: 700, content: true });
  await open(pPage, '/settings/org?tab=plan');
  await snap(pPage, 'org-plan', { maxH: 900, content: true });
  await open(pPage, '/org-chart');
  await snap(pPage, 'org-chart', { maxH: 1100, content: true });
  await open(pPage, '/org');
  await snap(pPage, 'org-roles', { maxH: 1300, content: true });
  await open(pPage, '/org?tab=workflows');
  await pPage.getByRole('button', { name: 'View support v1' }).click();
  await snap(pPage, 'org-workflows', { maxH: 1500, content: true });
  await open(pPage, '/settings');
  await snap(pPage, 'settings', { maxH: 1300, content: true });
  await pPage.getByRole('button', { name: 'Set up', exact: true }).click();
  await snap(pPage, 'security-2fa', { sel: pPage.getByRole('dialog') });
});

cap('schedules, interests, intake', async () => {
  await pPage.setViewportSize({ width: 1280, height: 1200 });
  await open(pPage, '/schedules');
  await snap(pPage, 'schedules', { maxH: 1400, content: true });
  await pPage.getByRole('button', { name: 'New automation' }).first().click();
  await snap(pPage, 'schedule-wizard', { sel: pPage.getByRole('dialog') });
  await pPage.keyboard.press('Escape');
  await open(pPage, '/interests');
  await snap(pPage, 'interests', { maxH: 1100, content: true });
  const interestUrl = `/interests/${S.ids['interest:NEWS']}`;
  await open(pPage, `${interestUrl}?tab=digest`);
  await snap(pPage, 'feed', { maxH: 1500, content: true });
  await open(pPage, `${interestUrl}?tab=settings`);
  await snap(pPage, 'interest-settings', { maxH: 1000, content: true });
  await open(pPage, `${interestUrl}?tab=taste`);
  await snap(pPage, 'interest-taste', { maxH: 1000, content: true });
  await open(pPage, `/intake/${S.ids.intakeJira}`);
  await snap(pPage, 'intake-view', { maxH: 900, content: true });
});

cap('a Member and a Guest', async () => {
  await open(nPage, '/projects');
  await snap(nPage, 'member-projects', { maxH: 700, content: true });
  await open(nPage, '/settings/org?tab=members');
  await snap(nPage, 'member-org', { maxH: 800, content: true });
  await open(mPage, '/projects');
  await expect(mPage.getByTestId('project-invitations')).toBeVisible();
  await snap(mPage, 'guest-invitation', { sel: mPage.getByTestId('project-invitations') });
  await open(mPage, '/p/WEB/board');
  await snap(mPage, 'guest-project', { maxH: 800 });
});

cap('contact us and my requests', async () => {
  await open(mPage, '/desk');
  await mPage.getByTestId('user-menu').click();
  await mPage.getByTestId('menu-contact').click();
  const dlg = mPage.getByRole('dialog', { name: 'Contact us' });
  await expect(dlg.getByTestId('contact-screenshot')).toBeVisible({ timeout: 30_000 });
  await dlg.getByTestId('contact-kind').selectOption('question');
  await dlg.getByTestId('contact-subject').fill('Can a guest see the budget?');
  await dlg.getByTestId('contact-message').fill('A project of mine was paused and I could not see why.');
  await snap(mPage, 'contact-us', { sel: dlg });
  await mPage.keyboard.press('Escape');
  await open(mPage, '/help/requests');
  await snap(mPage, 'my-requests', { maxH: 700, content: true });
});

cap('the platform area', async () => {
  const { freshTotp } = await import('../support/totp.ts');
  const ctx = await pPage
    .context()
    .browser()!
    .newContext({ viewport: { width: 1280, height: 900 } });
  const s = await ctx.newPage();
  await s.goto('/login');
  await s.getByLabel('Email').fill(SUPER_DEMO.email);
  await s.getByLabel('Password').fill(SUPER_DEMO.password);
  await s.getByRole('button', { name: 'Sign in' }).click();
  await s.getByTestId('login-code').fill(await freshTotp(S.ids.superSecret as string));
  await s.getByRole('button', { name: 'Verify' }).click();
  await expect(s).toHaveURL(/\/platform/);
  await open(s, '/platform');
  await snap(s, 'platform-orgs', { maxH: 800, content: true });
  await s
    .getByRole('link', { name: /Harbor Cafe/ })
    .first()
    .click();
  await s.waitForLoadState('networkidle');
  await snap(s, 'platform-org-detail', { maxH: 1100, content: true });
  await open(s, '/platform/invitations');
  await snap(s, 'platform-invitations', { maxH: 900, content: true });
  await open(s, '/platform/users');
  await snap(s, 'platform-users', { maxH: 900, content: true });
  await open(s, '/platform/support');
  await snap(s, 'platform-support', { maxH: 900, content: true });
  await s.getByTestId('support-inbox').getByRole('link').first().click();
  await s.waitForLoadState('networkidle');
  await snap(s, 'platform-ticket', { maxH: 1200, content: true });
  await open(s, '/platform/audit');
  await snap(s, 'platform-audit', { maxH: 900, content: true });
  await ctx.close();
});

cap(
  'the newer features: integrations, batch intake, run a branch, manual QA, commit as, archive, value report',
  async () => {
    await pPage.setViewportSize({ width: 1280, height: 1200 });
    // Integrations of the first workstation
    await open(pPage, '/integrations');
    await snap(pPage, 'integrations-index', { maxH: 700, content: true });
    await open(pPage, `/workstations/${S.ids.wsA}/integrations`);
    await snap(pPage, 'integrations', { maxH: 1000, content: true });
    // batch intake: the form with a pasted list, then a finished batch and one with a question
    await open(pPage, '/intake');
    await pPage.getByRole('tab', { name: 'Batch' }).click();
    await pPage
      .getByLabel('Tickets, one per line')
      .fill('SUP-251\nSUP-252\nacme/web#12\nhttps://example.atlassian.net/browse/SUP-253');
    await snap(pPage, 'intake-batch-form', {
      sel: pPage.getByRole('form', { name: 'Start a batch intake' }),
    });
    await open(pPage, `/intake/batches/${S.ids.batch}`);
    await snap(pPage, 'intake-batch', { maxH: 1100, content: true });
    await open(pPage, `/intake/batches/${S.ids.batchAsk}`);
    await snap(pPage, 'intake-batch-question', { maxH: 900, content: true });
    // run a branch: the dialog on the board and the panel of a started environment. The mock DevOps engineer cannot
    // start real services, so the environment it left behind is shown as a running one (demo data, the way the
    // seed rewords the mock agents' questions).
    const svc = (name: string, port: number) => ({
      name,
      state: 'healthy',
      ports: [{ name: 'http', port, url: `http://localhost:${port}/` }],
      urls: [`http://localhost:${port}/`],
      health: 'passing',
      restarts: 0,
      sandbox: 'sandboxed',
    });
    await q(
      `UPDATE run_environments SET state='healthy', services_status=$2::jsonb, last_error=NULL, stop_reason=NULL,
       stop_requested_at=NULL, stopped_at=NULL, healthy_at=now(), activity=NULL WHERE id=$1`,
      [S.ids.runEnv, JSON.stringify([svc('web', 20001), svc('api', 20002)])],
    );
    await open(pPage, '/p/WEB/board');
    await expect(pPage.getByTestId('board-runs')).toBeVisible({ timeout: 30_000 });
    await snap(pPage, 'run-panel', { sel: pPage.getByTestId('board-runs') });
    await pPage.getByTestId('run-branch-open').click();
    await expect(pPage.getByRole('dialog')).toBeVisible();
    await snap(pPage, 'dlg-run-branch', { sel: pPage.getByRole('dialog') });
    await pPage.keyboard.press('Escape');
    // the other board shots do not show an environment: put it back to what the mock DevOps engineer left
    await q(
      `UPDATE run_environments SET state='failed', services_status='[]'::jsonb, stop_reason='failed', stopped_at=now(),
       last_error='The DevOps engineer finished without making the environment ready.' WHERE id=$1`,
      [S.ids.runEnv],
    );
    // manual QA: the card, the desk item and the setting
    await open(pPage, `/cards/${S.ids['card:qa']}`);
    await expect(pPage.getByTestId('qa-panel')).toBeVisible();
    await snap(pPage, 'qa-panel', { sel: pPage.getByTestId('qa-panel') });
    await open(pPage, '/desk');
    const qaItem = pPage.getByTestId('qa-desk-item').first().locator('xpath=ancestor::article[1]');
    await snap(pPage, 'desk-qa', { sel: qaItem });
    await open(pPage, '/p/WEB/board');
    await snap(pPage, 'board-qa', { maxH: 1000, content: true });
    await open(pPage, `/projects/${S.ids['project:WEB']}/settings`);
    // the form's own placeholders are the product's example; show the demo owner (nothing is saved)
    const commitAs = pPage.getByTestId('commit-as');
    await commitAs.getByLabel('Name').fill('Pieter Demo');
    await commitAs.getByLabel('E-mail').fill('pieter@demo.local');
    await snap(pPage, 'commit-as', { sel: commitAs });
    await snap(pPage, 'manual-qa-setting', {
      sel: pPage.getByTestId('manual-qa-toggle').locator('xpath=ancestor::section[1]'),
    });
    await snap(pPage, 'run-settings', {
      sel: pPage.getByTestId('run-settings').locator('xpath=ancestor::section[1]'),
    });
    // the archive of finished cards
    await open(pPage, '/p/WEB/archive');
    await snap(pPage, 'archive', { maxH: 900, content: true });
    // the value report on the Costs page
    await open(pPage, '/costs');
    await snap(pPage, 'value-report', {
      sel: pPage.getByTestId('value-panel').locator('xpath=ancestor::section[1]'),
    });
  },
);

cap('on a phone', async () => {
  for (const [name, path] of [
    ['m-board', '/p/WEB/board'],
    ['m-desk', '/desk'],
    ['m-card', `/cards/${S.ids['card:guest']}`],
  ] as const) {
    await open(phone, path);
    await snap(phone, name, { maxH: 900 });
  }
});
