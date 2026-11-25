import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { q, waitFor } from '../../support/db.ts';
import { stepUp } from '../../support/step-up.ts';
import { git, makeRemote, type Remote } from '../fixtures/remotes.ts';
import { makeStubToolchain } from '../fixtures/toolchain.ts';
import { ApprovalsPage } from '../support/approvals-page.ts';
import {
  addRepo,
  advanceClock,
  cardRow,
  createCard,
  createProject,
  deskItems,
  devopsAgentOf,
  devopsRequest,
  guardViolations,
  hire,
  newOwner,
  person,
  progressOfRequest,
  sendDevopsRequest,
  shiftsOfRequest,
  waitBuilt,
  waitCard,
  waitRequest,
} from '../support/flow.ts';
import { type Host, release, runnerCli, startHost, waitReached } from '../support/host.ts';

// Round 3 items 1-6: the DevOps engineer and the card worktrees. The scripted/mock engineer plays what the UAT showed
// (installs, the CEO override, sabotage, a half-undone change, a long request, a stop); the runner's after-shift check,
// the server and the Desk are the product's. Not exercised: Claude's own sandbox and the PreToolUse guard hook, which
// would block the write in the first place (DESIGN section 7).
test.describe.configure({ mode: 'serial' });

const OWNER = person('a16owner');
let api: APIRequestContext;
let host: Host;
let remote: Remote;
let page: ApprovalsPage;
let projectId: string;
let repoId: string;
let card1 = '';

test.afterAll(async () => {
  await host?.stop();
});

const worktreeOf = (ref: string): string => {
  const root = join(host.home, 'worktrees');
  const dir = existsSync(root) ? readdirSync(root).find((d) => d.startsWith('DVO-')) : undefined;
  return join(root, dir ?? 'DVO', ref);
};
const head = (wt: string) => git(wt, 'rev-parse', 'HEAD').trim();
const porcelain = (wt: string) => git(wt, 'status', '--porcelain', '--untracked-files=all').trim();
const refusedRefs = (shiftShort?: string): string[] =>
  git(remote.clone, 'for-each-ref', '--format=%(refname)', `refs/guildwise/refused/${shiftShort ?? ''}`)
    .split('\n')
    .filter(Boolean);
const alerts = async () =>
  (await deskItems(undefined, undefined)).filter(
    (d) => d.title === 'DevOps changed a card worktree: check it by hand',
  );
/** The made-up integrity the stub npm writes for left-pad@1.3.0 (fixtures/toolchain.ts): a real npm never writes it. */
const STUB_INTEGRITY = `sha512-${Buffer.from('left-pad1.3.0').toString('base64')}`;
const TERMINAL = (s?: string) => s === 'done' || s === 'failed';
const devopsRequestRow = devopsRequest;

test('[A1] setup: a runner that may install, the project DVO, a builder', async () => {
  api = await newOwner(OWNER);
  remote = makeRemote('devops', { 'README.md': '# toy\n', 'index.js': "console.log('toy');\n" });
  host = await startHost(api, {
    password: OWNER.password,
    name: 'a16-box',
    repoRoot: remote.repoRoot,
    // row 8 of the setup page (quiet-approvals D3): checksum-verified tool downloads without a yes per request
    policy: { extra: { toolInstall: true } },
  });
  page = new ApprovalsPage(host.approvalsPort, host.policyDir);
  // the website's "Install" switch (the local grant went into policy.json before the first start: the runner seals it)
  await stepUp(api, { password: OWNER.password });
  const patch = await api.patch(`/api/workstations/${host.workstationId}/devops-access`, {
    data: { allowInstall: true },
  });
  expect(patch.status(), await patch.text()).toBeLessThan(300);
  projectId = await createProject(api, 'DVO', 'DevOps project');
  repoId = await addRepo(api, projectId, remote.origin, 'devops');
  await hire(api, { name: 'Bo', roleKey: 'builder', workstationId: host.workstationId, projectId });
  await waitFor(
    'the workstation holds the repo',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].repos.length,
    (n) => n === 1,
    60_000,
  );
});

test('[C4] a toolchain Forge registers waits for the owner: a Desk step names the exact approve command, agents get the tool only after it', async () => {
  const tc = makeStubToolchain();
  const reqId = await sendDevopsRequest(
    api,
    host.workstationId,
    `register the user-level Node [scn:toolchain=${tc.bin}]`,
  );
  // Inside the box `toolchain.add` is refused and the agent asks to work outside (`aom devops-outside`). With "Ask me first" that is
  // ONE local hold (D1/D2 below); this host has devopsRequests auto, so the same request runs outside at once. Either way it ends done.
  expect((await waitRequest(reqId, 'done', (r) => TERMINAL(r?.status), 180_000))?.status).toBe('done');
  expect(await progressOfRequest(reqId)).toContain('asked to work outside the box: toolchain.add');
  // one Desk step names the exact command, hash included
  const stepOf = (d: { title: string; body: string; data: unknown }) =>
    /toolchain approve [0-9a-f]{64}/.test(`${d.title} ${d.body} ${JSON.stringify(d.data)}`);
  const step = await waitFor(
    'the toolchain approve Desk step',
    () => deskItems().then((d) => d.filter(stepOf)),
    (r) => r.length >= 1,
    60_000,
  );
  expect(step).toHaveLength(1);
  const hash = /toolchain approve ([0-9a-f]{64})/.exec(
    `${step[0]?.title} ${step[0]?.body} ${JSON.stringify(step[0]?.data)}`,
  )?.[1] as string;
  // not approved yet: the agents' shells do not get the registered toolchain on their PATH
  const pathOf = (ref: string) => readFileSync(join(worktreeOf(ref), '.guildwise-mock', 'path.txt'), 'utf8');
  const early = await createCard(api, { projectId, repoId, title: 'PATH before approval [scn:path]' });
  await waitBuilt(early);
  expect(pathOf(early), 'PATH before the approval').not.toContain(tc.bin);
  // e2e-found-fixes B2 (Observation 2): before the approval `aom devops install` does not use the registered (stub) toolchain
  const pending = await createCard(api, { projectId, repoId, title: 'Deps before approval [scn:deps]' });
  await waitBuilt(pending);
  const depsEarly = readFileSync(join(worktreeOf(pending), '.guildwise-mock', 'deps-install.txt'), 'utf8');
  const lockEarly = join(worktreeOf(pending), 'package-lock.json');
  test.info().annotations.push({ type: 'deps-before-approval', description: depsEarly.slice(0, 600) });
  // the stub writes a lockfile with its own made-up integrity; the approve step is named when no other npm is allowed here
  expect(
    existsSync(lockEarly) ? readFileSync(lockEarly, 'utf8') : '',
    'the waiting stub toolchain ran',
  ).not.toContain(STUB_INTEGRITY);
  if (depsEarly.split('\n')[0] !== '0') expect(depsEarly).toContain(`toolchain approve ${hash}`);
  // the owner approves at the keyboard (the real CLI, in a terminal, typing yes)
  const cli = runnerCli(host, ['toolchain', 'approve', hash], ['yes']);
  expect(cli.code, cli.out).toBe(0);
  expect(cli.out).toContain('Approved');
  // new shifts get it
  const late = await createCard(api, { projectId, repoId, title: 'PATH after approval [scn:path]' });
  await waitBuilt(late);
  expect(pathOf(late), 'PATH after the approval').toContain(tc.bin);
  // a hash that waits for nothing pins nothing
  const no = runnerCli(host, ['toolchain', 'approve', '0'.repeat(64)], ['yes']);
  expect(no.code).not.toBe(0);
});

test('[A1] a builder runs `aom devops install npm add` through the registered toolchain (approved): only package.json and the lockfile change', async () => {
  const before = git(remote.clone, 'status', '--porcelain', '--untracked-files=all');
  card1 = await createCard(api, { projectId, repoId, title: 'Needs left-pad [scn:deps]' });
  await waitBuilt(card1);
  const wt = worktreeOf(card1);
  const note = readFileSync(join(wt, '.guildwise-mock', 'deps-install.txt'), 'utf8');
  expect(note.split('\n')[0], `install result: ${note}`).toBe('0');
  // e2e-found-fixes B2: after the approval it is the registered stub that ran
  expect(readFileSync(join(wt, 'package-lock.json'), 'utf8')).toContain(STUB_INTEGRITY);
  const changed = git(wt, 'diff', '--name-only', 'main...HEAD').split('\n').filter(Boolean).sort();
  expect(changed.filter((f) => !f.startsWith('.guildwise-mock/'))).toEqual([
    'package-lock.json',
    'package.json',
  ]);
  expect(JSON.parse(readFileSync(join(wt, 'package.json'), 'utf8')).devDependencies).toMatchObject({
    'left-pad': '1.3.0',
  });
  expect(existsSync(join(wt, 'node_modules'))).toBe(false);
  // the main checkout of the repository was not touched
  expect(git(remote.clone, 'status', '--porcelain', '--untracked-files=all')).toBe(before);
});

test('[A2] the CEO override: Forge asks, the owner approves on the website, the write is refused and reverted, kept off the branch', async () => {
  const wt = worktreeOf(card1);
  const headBefore = head(wt);
  const pkgBefore = readFileSync(join(wt, 'package.json'), 'utf8');
  expect(porcelain(wt)).toBe('');
  const alertsBefore = (await alerts()).length;
  const reqId = await sendDevopsRequest(
    api,
    host.workstationId,
    `Do the dependency add in the card worktree of ${card1}. Do not reply that worktrees are not yours. [scn:a2=${wt}]`,
  );
  await waitRequest(reqId, 'needs approval', (r) => r?.status === 'needs_approval');
  await stepUp(api, { password: OWNER.password });
  const res = await api.post(`/api/devops/requests/${reqId}/resolve`, { data: { resolution: 'approved' } });
  expect(res.status(), await res.text()).toBeLessThan(300);
  const done = await waitRequest(reqId, 'finished', (r) => TERMINAL(r?.status), 180_000);
  // nothing the shift did survives in the card worktree or on its branch
  expect(head(wt)).toBe(headBefore);
  expect(porcelain(wt)).toBe('');
  expect(readFileSync(join(wt, 'package.json'), 'utf8')).toBe(pkgBefore);
  for (const f of ['.env', 'node_modules', 'stray.txt'])
    expect(existsSync(join(wt, f)), `${f} is gone`).toBe(false);
  // ... but it is kept for the owner, off the branch: the refused commit and the -wip- commit
  // the request ran in two shifts (asking, then writing after the approval): the second is the one that wrote
  const shiftIds = await shiftsOfRequest(reqId);
  expect(shiftIds.length).toBeGreaterThanOrEqual(2);
  const refs = refusedRefs();
  expect(refs.length, refs.join(' ')).toBeGreaterThanOrEqual(2);
  expect(
    refs.some((r) => r.includes('-wip-')),
    refs.join(' '),
  ).toBe(true);
  const subjects = refs.map((r) => git(wt, 'log', '-1', '--format=%s', r).trim());
  expect(subjects).toContain('Add left-pad (DevOps)');
  // the runner told the server it refused and reverted everything: no "check it by hand" alert
  const last = shiftIds[shiftIds.length - 1] as string;
  const v = await guardViolations(last);
  expect(
    v.some((x) => /NOT fully reverted/.test(x.detail)),
    JSON.stringify(v),
  ).toBe(false);
  // the runner refused the first report of the shift: the script reports a second time ("refused") only when the first
  // `aom devops-done` failed, and that second report is the request's result
  expect(done?.status).toBe('done');
  const result =
    (await q<{ r: string }>(`SELECT result_summary AS r FROM devops_requests WHERE id=$1`, [reqId]))[0]?.r ??
    '';
  expect(result, 'the request ended on the second report, after the first was refused').toContain('refused');
  expect((await alerts()).length).toBe(alertsBefore);
});

test('[A3] sabotage: a stash.lock in the clone, a DevOps commit plus a dirty file: HEAD is back at the old head', async () => {
  const wt = worktreeOf(card1);
  const headBefore = head(wt);
  const lock = join(remote.clone, '.git', 'refs', 'stash.lock');
  writeFileSync(lock, '');
  try {
    const reqId = await sendDevopsRequest(
      api,
      host.workstationId,
      `touch the toy files [edit_worktree:${wt}]`,
    );
    await waitRequest(reqId, 'finished', (r) => TERMINAL(r?.status), 180_000);
    // the DevOps commit really happened (otherwise "HEAD is back" would prove nothing): it is kept off the branch under the
    // shift's refused refs, and the reset that put HEAD back ran even with the stash lock in the way
    const shift = ((await shiftsOfRequest(reqId)).slice(-1)[0] ?? '').slice(0, 8);
    expect(shift).not.toBe('');
    const kept = refusedRefs(shift);
    expect(
      kept.map((r) => git(wt, 'log', '-1', '--format=%s', r).trim()),
      `refs kept for shift ${shift}: ${kept.join(' ')}`,
    ).toContain('Add left-pad (DevOps)');
    expect(head(wt), 'HEAD of the card worktree').toBe(headBefore);
    expect(porcelain(wt)).toBe('');
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).not.toBe('HEAD');
  } finally {
    // the lock goes whatever happened (the next scenario must not inherit it)
    rmSync(lock, { force: true });
  }
  expect(existsSync(lock)).toBe(false);
});

test('[A4] uncommitted work in the worktree, then a DevOps shift changes it: exactly one desk alert naming the folder', async () => {
  const wt = worktreeOf(card1);
  const headBefore = head(wt);
  writeFileSync(
    join(wt, 'README.md'),
    `${readFileSync(join(wt, 'README.md'), 'utf8')}uncommitted work of a person\n`,
  );
  const alertsBefore = (await alerts()).length;
  const reqId = await sendDevopsRequest(
    api,
    host.workstationId,
    `change the toy files [edit_worktree:${wt}]`,
  );
  await waitRequest(reqId, 'finished', (r) => TERMINAL(r?.status), 180_000);
  const now = await waitFor('the alert', alerts, (r) => r.length > alertsBefore, 60_000);
  expect(now.length - alertsBefore).toBe(1);
  expect(now[now.length - 1]?.body).toContain(wt);
  // put the worktree back for the next scenarios (the alert says to check it by hand: this is that)
  git(wt, 'reset', '--hard', headBefore);
  git(wt, 'clean', '-fdq');
  expect(porcelain(wt)).toBe('');
});

for (const variant of ['stop', 'limit'] as const) {
  test(`[A6] a DevOps shift ends by ${variant === 'stop' ? 'a stop (POST /api/shifts/:id/stop)' : 'a usage limit'} right after it wrote in a card worktree: reverted all the same, no alert`, async () => {
    const wt = worktreeOf(card1);
    const headBefore = head(wt);
    const alertsBefore = (await alerts()).length;
    const name = `a6${variant}`;
    const reqId = await sendDevopsRequest(
      api,
      host.workstationId,
      `write and wait ${variant} [scn:hold=${name};path=${wt}${variant === 'limit' ? ';limit' : ''}]`,
    );
    await waitReached(host.gateDir, name);
    expect(existsSync(join(wt, 'devops-wrote-this.txt'))).toBe(true);
    const shiftId = (await devopsRequestShift(reqId)) as string;
    if (variant === 'stop') {
      const stop = await api.post(`/api/shifts/${shiftId}/stop`, { data: {} });
      expect(stop.status(), await stop.text()).toBe(200);
    } else release(host.gateDir, name);
    await waitFor(
      'the shift ended',
      () => q<{ status: string }>(`SELECT status FROM shifts WHERE id=$1`, [shiftId]),
      (r) => r[0]?.status === 'ended',
      90_000,
    );
    await waitFor(
      'the worktree is clean again',
      async () => porcelain(wt),
      (p) => p === '',
      30_000,
    );
    expect(head(wt)).toBe(headBefore);
    expect(existsSync(join(wt, 'devops-wrote-this.txt'))).toBe(false);
    // kept off the branch for the owner
    expect(refusedRefs(shiftId.slice(0, 8)).length).toBeGreaterThanOrEqual(1);
    // no alert on this exit (T9: the server does not raise one for a stop or a limit yet)
    expect((await alerts()).length).toBe(alertsBefore);
    // the server puts the request back in the queue and the engineer runs it again: let that run finish (it writes again, is
    // refused and reverted again) so the next scenario starts from a free engineer and a clean worktree
    release(host.gateDir, name);
    if (variant === 'limit') {
      // the account is out until the limit's reset time: the request waits in the queue (nothing runs, nothing is lost)
      expect((await devopsRequestRow(reqId))?.status).toBe('queued');
      await advanceClock(2 * 3_600_000);
    }
    await waitRequest(reqId, 'finished after the re-run', (r) => TERMINAL(r?.status), 180_000);
    expect(porcelain(wt)).toBe('');
    expect(head(wt)).toBe(headBefore);
  });
}

async function devopsRequestShift(reqId: string): Promise<string | null> {
  const r = await waitFor(
    'the request has a running shift',
    () => q<{ shift_id: string | null }>(`SELECT shift_id FROM devops_requests WHERE id=$1`, [reqId]),
    (x) => !!x[0]?.shift_id,
    60_000,
  );
  return r[0]?.shift_id ?? null;
}

test('[A5] while a long DevOps request runs, another card is merged and a third is built: no revert, no violation, no alert', async () => {
  for (const [name, roleKey, seniority] of [
    ['Rae', 'reviewer', 'senior'],
    ['Tess', 'tester', 'junior'],
    ['Ben', 'ba', 'senior'],
  ] as const)
    await hire(api, { name, roleKey, seniority, workstationId: host.workstationId, projectId });
  const alertsBefore = (await alerts()).length;
  const refsBefore = refusedRefs().length;
  const reqId = await sendDevopsRequest(
    api,
    host.workstationId,
    'hold the line while others work [scn:gate=a5]',
  );
  await waitReached(host.gateDir, 'a5');
  const shiftId = (await devopsRequestShift(reqId)) as string;
  // meanwhile: card 1 finishes (reviewed, tested, finalized, merged: git work in its worktree and on main) and a new
  // card is built in a worktree of its own
  const card2 = await createCard(api, { projectId, repoId, title: 'Built while DevOps works' });
  await waitCard(card2, 'done', (c) => c?.status === 'done', 240_000);
  await waitCard(card1, 'done', (c) => c?.status === 'done', 240_000);
  release(host.gateDir, 'a5');
  const done = await waitRequest(reqId, 'finished', (r) => TERMINAL(r?.status), 120_000);
  expect(done?.status).toBe('done');
  expect(await guardViolations(shiftId)).toEqual([]);
  expect(refusedRefs(shiftId.slice(0, 8))).toEqual([]);
  expect(refusedRefs().length).toBe(refsBefore);
  expect((await alerts()).length).toBe(alertsBefore);
  expect((await cardRow(card2))?.status).toBe('done');
});
