import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, paths } from '../support/env.ts';
import { pairRunner, startRunner } from '../support/runner.ts';
import { saveJourneyInDesigner } from '../support/ui.ts';

// Journey waits, gates and webhooks: a wait configured in the designer shows its deadline on the instance; a timeout runs
// its action (elapsed, reminder, move to a step, ask the desk, cancel) and leaves a visible line; a gate is decided on the
// desk or the instance and follows its approve or reject handoff, also after an escalation; an inbound hook with a bad
// signature is refused with 401 and nothing of the payload is kept, a signed one starts a journey on a new or matched
// record; an outbound call is sent by the workstation, retried with backoff and its final result shown on the instance.
// Standalone: its own user, organization, project and mock runner. The server's test clock is moved forward (minutes and
// hours, never across a day) to make deadlines due.
test.describe.configure({ mode: 'serial' });

const WAITER = { email: 'waiter@e2e.test', name: 'E2E Waiter', password: 'waiter-password-12345' };
const HOME = paths.runnerHome('journey-waits');
const MIN = 60_000;

let page: Page;
let api: APIRequestContext;
let projectId = '';
let workflowKey = '';
let workstationId = '';
let receiver: Server;
let receiverUrl = '';
const received: Array<{ path: string; body: string; headers: Record<string, unknown> }> = [];
let flakyLeft = 1;

type Run = { visit: number; stepId: string; status: string; cardId: string | null };
type Instance = {
  status: string;
  currentStepId: string;
  currentVisit: number;
  record: { id: string };
  history: Run[];
};
type Wait = {
  id: string;
  stepId: string;
  kind: string;
  status: string;
  deadlineAt: string | null;
  remindersSent: number;
  resolution: string | null;
  events: Array<{ type: string; text: string }>;
};
type Call = {
  id: string;
  status: string;
  attempts: number;
  lastHttpStatus: number | null;
  nextAttemptAt: string | null;
};

const getInstance = async (id: string): Promise<Instance> => {
  const r = await api.get(`/api/journey-instances/${id}`);
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
};
const waitsOf = async (id: string): Promise<{ waits: Wait[]; calls: Call[] }> => {
  const r = await api.get(`/api/journey-instances/${id}/waits`);
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
};
const instanceAt = (id: string, step: string, status?: string) =>
  waitFor(
    `instance at ${step}${status ? ` (${status})` : ''}`,
    () => getInstance(id),
    (v) =>
      v.currentStepId === step &&
      (!status || v.history.find((h) => h.visit === v.currentVisit)?.status === status),
  );
/** Moves the server clock and runs the scheduler at once (the journey tick is part of it). */
const advance = async (ms: number) => {
  const r = await api.post('/api/test/clock', { data: { advanceMs: ms } });
  expect(r.ok(), await r.text()).toBeTruthy();
};
const tick = () => advance(0);
const openDeskItems = (instanceId: string) =>
  q<{ id: string; subkind: string; status: string }>(
    "SELECT id, subkind, status FROM desk_items WHERE status='open' AND data->>'instanceId'=$1",
    [instanceId],
  );

const createJourney = async (definition: Record<string, unknown>): Promise<string> => {
  const r = await api.post('/api/journeys', { data: { projectId, definition } });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).id;
};
const saveJourney = async (id: string, definition: Record<string, unknown>) => {
  const cur = await (await api.get(`/api/journeys/${id}`)).json();
  const r = await api.put(`/api/journeys/${id}`, { data: { definition, baseVersion: cur.version } });
  expect(r.ok(), await r.text()).toBeTruthy();
};
const start = async (journeyId: string, displayName: string, externalId?: string): Promise<string> => {
  const r = await api.post('/api/journey-instances', {
    data: { journeyId, record: { type: 'client', displayName, ...(externalId ? { externalId } : {}) } },
  });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).id;
};
const wf = (id: string, label: string) => ({ kind: 'workflow', id, label, workflowKey });

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, WAITER);
  api = await apiAs(WAITER.email, WAITER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
  const proj = await api.post('/api/projects', { data: { key: 'JWT', name: 'Tenancies' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  const rows = await q<{ workflow_key: string }>(
    'SELECT workflow_key FROM project_workflows WHERE project_id=$1 AND is_primary',
    [projectId],
  );
  workflowKey = rows[0]?.workflow_key ?? '';
  expect(workflowKey).not.toBe('');

  // the firm's own endpoint for outbound calls: /flaky answers 500 once and then 200, /down always 503
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      received.push({ path: req.url ?? '', body, headers: req.headers });
      if (req.url === '/down') res.statusCode = 503;
      else if (req.url === '/flaky' && flakyLeft-- > 0) res.statusCode = 500;
      else res.statusCode = 200;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', () => r()));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => receiver?.close(() => r()));
});

test('designer: a wait is configured with what it waits for, how long and the timeout action, and reopens unchanged', async () => {
  const id = await createJourney({
    name: 'Designer waits',
    recordType: 'client',
    firstStepId: 'lead',
    steps: [wf('lead', 'Lead'), wf('after', 'After')],
    handoffs: [],
  });
  await page.goto(`/journeys/${id}`);
  await page.getByRole('button', { name: 'Add a wait' }).click();
  const settings = page.locator('[data-testid^="wait-settings-"]');
  await expect(settings).toHaveCount(1);
  await settings.getByLabel('Wait for', { exact: true }).selectOption('duration');
  await settings.getByLabel('Wait at most').fill('10');
  await settings.getByLabel('Unit').selectOption('minutes');
  await saveJourneyInDesigner(page, () => page.getByRole('button', { name: 'Save', exact: true }).click());

  let saved = (await (await api.get(`/api/journeys/${id}`)).json()).definition;
  const wait = saved.steps.find((s: { kind: string }) => s.kind === 'wait');
  expect(wait.waitFor).toEqual({ kind: 'duration' });
  expect(wait.duration).toEqual({ amount: 10, unit: 'minutes' });

  // a webhook wait needs a timeout action: pick "Ask the desk what to do", save, reopen
  await settings.getByLabel('Wait for', { exact: true }).selectOption('webhook');
  await settings.getByLabel('When time runs out').selectOption('escalate');
  await saveJourneyInDesigner(page, () => page.getByRole('button', { name: 'Save', exact: true }).click());
  saved = (await (await api.get(`/api/journeys/${id}`)).json()).definition;
  expect(saved.steps.find((s: { kind: string }) => s.kind === 'wait').onTimeout.action).toBe('escalate');
  await page.reload();
  const again = page.locator('[data-testid^="wait-settings-"]');
  await expect(again.getByLabel('Wait for', { exact: true })).toHaveValue('webhook');
  await expect(again.getByLabel('Wait at most')).toHaveValue('10');
  await expect(again.getByLabel('Unit')).toHaveValue('minutes');
  await expect(again.getByLabel('When time runs out')).toHaveValue('escalate');

  // the timeout action may also move to a named step
  await again.getByLabel('When time runs out').selectOption('goto');
  await expect(again.getByLabel('Step to move to')).toBeVisible();
  await again.getByLabel('Step to move to').selectOption('after');
  await saveJourneyInDesigner(page, () => page.getByRole('button', { name: 'Save', exact: true }).click());
  saved = (await (await api.get(`/api/journeys/${id}`)).json()).definition;
  expect(saved.steps.find((s: { kind: string }) => s.kind === 'wait').onTimeout).toEqual({
    action: 'goto',
    stepId: 'after',
  });
});

test('a timed wait shows its deadline on the instance and moves on with a visible line when it elapses', async () => {
  const id = await createJourney({
    name: 'Cooling off',
    recordType: 'client',
    firstStepId: 'cool',
    steps: [
      {
        kind: 'wait',
        id: 'cool',
        label: 'Cooling off',
        waitFor: { kind: 'duration' },
        duration: { amount: 10, unit: 'minutes' },
      },
      wf('next', 'Next'),
    ],
    handoffs: [{ id: 'h1', from: 'cool', on: 'done', to: 'next' }],
  });
  const inst = await start(id, 'Dan Duration');
  await tick();
  await instanceAt(inst, 'cool', 'waiting');
  const w = (await waitsOf(inst)).waits[0] as Wait;
  expect(w.kind).toBe('duration');
  expect(w.deadlineAt).toBeTruthy();

  await page.goto(`/journeys/instances/${inst}`);
  const card = page.getByTestId(`wait-${w.id}`);
  await expect(card).toBeVisible();
  await expect(card.getByText('Waiting', { exact: true })).toBeVisible();
  await expect(card.getByTestId('wait-deadline')).toContainText('Deadline');

  await advance(11 * MIN);
  await instanceAt(inst, 'next', 'open');
  const after = (await waitsOf(inst)).waits[0] as Wait;
  expect(after.status).toBe('resolved');
  expect(after.events.map((e) => e.text).join(' | ')).toContain('Ended: elapsed');
  await page.reload();
  await expect(card.getByTestId('wait-events')).toContainText('Ended: elapsed');
  await expect(card.getByTestId('wait-deadline')).toContainText('Deadline was');
});

test('timeouts: escalate asks the desk, remind sends a reminder then cancels, goto moves to the named step', async () => {
  // a webhook wait needs a resume hook of the journey; the hook is never called here, so the wait times out
  const id = await createJourney({
    name: 'Timeouts',
    recordType: 'client',
    firstStepId: 'start',
    steps: [wf('start', 'Start')],
    handoffs: [],
  });
  const hook = await api.post(`/api/journeys/${id}/hooks`, {
    data: { name: 'Docs received', purpose: 'resume', mapping: { externalId: '/id' } },
  });
  expect(hook.status(), await hook.text()).toBe(201);
  const triggerId = (await hook.json()).id as string;
  const waitStep = (onTimeout: Record<string, unknown>) => ({
    kind: 'wait',
    id: 'docs',
    label: 'Documents',
    waitFor: { kind: 'webhook', triggerId },
    duration: { amount: 10, unit: 'minutes' },
    onTimeout,
  });
  const def = (onTimeout: Record<string, unknown>) => ({
    name: 'Timeouts',
    recordType: 'client',
    firstStepId: 'docs',
    steps: [waitStep(onTimeout), wf('screening', 'Screening'), wf('chase', 'Chase the client')],
    handoffs: [{ id: 'h1', from: 'docs', on: 'done', to: 'screening' }],
  });

  // escalate: the wait is marked escalated, a line says so, and the desk has an item that can continue the journey
  await saveJourney(id, def({ action: 'escalate' }));
  const esc = await start(id, 'Eve Escalate', 'E-1');
  await tick();
  await instanceAt(esc, 'docs', 'waiting');
  await advance(11 * MIN);
  const escWait = await waitFor(
    'the wait to be escalated',
    async () => (await waitsOf(esc)).waits[0] as Wait,
    (w) => w?.status === 'escalated',
  );
  expect(escWait.events.map((e) => e.text)).toContain('Timed out: asked on the desk');
  expect((await openDeskItems(esc)).map((d) => d.subkind)).toEqual(['journey_wait_escalated']);
  await page.goto(`/journeys/instances/${esc}`);
  await expect(page.getByTestId(`wait-${escWait.id}`).getByText('Waiting: the desk was asked')).toBeVisible();
  await expect(page.getByTestId(`wait-${escWait.id}`).getByTestId('wait-events')).toContainText(
    'Timed out: asked on the desk',
  );
  await page.goto('/desk');
  await expect(page.getByTestId('journey-escalation-desk-item')).toBeVisible();
  await expect(page.getByText('"docs" for Eve Escalate timed out. What should happen?')).toBeVisible();
  // the desk buttons themselves are checked in the last test; continue from the instance page here
  await page.goto(`/journeys/instances/${esc}`);
  await page.getByTestId(`wait-${escWait.id}`).getByRole('button', { name: 'Continue now' }).click();
  await instanceAt(esc, 'screening', 'open');
  await waitFor(
    'no open desk item of the wait',
    () => openDeskItems(esc),
    (d) => d.length === 0,
  );

  // remind: one reminder, then (after the last) the journey is cancelled; each step leaves a line
  await saveJourney(id, def({ action: 'remind', maxReminders: 1, afterLast: 'cancel' }));
  const rem = await start(id, 'Rita Remind', 'R-1');
  await tick();
  await instanceAt(rem, 'docs', 'waiting');
  await advance(11 * MIN);
  const reminded = await waitFor(
    'a reminder',
    async () => (await waitsOf(rem)).waits[0] as Wait,
    (w) => w?.remindersSent === 1,
  );
  expect(reminded.status).toBe('open');
  expect(reminded.events.map((e) => e.text)).toContain('Reminder 1 of 1');
  await page.goto(`/journeys/instances/${rem}`);
  await expect(page.getByTestId(`wait-${reminded.id}`).getByTestId('wait-deadline')).toContainText(
    'Reminders 1 of 1',
  );
  await advance(11 * MIN);
  await waitFor(
    'the journey to be cancelled',
    () => getInstance(rem),
    (v) => v.status === 'cancelled',
  );
  const remDone = (await waitsOf(rem)).waits[0] as Wait;
  expect(remDone.status).not.toBe('open');
  expect(remDone.events.length).toBeGreaterThanOrEqual(2);

  // goto: the journey moves to the named step
  await saveJourney(id, def({ action: 'goto', stepId: 'chase' }));
  const gto = await start(id, 'Gus Goto', 'G-1');
  await tick();
  await instanceAt(gto, 'docs', 'waiting');
  await advance(11 * MIN);
  await instanceAt(gto, 'chase', 'open');
  const gtoWait = (await waitsOf(gto)).waits[0] as Wait;
  expect(gtoWait.status).not.toBe('open');
  expect(gtoWait.events.length).toBeGreaterThanOrEqual(1);

  // no wait of this journey ended without a line
  for (const inst of [esc, rem, gto])
    for (const w of (await waitsOf(inst)).waits)
      expect(w.events.length, `events of ${w.stepId}`).toBeGreaterThan(0);
});

const gateDef = (deadline?: Record<string, unknown>) => ({
  name: 'Approval',
  recordType: 'client',
  firstStepId: 'approval',
  steps: [
    {
      kind: 'gate',
      id: 'approval',
      label: 'Approval',
      approver: { kind: 'project_owner' },
      question: 'Approve this application?',
      ...(deadline ? { deadline } : {}),
    },
    wf('lease', 'Lease signed'),
    wf('declined', 'Declined letter'),
  ],
  handoffs: [
    { id: 'h1', from: 'approval', on: 'approved', to: 'lease' },
    { id: 'h2', from: 'approval', on: 'rejected', to: 'declined' },
  ],
});

test('a gate shows on the desk: approve follows the approved handoff, reject (with a note) the rejected one', async () => {
  const id = await createJourney(gateDef());
  const yes = await start(id, 'Amy Approve');
  const no = await start(id, 'Rob Reject');
  await tick();
  await instanceAt(yes, 'approval', 'waiting');
  await instanceAt(no, 'approval', 'waiting');
  expect((await openDeskItems(yes)).map((d) => d.subkind)).toEqual(['journey_gate']);

  // both gates show on the desk (the desk buttons are checked in the last test); approve from the instance page
  await page.goto('/desk');
  await expect(page.getByTestId('journey-gate-desk-item')).toHaveCount(2);
  await page.goto(`/journeys/instances/${yes}`);
  await page.getByTestId('instance-waits').getByRole('button', { name: 'Approve' }).click();
  await instanceAt(yes, 'lease', 'open');
  await waitFor(
    'the approve desk item to close',
    () => openDeskItems(yes),
    (d) => d.length === 0,
  );

  // reject on the instance page: the button waits for a note
  await page.goto(`/journeys/instances/${no}`);
  const panel = page.getByTestId('instance-waits');
  await expect(panel.getByRole('button', { name: 'Reject' })).toBeDisabled();
  await panel.getByLabel('Note (required to reject)').fill('Income too low');
  await panel.getByRole('button', { name: 'Reject' }).click();
  await instanceAt(no, 'declined', 'open');
  await waitFor(
    'the reject desk item to close',
    () => openDeskItems(no),
    (d) => d.length === 0,
  );
  const decided = (await waitsOf(no)).waits[0] as Wait;
  expect(decided.resolution).toBe('rejected');

  // a second decision is refused
  const again = await api.post(`/api/journey-gates/${decided.id}/decide`, { data: { decision: 'approved' } });
  expect(again.status()).toBe(409);
});

test('a gate whose deadline passed is escalated and can still be decided; no desk item stays open', async () => {
  const id = await createJourney(
    gateDef({ duration: { amount: 10, unit: 'minutes' }, onTimeout: { action: 'escalate' } }),
  );
  const inst = await start(id, 'Lou Late');
  await tick();
  await instanceAt(inst, 'approval', 'waiting');
  await advance(11 * MIN);
  const w = await waitFor(
    'the gate to be escalated',
    async () => (await waitsOf(inst)).waits[0] as Wait,
    (x) => x?.status === 'escalated',
  );
  expect(w.events.map((e) => e.text)).toContain('Timed out: asked on the desk');
  expect((await openDeskItems(inst)).length).toBeGreaterThanOrEqual(1);

  // the escalation is on the desk (a gate is never just continued); extend the deadline, then approve on the instance page
  await page.goto('/desk');
  const esc = page.getByTestId('journey-escalation-desk-item');
  await expect(esc).toHaveCount(1);
  const ext = await api.post(`/api/journey-waits/${w.id}/extend`, {
    data: { duration: { amount: 1, unit: 'days' } },
  });
  expect(ext.ok(), await ext.text()).toBeTruthy();
  await waitFor(
    'the deadline to be extended',
    async () => (await waitsOf(inst)).waits[0] as Wait,
    (x) => x.events.some((e) => e.text === 'Deadline extended'),
  );
  await page.goto(`/journeys/instances/${inst}`);
  await page.getByTestId('instance-waits').getByRole('button', { name: 'Approve' }).click();
  await instanceAt(inst, 'lease', 'open');
  await waitFor(
    'every desk item of the gate to close',
    () => openDeskItems(inst),
    (d) => d.length === 0,
  );
});

test('inbound webhook: a bad signature is refused with 401 and nothing of the payload is kept; a signed call starts a journey on a new and then a matched record', async () => {
  const id = await createJourney({
    name: 'From the website',
    recordType: 'client',
    firstStepId: 'lead',
    steps: [wf('lead', 'Lead')],
    handoffs: [],
  });

  // the hook is added in the designer; the address and the secret are shown once
  await page.goto(`/journeys/${id}`);
  await page.getByLabel('Name', { exact: true }).last().fill('Website enquiry');
  await page.getByLabel('What it does').selectOption('start');
  await page.getByLabel('Where the record id is in the message (for example /client/id)').fill('/client/id');
  await page.getByLabel('Where the name is (optional)').fill('/client/name');
  await page.getByRole('button', { name: 'Add a webhook', exact: true }).click();
  const url = ((await page.getByTestId('hook-url').textContent()) ?? '').replace(/^Address:\s*/, '').trim();
  const secret = ((await page.getByTestId('hook-secret').textContent()) ?? '')
    .replace(/^Secret:\s*/, '')
    .trim();
  expect(url).toMatch(/\/hooks\/in\/[A-Za-z0-9_-]{32}$/);
  expect(secret).toMatch(/^jhsec_/);
  const path = new URL(url).pathname;
  const [trigger] = await q<{ id: string; secret_enc: unknown }>(
    'SELECT id, secret_enc FROM journey_hook_triggers WHERE journey_id=$1',
    [id],
  );
  expect(JSON.stringify(trigger?.secret_enc)).not.toContain(secret);

  const marker = `PAYLOAD-MARKER-${Date.now()}`;
  const post = (body: string, sig: Record<string, string>) =>
    api.post(path, { headers: { 'content-type': 'application/json', ...sig }, data: Buffer.from(body) });
  // the server's clock may be pinned ahead of real time: the timestamp is checked against it
  const serverNow = Date.parse(
    (await (await api.post('/api/test/clock', { data: { advanceMs: 0 } })).json()).now,
  );
  const signAt = (body: string) => {
    const ts = String(Math.floor(serverNow / 1000));
    return {
      'x-guildwise-timestamp': ts,
      'x-guildwise-signature': `sha256=${createHmac('sha256', secret).update(`${ts}.`).update(body).digest('hex')}`,
    };
  };

  const bad = JSON.stringify({ client: { id: 'W-1', name: marker } });
  const refused = await post(bad, { ...signAt(bad), 'x-guildwise-signature': `sha256=${'0'.repeat(64)}` });
  expect(refused.status()).toBe(401);
  const unsigned = await post(bad, {});
  expect(unsigned.status()).toBe(401);
  const calls = await q<Record<string, unknown>>('SELECT * FROM journey_hook_calls WHERE trigger_id=$1', [
    trigger?.id,
  ]);
  expect(calls.length).toBe(2);
  expect(calls.every((c) => c.status === 401 && c.outcome === 'bad_signature')).toBe(true);
  expect(JSON.stringify(calls)).not.toContain(marker);
  expect(await q('SELECT id FROM journey_records WHERE external_id=$1', ['W-1'])).toHaveLength(0);
  // the refusal is logged without the payload
  const log = readFileSync(paths.serverLog, 'utf8');
  expect(log).toContain('hook refused');
  expect(log).not.toContain(marker);

  // a valid signature starts a journey on a new record
  const good = JSON.stringify({ client: { id: 'W-1', name: 'Wendy Web' }, notes: marker });
  const ok = await post(good, signAt(good));
  expect(ok.status(), await ok.text()).toBe(202);
  const first = await ok.json();
  expect(first.matched).toBe(false);
  const inst = await getInstance(first.instanceId);
  const [rec] = await q<{ display_name: string; external_id: string }>(
    'SELECT display_name, external_id FROM journey_records WHERE id=$1',
    [inst.record.id],
  );
  expect(rec).toEqual({ display_name: 'Wendy Web', external_id: 'W-1' });
  expect(
    JSON.stringify(await q('SELECT * FROM journey_hook_calls WHERE trigger_id=$1', [trigger?.id])),
  ).not.toContain(marker);
  expect(readFileSync(paths.serverLog, 'utf8')).not.toContain(marker);

  // while the record runs a journey, a second start is refused; after it ends, the same id matches the same record
  const busy = await post(good, signAt(good));
  expect(busy.status()).toBe(409);
  const cancel = await api.post(`/api/journey-instances/${first.instanceId}/cancel`);
  expect(cancel.ok(), await cancel.text()).toBeTruthy();
  const matched = await post(good, signAt(good));
  expect(matched.status(), await matched.text()).toBe(202);
  const second = await matched.json();
  expect(second.matched).toBe(true);
  expect(second.recordId).toBe(first.recordId);
  expect(second.instanceId).not.toBe(first.instanceId);
});

test('setup: a paired mock workstation sends outbound calls', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Office PC', HOME);
  startRunner({ NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }, HOME);
  const ws = await waitFor(
    'runner connected',
    async () =>
      (await (await api.get('/api/workstations')).json()).workstations as Array<{
        id: string;
        connected: boolean;
      }>,
    (w) => w[0]?.connected === true,
    30_000,
  );
  workstationId = ws[0]?.id as string;
});

const callDef = (path: string) => ({
  name: `Notify ${path}`,
  recordType: 'client',
  firstStepId: 'notify',
  steps: [
    {
      kind: 'webhook_call',
      id: 'notify',
      label: 'Tell the accounts system',
      workstationId,
      url: `${receiverUrl}${path}`,
      method: 'POST',
      headers: [{ name: 'X-Source', value: 'journeys' }],
      contentType: 'application/json',
      body: '{"name":"{record.name}","step":"{step.id}"}',
    },
    wf('invoiced', 'Invoice sent'),
    wf('manual', 'Do it by hand'),
  ],
  handoffs: [
    { id: 'h1', from: 'notify', on: 'done', to: 'invoiced' },
    { id: 'h2', from: 'notify', on: 'failed', to: 'manual' },
  ],
});

test('outbound webhook: a failed call is retried after the backoff, and the success shows on the instance', async () => {
  const id = await createJourney(callDef('/flaky'));
  const inst = await start(id, 'Fay Flaky');
  await tick();
  const failed = await waitFor(
    'the first try to fail',
    async () => (await waitsOf(inst)).calls[0] as Call,
    (c) => c?.attempts === 1 && c.status === 'pending',
  );
  expect(failed.lastHttpStatus).toBe(500);
  expect(failed.nextAttemptAt).toBeTruthy();
  await page.goto(`/journeys/instances/${inst}`);
  await expect(page.getByTestId(`call-${failed.id}`)).toContainText('last answer 500');
  await expect(page.getByTestId(`call-${failed.id}`)).toContainText('next try');

  // the retry is not sent before the backoff (1 minute) has passed
  await advance(30_000);
  await page.waitForTimeout(1_500);
  expect(((await waitsOf(inst)).calls[0] as Call).attempts).toBe(1);
  await advance(31_000);
  const done = await waitFor(
    'the retry to succeed',
    async () => (await waitsOf(inst)).calls[0] as Call,
    (c) => c?.status === 'ok',
  );
  expect(done.attempts).toBe(2);
  expect(done.lastHttpStatus).toBe(200);
  await instanceAt(inst, 'invoiced', 'open');
  const hits = received.filter((r) => r.path === '/flaky');
  expect(hits).toHaveLength(2);
  expect(JSON.parse(hits[1]?.body ?? '{}')).toEqual({ name: 'Fay Flaky', step: 'notify' });
  expect(hits[1]?.headers['x-source']).toBe('journeys');
  await page.reload();
  await expect(page.getByTestId(`call-${done.id}`).getByText('ok', { exact: true })).toBeVisible();
  await expect(page.getByTestId(`call-${done.id}`)).toContainText('2 attempts');
});

test('outbound webhook: a call that keeps failing ends as failed on the instance and follows the failed handoff', async () => {
  const id = await createJourney(callDef('/down'));
  const inst = await start(id, 'Dora Down');
  await tick();
  // backoff 1, 5, 30 and 120 minutes, then the call has failed for good (5 tries)
  for (const [n, wait] of [
    [1, 1],
    [2, 5],
    [3, 30],
    [4, 120],
  ] as const) {
    await waitFor(
      `try ${n} to fail`,
      async () => (await waitsOf(inst)).calls[0] as Call,
      (c) => c?.attempts === n && (c.status === 'pending' || c.status === 'failed'),
    );
    await advance(wait * MIN + 1_000);
  }
  const final = await waitFor(
    'the call to fail for good',
    async () => (await waitsOf(inst)).calls[0] as Call,
    (c) => c?.status === 'failed',
  );
  expect(final.attempts).toBe(5);
  expect(final.lastHttpStatus).toBe(503);
  expect(received.filter((r) => r.path === '/down')).toHaveLength(5);
  await instanceAt(inst, 'manual', 'open');
  await page.goto(`/journeys/instances/${inst}`);
  const card = page.getByTestId(`call-${final.id}`);
  await expect(card.getByText('failed', { exact: true })).toBeVisible();
  await expect(card).toContainText('5 attempts');
  await expect(card).toContainText('the address answered 503');
});

test('deleting a project with open waits does not stop the waits of another project', async () => {
  // a second project with an open wait that would time out together with the one below
  const other = await api.post('/api/projects', { data: { key: 'JWX', name: 'Throwaway' } });
  expect(other.status(), await other.text()).toBe(201);
  const otherId = (await other.json()).project.id as string;
  const otherWf = (
    await q<{ workflow_key: string }>(
      'SELECT workflow_key FROM project_workflows WHERE project_id=$1 AND is_primary',
      [otherId],
    )
  )[0]?.workflow_key as string;
  const cooling = (wfKey: string) => ({
    name: 'Cooling',
    recordType: 'client',
    firstStepId: 'cool',
    steps: [
      {
        kind: 'wait',
        id: 'cool',
        label: 'Cooling off',
        waitFor: { kind: 'duration' },
        duration: { amount: 10, unit: 'minutes' },
      },
      { kind: 'workflow', id: 'next', label: 'Next', workflowKey: wfKey },
    ],
    handoffs: [{ id: 'h1', from: 'cool', on: 'done', to: 'next' }],
  });
  const ghostJourney = await api.post('/api/journeys', {
    data: { projectId: otherId, definition: cooling(otherWf) },
  });
  expect(ghostJourney.status(), await ghostJourney.text()).toBe(201);
  const ghost = await api.post('/api/journey-instances', {
    data: { journeyId: (await ghostJourney.json()).id, record: { type: 'client', displayName: 'Ghost' } },
  });
  expect(ghost.status(), await ghost.text()).toBe(201);
  const ghostInst = (await ghost.json()).id as string;
  const live = await start(await createJourney(cooling(workflowKey)), 'Liv Live');
  await tick();
  await instanceAt(ghostInst, 'cool', 'waiting');
  await instanceAt(live, 'cool', 'waiting');

  // archive and delete do not cancel running journeys: the open wait of the deleted project must not hold up the others
  const arch = await api.post(`/api/projects/${otherId}/archive`);
  expect(arch.ok(), await arch.text()).toBeTruthy();
  const del = await api.post(`/api/projects/${otherId}/delete`, { data: { confirmKey: 'JWX' } });
  expect(del.ok(), await del.text()).toBeTruthy();
  await waitFor(
    'the deleted project to leave no waits',
    () => q('SELECT id FROM journey_waits WHERE project_id=$1', [otherId]),
    (r) => r.length === 0,
  );
  await advance(11 * MIN);
  await instanceAt(live, 'next', 'open');
});

test('the desk buttons of a gate and of an escalated wait act on the journey', async () => {
  // the desk list carries the wait the item belongs to, so its buttons can act on it
  const id = await createJourney(gateDef());
  const inst = await start(id, 'Desk Decider');
  await tick();
  await instanceAt(inst, 'approval', 'waiting');
  const gate = (await waitsOf(inst)).waits[0] as Wait;
  const desk = (await (await api.get('/api/desk')).json()) as {
    items: Array<{ subkind: string | null; data?: unknown }>;
  };
  const gateItems = desk.items.filter((i) => i.subkind === 'journey_gate');
  expect(gateItems, 'one open gate on the desk').toHaveLength(1);
  const item = gateItems[0];
  expect
    .soft(item?.data ?? null, 'the desk item of the gate carries its waitId and instanceId')
    .toMatchObject({
      waitId: gate.id,
      instanceId: inst,
    });

  await page.goto('/desk');
  const card = page.getByTestId('journey-gate-desk-item');
  await expect(card).toHaveCount(1);
  await expect.soft(card.getByRole('link', { name: 'Open the journey' })).toBeVisible({ timeout: 5_000 });
  await card.getByTestId('journey-gate-approve').click();
  await expect(page.getByText('request validation failed')).toHaveCount(0);
  await instanceAt(inst, 'lease', 'open');

  // an escalated gate offers extend and cancel on the desk, never "Continue the journey"
  const late = await start(
    await createJourney(
      gateDef({ duration: { amount: 10, unit: 'minutes' }, onTimeout: { action: 'escalate' } }),
    ),
    'Desk Late',
  );
  await tick();
  await instanceAt(late, 'approval', 'waiting');
  await advance(11 * MIN);
  await waitFor(
    'the gate to be escalated',
    async () => (await waitsOf(late)).waits[0] as Wait,
    (x) => x?.status === 'escalated',
  );
  await page.goto('/desk');
  const esc = page.getByTestId('journey-escalation-desk-item');
  await expect(esc).toHaveCount(1);
  await expect(esc.getByTestId('journey-wait-continue')).toHaveCount(0);
  await esc.getByTestId('journey-wait-extend').click();
  await expect(page.getByText('request validation failed')).toHaveCount(0);
  await waitFor(
    'the deadline to be extended from the desk',
    async () => (await waitsOf(late)).waits[0] as Wait,
    (x) => x.events.some((e) => e.text === 'Deadline extended'),
    10_000,
  );
});
