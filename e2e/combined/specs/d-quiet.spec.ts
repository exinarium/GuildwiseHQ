import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { q, waitFor } from '../../support/db.ts';
import { E2E_DIR } from '../../support/env.ts';
import { stepUp } from '../../support/step-up.ts';
import { git, makeRemote, type Remote } from '../fixtures/remotes.ts';
import { ApprovalsPage } from '../support/approvals-page.ts';
import {
  addRepo,
  advanceClock,
  createProject,
  deskItems,
  devopsRequest,
  newOwner,
  person,
  progressOfRequest,
  sendDevopsRequest,
  shiftsOfRequest,
  waitRequest,
} from '../support/flow.ts';
import { type Host, release, setBoxState, startHost, waitReached } from '../support/host.ts';

// Group D: quiet-approvals on the combined build. The scripted runtime says whether its DevOps safety box can start
// (ScenarioAdapter.boxMissing), so the runner's real routing is driven: inside the box with no click, one yes per exact job,
// a changed job asks again, the box that cannot start, the local limit ("the most DevOps may get"), the tidy-up routine and
// the tool-download tick. The box itself (bwrap, the egress and model proxies, Docker through the gatekeeper) needs a real
// Claude on a real machine: those checks are owner/machine items (COMBINED-QA.md), and the unit/real tests of the runner
// (devops-box-real, quiet-approvals-*) cover their internals.
test.describe.configure({ mode: 'serial' });

const OWNER = person('d6owner');
let api: APIRequestContext;
let host: Host;
let remote: Remote;
let page: ApprovalsPage;
let projectId: string;
const TERMINAL = (s?: string) => s === 'done' || s === 'failed';
const scratch = join(E2E_DIR, 'combined', 'd-scratch');

test.afterAll(async () => {
  await host?.stop();
});

const waiting = async () => (await page.state()).waiting;
const hostLog = () =>
  readFileSync(host.logFile, 'utf8') + readFileSync(join(host.home, 'logs', 'runner.log'), 'utf8');

test('[D1] setup: "Ask me first", a runner whose box can start, the tidy-up routine ticked, the limit at its defaults but Docker', async () => {
  mkdirSync(scratch, { recursive: true });
  api = await newOwner(OWNER);
  remote = makeRemote('d-quiet', { 'README.md': '# toy\n' });
  host = await startHost(api, {
    password: OWNER.password,
    name: 'd6-box',
    repoRoot: remote.repoRoot,
    policy: {
      devopsRequests: 'ask',
      extra: {
        hygiene: 'run',
        // Docker is granted on this computer (setup) but the limit for Desk clicks starts without it: the limit is what is tested
        allowDocker: true,
        ceiling: { docker: false, mountRoots: [], containerEgress: false },
      },
    },
  });
  page = new ApprovalsPage(host.approvalsPort, host.policyDir);
  projectId = await createProject(api, 'DQA', 'Quiet approvals project');
  await addRepo(api, projectId, remote.origin, 'd-quiet');
  await waitFor(
    'the workstation holds the repo',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].repos.length,
    (n) => n === 1,
    60_000,
  );
  const st = await page.state();
  expect(st.allows.devopsRequests).toBe('ask');
  expect(st.allows.hygiene).toBe(true);
  expect(st.allows.ceiling).toMatchObject({ docker: false, mountRoots: [], containerEgress: false });
});

test('[D1] DevOps in the inner box needs no click: a request runs to done while nothing ever waits on this computer', async () => {
  const id = await sendDevopsRequest(api, host.workstationId, 'look at the disk space');
  let max = 0;
  const done = await waitFor(
    'the request ran',
    async () => {
      max = Math.max(max, (await waiting()).length);
      return devopsRequest(id);
    },
    (r) => TERMINAL(r?.status),
    120_000,
  );
  expect(done?.status).toBe('done');
  expect(max, 'items that waited on this computer').toBe(0);
  // and it really ran INSIDE the box: the runner handed the runtime the box input (no outside run, no unboxed run)
  const seen = readFileSync(join(host.gateDir, 'box-seen.log'), 'utf8');
  const shifts = await shiftsOfRequest(id);
  expect(shifts.length).toBeGreaterThan(0);
  for (const shift of shifts) expect(seen, `shift ${shift}`).toContain(`${shift} box=true`);
  expect(hostLog()).not.toContain('runs outside the box');
});

/** The DevOps shift a request currently has (running or starting), once it has one. */
const shiftNow = async (reqId: string): Promise<string> =>
  (
    await waitFor(
      'the request has a live shift',
      () =>
        q<{ id: string }>(
          `SELECT s.id FROM shifts s WHERE s.kind='devops' AND s.status<>'ended' AND s.id::text = ANY(
             SELECT payload->>'shiftId' FROM events WHERE type='DevOpsShiftDispatched' AND payload->>'requestId'=$1)`,
          [reqId],
        ),
      (r) => r.length === 1,
      90_000,
    )
  )[0]?.id as string;

test('[D3] a changed job asks again, a local No ends it, and a stale yes is refused', async () => {
  setBoxState(host, 'none');
  // the same request, but the website switches changed between the two dispatches: not the job that was approved
  const req = await sendDevopsRequest(
    api,
    host.workstationId,
    `inspect the logs too [scn:hold=d3;path=${scratch}]`,
  );
  const held = await waitFor('the first hold', waiting, (w) => w.length === 1, 90_000);
  expect(held[0]?.detail, 'the first hold shows installs off').toMatch(/installs\s+no/i);
  expect((await page.approve(held[0]?.id as string)).status).toBe(200);
  await waitReached(host.gateDir, 'd3');
  const shift1 = await shiftNow(req);
  await stepUp(api, { password: OWNER.password });
  expect(
    (
      await api.patch(`/api/workstations/${host.workstationId}/devops-access`, {
        data: { allowInstall: true },
      })
    ).status(),
  ).toBeLessThan(300);
  expect((await api.post(`/api/shifts/${shift1}/stop`, { data: {} })).status()).toBe(200);
  const again = await waitFor('a new hold for the changed job', waiting, (w) => w.length === 1, 120_000);
  release(host.gateDir, 'd3');
  // the new hold names what changed (the control below shows the same re-dispatch WITHOUT a change is not held)
  expect(again[0]?.detail, 'the second hold shows installs on').toMatch(/installs\s+yes/i);
  // a stale version is refused and the item still waits
  const stale = await page.approve(again[0]?.id as string, 'f'.repeat(64));
  expect(stale.status, JSON.stringify(stale.json)).toBe(409);
  expect((await waiting()).length, 'the item still waits after a stale yes').toBe(1);
  // a local No ends the request: no retry, no second hold
  const r = await page.deny(again[0]?.id as string);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect((await waitRequest(req, 'refused', (x) => TERMINAL(x?.status), 60_000))?.status).toBe('failed');
  const shifts = (await shiftsOfRequest(req)).length;
  await advanceClock(10 * 60_000);
  const sentinel = await sendDevopsRequest(api, host.workstationId, 'look at the load');
  const next = await waitFor('the newer request is the only hold', waiting, (w) => w.length === 1, 90_000);
  expect(next[0]?.summary).not.toBe(again[0]?.summary);
  expect((await shiftsOfRequest(req)).length, 'shifts of the refused request').toBe(shifts);
  await page.deny(next[0]?.id as string);
  await waitRequest(sentinel, 'refused', (x) => TERMINAL(x?.status), 60_000);
  expect(
    (
      await api.patch(`/api/workstations/${host.workstationId}/devops-access`, {
        data: { allowInstall: false },
      })
    ).status(),
  ).toBeLessThan(300);
});

test('[D6] when the box cannot start the shift is refused with a plain reason and one `devops.box` step on the Desk; once it can, the same request goes through', async () => {
  setBoxState(host, 'broken:bubblewrap 0.7 is too old (test)');
  const id = await sendDevopsRequest(api, host.workstationId, 'check the memory');
  const step = await waitFor(
    'the devops.box Desk step',
    () =>
      deskItems().then((d) =>
        d.filter((x) => /DevOps cannot work on this computer yet/.test(`${x.title} ${x.body}`)),
      ),
    (r) => r.length >= 1,
    90_000,
  );
  expect(step.length, 'one step, not one per attempt').toBe(1);
  expect(`${step[0]?.title} ${step[0]?.body}`).toContain('bubblewrap 0.7 is too old (test)');
  // the shift was turned away with the reason (nothing ran), the request waits in the queue, and nothing waits for a yes
  await waitFor(
    'the shift was refused',
    async () => {
      const ids = await shiftsOfRequest(id);
      return q<{ outcome: string | null }>(`SELECT outcome FROM shifts WHERE id = ANY($1::uuid[])`, [ids]);
    },
    (r) => r.some((x) => x.outcome === 'rejected'),
    90_000,
  );
  expect(hostLog()).toContain('DevOps cannot work on this computer yet: bubblewrap 0.7 is too old (test)');
  expect((await devopsRequest(id))?.status).not.toBe('done');
  expect((await waiting()).length).toBe(0);
  // the server sends it again after its back-off: refused again, and still ONE step on the Desk
  await advanceClock(10 * 60_000);
  await waitFor(
    'a second attempt was refused too',
    async () => {
      const ids = await shiftsOfRequest(id);
      return q<{ n: number }>(
        `SELECT count(*)::int AS n FROM shifts WHERE id = ANY($1::uuid[]) AND outcome='rejected'`,
        [ids],
      );
    },
    (r) => (r[0]?.n ?? 0) >= 2,
    120_000,
  );
  const stepsAfter = (await deskItems()).filter((x) =>
    /DevOps cannot work on this computer yet/.test(`${x.title} ${x.body}`),
  );
  expect(stepsAfter.length, 'one step, not one per attempt').toBe(1);
  // fixed: the same request runs by itself once the server sends it again
  setBoxState(host, 'ok');
  await advanceClock(10 * 60_000);
  expect((await waitRequest(id, 'done', (r) => TERMINAL(r?.status), 180_000))?.status).toBe('done');
});

test('[D5] the local limit caps every Desk grant: Docker and a folder above it are not given, the page refuses private folders, and raising the limit locally gives Docker', async () => {
  await stepUp(api, { password: OWNER.password });
  const extra = join(E2E_DIR, 'combined', 'extra-folder');
  const patch = await api.patch(`/api/workstations/${host.workstationId}/devops-access`, {
    data: { allowDocker: true, allowedPaths: [extra] },
  });
  expect(patch.status(), await patch.text()).toBeLessThan(300);
  const id = await sendDevopsRequest(api, host.workstationId, 'report what you were given [scn:access]');
  await waitRequest(id, 'done', (r) => TERMINAL(r?.status), 120_000);
  const said = await progressOfRequest(id);
  const given = JSON.parse(/scn: access (\{.*\})/.exec(said)?.[1] ?? 'null');
  expect(given, said).toMatchObject({ allowDocker: false, allowedPaths: [] });
  // the owner is told, once, on the Desk
  const stepItems = await waitFor(
    'the ceiling step',
    () =>
      deskItems().then((d) =>
        d.filter((x) => /above the limit set on this computer/.test(`${x.title} ${x.body}`)),
      ),
    (r) => r.length >= 1,
    60_000,
  );
  expect(`${stepItems[0]?.title} ${stepItems[0]?.body}`).toMatch(/Docker/);
  // the page refuses the owner's private folders and the runner's own folder as extra folders
  const home = join(E2E_DIR, 'home-d6-box');
  for (const bad of [home, host.home, host.policyDir]) {
    const r = await page.change({
      action: 'ceiling.set',
      docker: false,
      containerEgress: false,
      mountRoots: [bad],
    });
    expect(r.status, `${bad}: ${JSON.stringify(r.json)}`).toBe(400);
    expect(JSON.stringify(r.json)).toMatch(/cannot be given to DevOps/);
  }
  expect((await page.state()).allows.ceiling.mountRoots).toEqual([]);
  // raising the limit for Docker (a local click) lets the same Desk switch through
  expect(
    (await page.change({ action: 'ceiling.set', docker: true, containerEgress: false, mountRoots: [] }))
      .status,
  ).toBe(200);
  const id2 = await sendDevopsRequest(api, host.workstationId, 'report what you were given now [scn:access]');
  await waitRequest(id2, 'done', (r) => TERMINAL(r?.status), 120_000);
  const said2 = await progressOfRequest(id2);
  expect(JSON.parse(/scn: access (\{.*\})/.exec(said2)?.[1] ?? 'null'), said2).toMatchObject({
    allowDocker: true,
  });
});

test('[C1] [D4] the tidy-up is a fixed routine: it runs with no question and it never deletes main, develop, a release branch or a branch this computer did not push', async () => {
  // branches on the git host that are merged into main (so a naive tidy-up would take them)
  for (const b of ['develop', 'release/1.0', 'merged-by-someone']) {
    git(remote.other, 'checkout', '-q', '-B', b, 'main');
    git(remote.other, 'push', '-q', '-f', 'origin', b);
  }
  git(remote.other, 'checkout', '-q', 'main');
  const before = git(remote.origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter(Boolean)
    .sort();
  expect(before).toEqual(expect.arrayContaining(['main', 'develop', 'release/1.0', 'merged-by-someone']));
  await stepUp(api, { password: OWNER.password });
  const ran = await api.post(`/api/workstations/${host.workstationId}/hygiene/run`, { data: {} });
  expect(ran.status(), await ran.text()).toBeLessThan(300);
  const req = await waitFor(
    'the hygiene request',
    () =>
      q<{ id: string; status: string }>(
        `SELECT id, status FROM devops_requests WHERE hygiene IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      ),
    (r) => r.length === 1 && TERMINAL(r[0]?.status),
    120_000,
  );
  expect(req[0]?.status).toBe('done');
  const said =
    (
      await q<{ r: string | null }>(`SELECT result_summary AS r FROM devops_requests WHERE id=$1`, [
        req[0]?.id,
      ])
    )[0]?.r ?? '';
  // the routine really looked at the repository (its local path is known to the runner) and said so: not a run that did nothing.
  // The server named no finished branch here, so the protected-branch REFUSAL (a server naming develop) stays a unit-test item.
  expect(said).toMatch(/1 repository checked/);
  expect(said).toMatch(/DQA d-quiet: fetched origin/);
  expect((await waiting()).length, 'a tick on the tidy-up row means no question').toBe(0);
  const after = git(remote.origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter(Boolean)
    .sort();
  expect(after, 'no branch on the git host was deleted').toEqual(before);
  // with the row unticked the same request asks once
  expect((await page.change({ action: 'devops.hygiene', mode: 'ask' })).status).toBe(200);
  await advanceClock(60_000);
  const again = await api.post(`/api/workstations/${host.workstationId}/hygiene/run`, { data: {} });
  expect(again.status(), await again.text()).toBeLessThan(300);
  const held = await waitFor('the tidy-up asks', waiting, (w) => w.length === 1, 90_000);
  expect(held[0]?.summary).toMatch(/Tidy the code folders/);
  await page.deny(held[0]?.id as string);
});

/** The environment prepares of THIS project (other specs of the run prepare theirs in the same database). */
const prepared = async (): Promise<number> =>
  (
    await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM events WHERE type='EnvironmentPrepared' AND payload->>'projectId'=$1`,
      [projectId],
    )
  )[0]?.n ?? 0;

test('[D7] the tool-download tick (row 8): without it an environment prepare with installs waits for one yes, with it nothing asks', async () => {
  // count this project's prepares from here: its repo's own earlier prepares (the clone queued one) are in the number already
  const base = await prepared();
  // the earlier test left a folder on the website's paths switch: a request for extra paths always asks, so clear it first
  await stepUp(api, { password: OWNER.password });
  expect(
    (
      await api.patch(`/api/workstations/${host.workstationId}/devops-access`, {
        data: { allowedPaths: [], allowDocker: false },
      })
    ).status(),
  ).toBeLessThan(300);
  // Install on from the machine's own page (the website switch follows), then a fresh environment check
  expect((await page.change({ action: 'devops.install', on: true })).status).toBe(200);
  await waitFor(
    'the Install switch follows',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].devopsAccess.allowInstall,
    (v) => v === true,
    60_000,
  );
  expect((await page.state()).allows.toolInstall).toBe(false);
  expect(
    (await api.post(`/api/projects/${projectId}/environment/check`, { data: {} })).status(),
  ).toBeLessThan(300);
  const held = await waitFor(
    'the environment prepare asks',
    waiting,
    (w) => w.some((x) => x.kind === 'env.ensure'),
    90_000,
  );
  const mine = held.find((x) => x.kind === 'env.ensure');
  expect(mine?.summary).toMatch(/with installs/);
  expect((await page.approve(mine?.id as string)).status).toBe(200);
  // tick row 8; then a DIFFERENT prepare (Docker on, so not the job that was approved: the exact-job memory cannot silence it)
  expect((await page.change({ action: 'devops.toolInstall', on: true })).status).toBe(200);
  expect((await page.state()).allows.toolInstall).toBe(true);
  // the APPROVED prepare finished: one more than at the start
  await waitFor('the approved prepare finished', prepared, (n) => n >= base + 1, 90_000);
  expect(
    (
      await api.patch(`/api/workstations/${host.workstationId}/devops-access`, {
        data: { allowDocker: true },
      })
    ).status(),
  ).toBeLessThan(300);
  expect(
    (await api.post(`/api/projects/${projectId}/environment/check`, { data: {} })).status(),
  ).toBeLessThan(300);
  // the second prepare RAN (a second new EnvironmentPrepared after the approved one) and nothing asked on the way
  let asked = false;
  await waitFor(
    'the second prepare ran',
    async () => {
      if ((await waiting()).some((x) => x.kind === 'env.ensure')) asked = true;
      return prepared();
    },
    // the second prepare is the one after the approved one: if it were held this never gets there
    (n) => n >= base + 2,
    90_000,
  );
  expect(asked, 'an environment prepare asked although row 8 is ticked').toBe(false);
});

/** What changed between two dispatches of the same job (flat paths), read from the held items the runner keeps. */
const heldBodyOf = (id: string): Record<string, unknown> => {
  const raw = JSON.parse(readFileSync(join(host.policyDir, 'held', `${id}.json`), 'utf8')) as Record<
    string,
    any
  >;
  return (raw.record?.replay?.body ?? raw.replay?.body ?? raw.body?.replay?.body ?? raw) as Record<
    string,
    unknown
  >;
};
const flat = (o: unknown, p = ''): Record<string, string> => {
  if (o && typeof o === 'object')
    return Object.assign({}, ...Object.entries(o as object).map(([k, v]) => flat(v, `${p}/${k}`)));
  return { [p]: JSON.stringify(o) };
};
const diffBodies = (a: Record<string, unknown>, b: Record<string, unknown>): string[] => {
  const x = flat(a);
  const y = flat(b);
  return [...new Set([...Object.keys(x), ...Object.keys(y)])]
    .filter((k) => x[k] !== y[k] && !/^\/(shiftId|claimId|queuedAt|dispatchedAt|id|ts)$/.test(k))
    .map((k) => `${k}: ${String(x[k]).slice(0, 60)} -> ${String(y[k]).slice(0, 60)}`);
};

// Last on purpose: if the runner asks again for the same job it leaves the DevOps engineer waiting at its gate, and nothing after it
// may depend on that (the finding is then reported in BUILD.md, not hidden).
test('[D2] after one yes, the owner sends the identical request again (a new request with the same text): it runs outside without asking (QA "Same job again")', async () => {
  setBoxState(host, 'none');
  const text = 'inspect the toy folders and report';
  const first = await sendDevopsRequest(api, host.workstationId, text);
  const held = await waitFor('one hold', waiting, (w) => w.length === 1, 90_000);
  const body1 = heldBodyOf(held[0]?.id as string);
  expect((await page.approve(held[0]?.id as string)).status).toBe(200);
  expect((await waitRequest(first, 'done', (r) => TERMINAL(r?.status), 120_000))?.status).toBe('done');
  const again = await sendDevopsRequest(api, host.workstationId, text);
  const seen = await waitFor(
    'the identical request ran or was held',
    async () => ({ w: await waiting(), req: await devopsRequest(again) }),
    (r) => r.w.length > 0 || TERMINAL(r.req?.status),
    90_000,
  );
  if (seen.w.length > 0) {
    test.info().annotations.push({
      type: 'defect-candidate',
      description: `the identical request (new request, same text) was held again; differences in the shift.start body: ${diffBodies(body1, heldBodyOf(seen.w[0]?.id as string)).join(' | ')}`,
    });
    await page.deny(seen.w[0]?.id as string);
  }
  expect(seen.w.length, 'holds for the identical request').toBe(0);
});

test('[D2] with no box on this runtime the request is held ONCE; the yes covers that exact job: when the server sends the same job again it runs outside with no new yes', async () => {
  setBoxState(host, 'none');
  const first = await sendDevopsRequest(
    api,
    host.workstationId,
    'inspect the toy folders and report [scn:gate=d2]',
  );
  const held = await waitFor('one hold', waiting, (w) => w.length === 1, 90_000);
  expect(`${held[0]?.summary} ${held[0]?.detail}`).toMatch(/outside/i);
  const body1 = heldBodyOf(held[0]?.id as string);
  expect((await page.approve(held[0]?.id as string)).status).toBe(200);
  await waitReached(host.gateDir, 'd2');
  // 10 minutes pass: the server lets that shift lapse and sends the SAME job again (new shift and claim ids)
  await advanceClock(10 * 60_000);
  await waitFor(
    'the same job was sent again',
    async () => (await shiftsOfRequest(first)).length,
    (n) => n >= 2,
    120_000,
  );
  // give the runner the moment it needs to either start it or hold it
  const again = await waitFor(
    'the runner started it or held it',
    async () => ({ w: await waiting(), shifts: (await shiftsOfRequest(first)).length }),
    (r) => r.w.length > 0 || hostLog().includes('runs outside the box: the exact job approved'),
    60_000,
  );
  if (again.w.length > 0) {
    const body2 = heldBodyOf(again.w[0]?.id as string);
    test.info().annotations.push({
      type: 'defect-candidate',
      description: `the same request sent again was held again; differences in the shift.start body: ${diffBodies(body1, body2).join(' | ') || '(none outside the dispatch ids)'}`,
    });
  }
  expect(again.w.length, 'holds for the same job sent again').toBe(0);
  expect(hostLog()).toContain('runs outside the box: the exact job approved on this computer');
  release(host.gateDir, 'd2');
  expect((await waitRequest(first, 'done', (r) => TERMINAL(r?.status), 120_000))?.status).toBe('done');
});
