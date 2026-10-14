import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, OUTBOXER, paths } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';

// M8: the outbox (docs/PLAN.md M8 AC). One user, one runner (mock runtime) with a fake `gh` and a fake Jira REST server,
// project OUT on the toy repo, a mock BA (Olga), a builder (Bob) and a reviewer (Ria). The BA drafts the update for a
// finished card's ticket; the manager approves, edits or rejects it on the desk; only an approved draft is posted. No
// real Jira, GitHub or Claude is ever contacted.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('outbox');
const GH_LOG = join(paths.vaults, 'outbox-gh.log');
const GH_FAIL = join(paths.vaults, 'outbox-gh.fail');
let page: Page;
let api: APIRequestContext;
let projectId: string;
let repoId: string;
let jiraServer: Server;
const jiraCalls: Array<{ path: string; auth: string | undefined; body: string }> = [];

const ghLog = () => (existsSync(GH_LOG) ? readFileSync(GH_LOG, 'utf8').trim().split('\n') : []);
const ghPosts = () => ghLog().filter((l) => /^issue (comment|close) /.test(l));
const card = (ref: string) => q<any>('SELECT * FROM cards WHERE ref=$1', [ref]).then((r) => r[0]);
const draftsOf = (cardId: string) =>
  q<any>('SELECT * FROM outbound_drafts WHERE card_id=$1 ORDER BY created_at', [cardId]);
const draftWhen = (cardId: string, what: string, pred: (d: any) => boolean, ms = 120_000) =>
  waitFor(
    what,
    async () => (await draftsOf(cardId)).at(-1),
    (d) => !!d && pred(d),
    ms,
  );

const SPEC = {
  context: 'A feature for the toy project.',
  requirements: 'Do the thing.',
  acceptanceCriteria: ['It works'],
  affectedAreas: 'index.js',
  constraints: 'None',
  testPlan: 'Run it',
};

/** A card from a ticket, built by the mock builder and moved to Finalize, where the BA drafts the update and finalizes. */
async function ticketCard(title: string, externalRef: string, extra: Record<string, unknown> = {}) {
  const res = await api.post('/api/cards', {
    data: {
      projectId,
      title,
      cardType: 'feature',
      repoId,
      completionAction: 'push_branch',
      fields: { ...SPEC, externalRef, mock: { build: ['ok'] }, ...extra },
      specify: true,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const c = (await res.json()).card as { id: string; ref: string };
  await waitFor(
    `${c.ref} in review`,
    () => card(c.ref),
    (x) => x?.stage === 'review',
    120_000,
  );
  const move = await api.post(`/api/cards/${c.id}/move`, {
    data: { toStage: 'finalize', reason: 'review and test done elsewhere' },
  });
  expect(move.ok(), await move.text()).toBeTruthy();
  return c;
}

const deskItemOf = (cardId: string) =>
  waitFor(
    'the outbound approval on the desk',
    () =>
      q<any>(`SELECT id FROM desk_items WHERE card_id=$1 AND subkind='outbound' AND status='open'`, [cardId]),
    (r) => r.length > 0,
    120_000,
  ).then((r) => r[0].id as string);

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, OUTBOXER);
  api = await apiAs(OUTBOXER.email, OUTBOXER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test.afterAll(async () => {
  jiraServer?.close();
});

test('setup: a runner with a fake gh and a fake Jira, project OUT, a BA, a builder and a reviewer', async () => {
  mkdirSync(paths.vaults, { recursive: true });
  rmSync(GH_LOG, { force: true });
  rmSync(GH_FAIL, { force: true });
  // A fake `gh`: logs its arguments, posts succeed with a comment URL unless the fail flag exists.
  const fakeGh = join(paths.vaults, 'outbox-gh.sh');
  writeFileSync(
    fakeGh,
    `#!/bin/sh
echo "$@" >> "${GH_LOG}"
case "$2" in
  comment|close)
    if [ -f "${GH_FAIL}" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
    echo "https://github.com/acme/toy/issues/$3#issuecomment-$3001" ;;
  *) echo '{"title":"t","body":"b","state":"OPEN","url":"https://github.com/acme/toy/issues/1","labels":[],"comments":[]}' ;;
esac
`,
  );
  chmodSync(fakeGh, 0o755);
  // A fake Jira: records what the runner posts and answers like the REST API.
  jiraServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      jiraCalls.push({ path: `${req.method} ${req.url}`, auth: req.headers.authorization, body });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: '10077' }));
    });
  });
  await new Promise<void>((r) => jiraServer.listen(0, '127.0.0.1', r));
  const jiraUrl = `http://127.0.0.1:${(jiraServer.address() as AddressInfo).port}`;

  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Outbox Box', HOME);
  addRepoRoot(paths.repoRoot, HOME);
  // the owner's Jira credentials live only in this runner's config
  const cfgPath = join(HOME, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.jira = { baseUrl: jiraUrl, email: 'owner@acme.test', apiToken: 'owner-token' };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  startRunner({ AOM_MOCK_STEP_MS: '200', AOM_GH_BIN: fakeGh }, HOME);
  const ws = await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  const workstationId = ws[0].id as string;

  const proj = await api.post('/api/projects', { data: { key: 'OUT', name: 'Outbox project' } });
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
    (n) => n >= 1,
    30_000,
  );
  for (const [name, roleKey, seniority] of [
    ['Olga', 'ba', 'senior'],
    ['Bob', 'builder', 'junior'],
    ['Ria', 'reviewer', 'senior'],
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

test('AC approve with an edit: the BA drafts the update, nothing is posted until the manager edits and approves it; the edit is posted', async () => {
  const c = await ticketCard('Export archived items', 'acme/toy#12');
  const d = await draftWhen(c.id, 'the BA drafted the update', () => true);
  expect(d).toMatchObject({
    status: 'pending',
    external_system: 'github',
    external_key: 'acme/toy#12',
    kind: 'resolution',
    drafted_by_kind: 'agent',
  });
  const itemId = await deskItemOf(c.id);
  // the card finishes (BA finalize) while the draft waits: nothing went out
  await waitFor(
    'the card is finalized',
    () => card(c.ref),
    (x) => x.status === 'done',
    120_000,
  );
  expect(ghPosts()).toEqual([]);
  expect(await q(`SELECT 1 FROM runner_commands WHERE type='outbound.post'`)).toHaveLength(0);

  await page.goto('/desk');
  const item = page.getByTestId(`desk-item-${itemId}`);
  await expect(item).toContainText('Approve resolution for GitHub acme/toy#12');
  await expect(item.getByTestId('outbound-text')).toHaveValue('Export archived items is done and ready.');
  const edited = 'Archived items are part of the export from the next release.';
  await item.getByTestId('outbound-text').fill(edited);
  await expect(item.getByTestId('outbound-diff-view')).toBeVisible();
  await page.screenshot({ path: `${paths.vaults}/outbox-approval.png`, fullPage: true });
  await item.getByRole('button', { name: 'Approve and post my edit' }).click();

  await draftWhen(c.id, 'posted', (x) => x.status === 'posted');
  expect(await draftsOf(c.id)).toMatchObject([
    { body: 'Export archived items is done and ready.', final_body: edited, edited: true, status: 'posted' },
  ]);
  // gh closed the issue with the edited text as its closing comment, on this workstation
  expect(ghPosts()).toEqual([`issue close 12 --repo acme/toy --comment ${edited}`]);
  expect((await draftsOf(c.id))[0].external_ref).toMatch(
    /^https:\/\/github\.com\/acme\/toy\/issues\/12#issuecomment-/,
  );
  const approved = await q<any>(
    `SELECT payload FROM events WHERE type='OutboundApproved' ORDER BY seq DESC LIMIT 1`,
  );
  expect(approved[0].payload).toMatchObject({ finalBody: edited, edited: true });

  // the result is on the card, with the edit shown as a diff
  await page.goto(`/cards/${c.ref}`);
  const history = page.getByTestId('outbound-history');
  await expect(history).toContainText('Posted');
  await expect(history).toContainText('Posted as edited');
  await expect(history.getByTestId(`outbound-ref-${d.id}`)).toContainText('issues/12#issuecomment-');
  await page.screenshot({ path: `${paths.vaults}/outbox-history.png`, fullPage: true });
});

test('AC reject: a rejected draft is never posted', async () => {
  const before = ghPosts().length;
  const c = await ticketCard('Rejected update', 'acme/toy#13');
  const itemId = await deskItemOf(c.id);
  await page.goto('/desk');
  const item = page.getByTestId(`desk-item-${itemId}`);
  await item.getByTestId('outbound-reject').click();
  await item.getByTestId('outbound-reason').fill('not for the customer');
  await item.getByTestId('outbound-reject-confirm').click();
  await draftWhen(c.id, 'rejected', (x) => x.status === 'rejected');
  expect((await draftsOf(c.id))[0]).toMatchObject({
    reject_reason: 'not for the customer',
    final_body: null,
  });
  await waitFor(
    'the card is finalized',
    () => card(c.ref),
    (x) => x.status === 'done',
    120_000,
  );
  await new Promise((r) => setTimeout(r, 1500));
  expect(ghPosts()).toHaveLength(before);
  expect(
    await q(`SELECT 1 FROM runner_commands WHERE type='outbound.post' AND payload->>'draftId'=$1`, [
      (await draftsOf(c.id))[0].id,
    ]),
  ).toHaveLength(0);
});

test('AC leak check: a draft that names agents or review internals is blocked; the BA rewrites it and only the clean draft reaches the desk', async () => {
  const c = await ticketCard('Leaky update', 'acme/toy#14', {
    mockOutbound: { body: 'Olga and Bob finished this after the reviewer bounced it twice.' },
  });
  const itemId = await deskItemOf(c.id);
  const drafts = await draftsOf(c.id);
  expect(drafts.map((x) => x.status).sort()).toEqual(['blocked', 'pending']);
  const blocked = drafts.find((x) => x.status === 'blocked');
  expect(blocked.blocked_matches.join(' ')).toMatch(/Olga/);
  expect(blocked.blocked_matches.join(' ')).toMatch(/Bob/);
  expect(blocked.blocked_matches.join(' ')).toMatch(/bounce/);
  expect((await q<any>('SELECT body FROM desk_items WHERE id=$1', [itemId]))[0].body).toBe(
    'Leaky update is done and ready.',
  );
  expect(await q(`SELECT 1 FROM desk_items WHERE card_id=$1 AND subkind='outbound'`, [c.id])).toHaveLength(1);

  // the manager cannot slip internals in through an edit either: the desk refuses it
  await page.goto('/desk');
  const item = page.getByTestId(`desk-item-${itemId}`);
  await item.getByTestId('outbound-text').fill('Bob did this.');
  await item.getByTestId('outbound-approve').click();
  await expect(item.getByRole('alert')).toContainText('internal details');
  expect((await draftsOf(c.id)).find((x) => x.status === 'pending')).toBeTruthy();
  // the card history shows the blocked attempt
  await page.goto(`/cards/${c.ref}`);
  await expect(page.getByTestId(`outbound-blocked-${blocked.id}`)).toContainText(
    'Blocked before it reached the desk',
  );
  // reject it to leave the queue clean
  await api.post(`/api/desk/${itemId}/resolve`, { data: { resolution: 'rejected' } });
});

test('AC failures land on the desk and can be retried; the post goes out once', async () => {
  const c = await ticketCard('Flaky update', 'acme/toy#15');
  const itemId = await deskItemOf(c.id);
  writeFileSync(GH_FAIL, '1');
  const before = ghPosts().length;
  const res = await api.post(`/api/desk/${itemId}/resolve`, { data: { resolution: 'approved' } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const failed = await draftWhen(c.id, 'failed', (x) => x.status === 'failed');
  expect(failed.error).toMatch(/gh issue close failed: HTTP 502/);
  const alert = (
    await q<any>(`SELECT kind, status, body FROM desk_items WHERE card_id=$1 AND subkind='outbound_failed'`, [
      c.id,
    ])
  )[0];
  expect(alert).toMatchObject({ kind: 'alert', status: 'open' });
  await page.goto('/desk');
  await expect(
    page.getByRole('article', { name: /Could not post the update to GitHub acme\/toy#15/ }),
  ).toContainText('HTTP 502');

  rmSync(GH_FAIL, { force: true });
  await page.goto(`/cards/${c.ref}`);
  await expect(page.getByTestId(`outbound-error-${failed.id}`)).toContainText('HTTP 502');
  await page.getByTestId(`outbound-retry-${failed.id}`).click();
  await draftWhen(c.id, 'posted after the retry', (x) => x.status === 'posted');
  // two attempts reached gh (one failed, one posted); exactly one is a success and the draft is posted once
  expect(ghPosts().length - before).toBe(2);
  expect(
    (
      await q<any>(
        `SELECT status FROM desk_items WHERE id=(SELECT desk_item_id FROM outbound_drafts WHERE id=$1)`,
        [failed.id],
      )
    )[0].status,
  ).not.toBe('open');
  const posted = await q(`SELECT 1 FROM events WHERE type='OutboundPosted' AND payload->>'draftId'=$1`, [
    failed.id,
  ]);
  expect(posted).toHaveLength(1);
});

test('AC Jira: an approved draft is posted by the owner workstation with the token in its config, exactly as approved', async () => {
  const c = await ticketCard('Jira update', 'ABC-77');
  const d = await draftWhen(c.id, 'drafted', () => true);
  expect(d).toMatchObject({ external_system: 'jira', external_key: 'ABC-77', status: 'pending' });
  const itemId = await deskItemOf(c.id);
  expect(jiraCalls).toEqual([]);
  const text = 'Jira update is done; the change is in the next release.';
  const res = await api.post(`/api/desk/${itemId}/resolve`, {
    data: { resolution: 'approved', editedBody: text },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const posted = await draftWhen(c.id, 'posted', (x) => x.status === 'posted');
  expect(jiraCalls).toHaveLength(1);
  expect(jiraCalls[0]).toMatchObject({
    path: 'POST /rest/api/2/issue/ABC-77/comment',
    auth: `Basic ${Buffer.from('owner@acme.test:owner-token').toString('base64')}`,
  });
  expect(JSON.parse(jiraCalls[0]?.body as string)).toEqual({ body: text });
  expect(posted.external_ref).toMatch(/\/browse\/ABC-77\?focusedCommentId=10077$/);
  await page.goto(`/cards/${c.ref}`);
  await expect(page.getByTestId(`outbound-ref-${d.id}`)).toContainText('focusedCommentId=10077');
});

test('AC posting uses the owner workstation only: the post command is queued for it and nobody else', async () => {
  const cmds = await q<any>(
    `SELECT rc.workstation_id, w.user_id FROM runner_commands rc JOIN workstations w ON w.id=rc.workstation_id WHERE rc.type='outbound.post'`,
  );
  expect(cmds.length).toBeGreaterThanOrEqual(3);
  const owner = (await q<any>(`SELECT id FROM users WHERE email=$1`, [OUTBOXER.email]))[0];
  expect(cmds.every((x) => x.user_id === owner.id)).toBe(true);
});
