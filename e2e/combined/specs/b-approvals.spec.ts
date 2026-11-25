import { join } from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { q, waitFor } from '../../support/db.ts';
import { E2E_DIR } from '../../support/env.ts';
import { stepUp } from '../../support/step-up.ts';
import { makeRemote, type Remote } from '../fixtures/remotes.ts';
import { ApprovalsPage, type PageState } from '../support/approvals-page.ts';
import {
  advanceClock,
  deskItems,
  devopsAgentOf,
  newOwner,
  person,
  sendDevopsRequest,
  shiftsOfRequest,
  waitRequest,
} from '../support/flow.ts';
import { type Host, setBoxState, startHost } from '../support/host.ts';

// B1-B3: the runner's local approvals, with the owner's real setting "Ask me first" (devopsRequests: ask) and the
// website's Install switch OFF. The page, the held items and the blocked list are the product's own approvals page.
test.describe.configure({ mode: 'serial' });

const OWNER = person('b13owner');
let api: APIRequestContext;
let host: Host;
let page: ApprovalsPage;
let remote: Remote;
let workstationId = '';
let installReq = '';

test.afterAll(async () => {
  await host?.stop();
});

const TERMINAL = (s?: string) => s === 'done' || s === 'failed';
const devopsRequestRow = async (id: string) =>
  (
    await q<{ status: string; approval: { blockedBy?: string } | null }>(
      `SELECT status, approval FROM devops_requests WHERE id=$1`,
      [id],
    )
  )[0];
const waitingFor = async (
  what: (s: PageState['waiting'][number]) => boolean,
): Promise<PageState['waiting']> => (await page.state()).waiting.filter(what);

test('[B1] setup: Ask me first, Install off, a workstation with its DevOps engineer', async () => {
  api = await newOwner(OWNER);
  remote = makeRemote('approvals', { 'README.md': '# toy\n' });
  host = await startHost(api, {
    password: OWNER.password,
    name: 'b13-box',
    repoRoot: remote.repoRoot,
    policy: { devopsRequests: 'ask' },
  });
  page = new ApprovalsPage(host.approvalsPort, host.policyDir);
  workstationId = host.workstationId;
  const ws = (await (await api.get('/api/workstations')).json()).workstations[0];
  expect(ws.devopsAccess.allowInstall).toBe(false);
  await waitFor(
    'the page signs in',
    async () => (await page.state()).status.connected,
    (c) => c === true,
    30_000,
  );
});

// quiet-approvals (CHANGES.md "Every DevOps request ... starts in an inner box ... with no question asked"; devops-route.ts
// header): with a box that can start, a DevOps request no longer holds locally at all (D1 shows that). The one way a request
// still asks on this computer is a runtime WITHOUT a box (fail closed: one yes runs it outside). B1/B2's hold checks therefore run
// in that state; the new B1 test at the end of this file shows what Install-off looks like with the box available.
test('[B1] the box state of this runtime: none (every request is held for a local yes)', () => {
  setBoxState(host, 'none');
});

test('[B1] an install request with Install off: ONE local hold; when the server lets the shift lapse and sends it again the same hold is updated, not doubled', async () => {
  installReq = await sendDevopsRequest(api, workstationId, 'install the toy tools [scn:switchblock]');
  const held = await waitFor(
    'one held shift',
    () => waitingFor(() => true),
    (w) => w.length >= 1,
    60_000,
  );
  expect(held).toHaveLength(1);
  const first = (await shiftsOfRequest(installReq))[0] as string;
  expect(held[0]?.detail, 'the hold names its shift').toContain(first);
  // 10 minutes pass on the server's clock: a shift nobody started is released and the request is sent again (UAT finding 3
  // was the hold doubling on every resend). Wait until that really happened, then count.
  await advanceClock(10 * 60_000);
  await waitFor(
    'the request was sent again',
    () => shiftsOfRequest(installReq),
    (ids) => ids.length >= 2,
    120_000,
  );
  const latest = (await shiftsOfRequest(installReq)).slice(-1)[0] as string;
  const updated = await waitFor(
    'the one hold now names the newest shift',
    () => waitingFor(() => true),
    (w) => w.length === 1 && w[0]?.detail.includes(latest) === true,
    60_000,
  );
  expect(updated).toHaveLength(1);
  expect(await deskItemsOpenAbout('install the toy tools [scn:switchblock]')).toBeLessThanOrEqual(1);
});

test('[B1] approved locally, the run stops at the switch: one approvals-page entry, one Desk item, the request waits; turning Install on resumes it', async () => {
  const held = await waitingFor(() => true);
  expect(held).toHaveLength(1);
  expect((await page.approve(held[0]?.id as string)).status).toBe(200);
  await waitFor(
    'the request waits for the switch',
    () => devopsRequestRow(installReq),
    (r) => r?.status === 'needs_approval' && r.approval?.blockedBy === 'allowInstall',
    90_000,
  );
  const st = await page.state();
  expect(st.blocked.filter((b) => b.requestId === installReq)).toHaveLength(1);
  expect(st.blocked[0]?.switch).toBe('allowInstall');
  expect(st.waiting).toHaveLength(0);
  const switchItems = async () =>
    (await deskItems('devops')).filter(
      (d) => d.status === 'open' && /installs are off on this computer/.test(d.title),
    );
  expect(await switchItems()).toHaveLength(1);
  // it stays one while time passes: nothing is retried. A newer request is the sentinel that the dispatcher ran after the jump.
  const shiftsBefore = (await shiftsOfRequest(installReq)).length;
  await advanceClock(10 * 60_000);
  const sentinel = await sendDevopsRequest(api, workstationId, 'check memory');
  await waitFor(
    'the newer request is held',
    () => waitingFor(() => true),
    (w) => w.length === 1,
    90_000,
  );
  expect((await page.state()).blocked.filter((b) => b.requestId === installReq)).toHaveLength(1);
  expect(await switchItems()).toHaveLength(1);
  expect((await shiftsOfRequest(installReq)).length).toBe(shiftsBefore);
  await page.deny((await waitingFor(() => true))[0]?.id as string);
  await waitRequest(sentinel, 'refused', (r) => TERMINAL(r?.status), 60_000);
  // the owner turns Install on at the machine (the page's own switch): the request goes back in the queue by itself
  expect((await page.change({ action: 'devops.install', on: true })).status).toBe(200);
  const resumed = await waitFor(
    'a new shift of the same request is held, once',
    () => waitingFor(() => true),
    (w) => w.length === 1,
    90_000,
  );
  expect((await page.state()).blocked.filter((b) => b.requestId === installReq)).toHaveLength(0);
  expect((await page.approve(resumed[0]?.id as string)).status).toBe(200);
  const fin = await waitRequest(installReq, 'done', (r) => TERMINAL(r?.status), 120_000);
  expect(fin?.status).toBe('done');
  expect(await switchItems()).toHaveLength(0);
});

test('[B2] a local No ends the request: no retry, no second hold', async () => {
  const logsReq = await sendDevopsRequest(api, workstationId, 'look at the logs');
  const held = await waitFor(
    'the request is held',
    () => waitingFor(() => true),
    (w) => w.length === 1,
    90_000,
  );
  const shiftId = (await shiftsOfRequest(logsReq))[0] as string;
  expect(held[0]?.detail).toContain(shiftId);
  const r = await page.deny(held[0]?.id as string);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  // the observable end: the request failed, its shift was turned away
  const ended = await waitRequest(logsReq, 'ended', (x) => TERMINAL(x?.status), 60_000);
  expect(ended?.status).toBe('failed');
  expect(
    (await q<{ outcome: string }>(`SELECT outcome FROM shifts WHERE id=$1`, [shiftId]))[0]?.outcome,
  ).toBe('rejected');
  // time passes and the server could send it again: a newer request is the sentinel that the dispatcher ran after the jump
  await advanceClock(10 * 60_000);
  const sentinel = await sendDevopsRequest(api, workstationId, 'check the disk space');
  const next = await waitFor(
    'the newer request is held',
    () => waitingFor(() => true),
    (w) => w.length === 1,
    90_000,
  );
  expect(next[0]?.summary, 'the only hold is the newer request, not the refused one').toContain('disk space');
  expect((await shiftsOfRequest(logsReq)).length, 'shifts of the refused request').toBe(1);
  expect((await devopsRequestRow(logsReq))?.status).toBe('failed');
  await page.deny(next[0]?.id as string);
  await waitRequest(sentinel, 'refused', (x) => TERMINAL(x?.status), 60_000);
});

test('[B3] a vault.configure held for a new online location names its target (never an empty one)', async () => {
  const vaultOrigin = join(E2E_DIR, 'combined', 'b3-vault.git');
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '--bare', '-b', 'main', vaultOrigin], { stdio: 'ignore' });
  await stepUp(api, { password: OWNER.password });
  const res = await api.post('/api/vaults', {
    data: { kind: 'org', remoteUrl: vaultOrigin, syncIntervalSec: 2 },
  });
  expect(res.status(), await res.text()).toBe(201);
  const held = await waitFor(
    'the vault.configure is held',
    () => waitingFor((w) => w.kind === 'vault.configure'),
    (w) => w.length >= 1,
    60_000,
  );
  const one = held[0];
  expect(one?.summary).toMatch(/^vault\.configure for \d+ vaults? \(\S[^)]*\)/);
  expect(one?.summary).not.toMatch(/for\s+\(/);
  expect(one?.summary).toContain(vaultOrigin.split('/').pop()?.replace('.git', '') ?? 'b3-vault');
  expect(one?.detail).toContain('online location');
  // it is not what this test is about any more: say no so nothing is left waiting for the tests after it
  await page.deny(one?.id as string);
  // no secret in what the page shows
  expect(JSON.stringify(one)).not.toMatch(/password|secret|token/i);
});

/** Open Desk items whose text mentions `what` (the hold must not also show up as a second Desk item). */
const deskItemsOpenAbout = async (what: string): Promise<number> =>
  (await deskItems()).filter((d) => d.status === 'open' && (d.title.includes(what) || d.body.includes(what)))
    .length;

test('[B1] with the box available an install request asks ONCE to leave the box; then Install off shows as one approvals-page entry and one Desk item, and turning Install on resumes it', async () => {
  setBoxState(host, 'ok');
  expect((await page.change({ action: 'devops.install', on: false })).status).toBe(200);
  await waitFor(
    'the Install switch follows (off)',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].devopsAccess.allowInstall,
    (v) => v === false,
    60_000,
  );
  const req = await sendDevopsRequest(
    api,
    workstationId,
    'install the toy tools in the box [scn:switchblock]',
  );
  // inside the box an install is not possible: the engineer asks to work outside, which is ONE local yes ("Ask me first")
  const hold = await waitFor(
    'one hold to leave the box',
    () => waitingFor((w) => w.kind !== 'vault.configure'),
    (w) => w.length === 1,
    90_000,
  );
  expect(`${hold[0]?.summary} ${hold[0]?.detail}`).toMatch(/outside/i);
  expect((await page.approve(hold[0]?.id as string)).status).toBe(200);
  // outside, the guard refuses the install (switch off) and the request waits for the switch: no second hold
  await waitFor(
    'the request waits for the switch',
    () => devopsRequestRow(req),
    (r) => r?.status === 'needs_approval' && r.approval?.blockedBy === 'allowInstall',
    90_000,
  );
  const left = await waitingFor((w) => w.kind !== 'vault.configure');
  expect(left.length, JSON.stringify(left.map((w) => [w.kind, w.summary.slice(0, 100)]))).toBe(0);
  const st = await page.state();
  expect(st.blocked.filter((b) => b.requestId === req)).toHaveLength(1);
  const items = (await deskItems('devops')).filter(
    (d) => d.status === 'open' && /installs are off on this computer/.test(d.title),
  );
  expect(items).toHaveLength(1);
  // time passes: still one entry, one item, no retry
  const shiftsBefore = (await shiftsOfRequest(req)).length;
  await advanceClock(10 * 60_000);
  const newer = await sendDevopsRequest(api, workstationId, 'check memory in the box');
  expect((await waitRequest(newer, 'done', (r) => TERMINAL(r?.status), 120_000))?.status).toBe('done');
  expect((await page.state()).blocked.filter((b) => b.requestId === req)).toHaveLength(1);
  expect((await shiftsOfRequest(req)).length).toBe(shiftsBefore);
  // Install on from this machine's own page: the request goes back in the queue by itself (a yes for the changed job is asked
  // for if the runner needs one)
  expect((await page.change({ action: 'devops.install', on: true })).status).toBe(200);
  const deadline = Date.now() + 120_000;
  let status = '';
  while (Date.now() < deadline) {
    status = (await devopsRequestRow(req))?.status ?? '';
    if (TERMINAL(status)) break;
    for (const w of await waitingFor((w) => w.kind !== 'vault.configure')) await page.approve(w.id);
    await new Promise((r) => setTimeout(r, 400));
  }
  expect(status).toBe('done');
});
