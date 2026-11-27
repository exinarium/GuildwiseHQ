import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { q, waitFor } from '../../support/db.ts';
import { git, makeRemote, type Remote } from '../fixtures/remotes.ts';
import { ApprovalsPage } from '../support/approvals-page.ts';
import {
  addRepo,
  advanceClock,
  createCard,
  createProject,
  devopsRequest,
  hire,
  newOwner,
  person,
  progressOfRequest,
  sendDevopsRequest,
  shiftsOfRequest,
  waitBuilt,
  waitRequest,
} from '../support/flow.ts';
import { type Host, restartHost, runnerCli, setBoxState, startHost, stopHost } from '../support/host.ts';

// Group C: runner-authority-fixes wiring on the combined build (AC3, AC9, AC12; AC4 is in a-devops.spec.ts next to A1).
// The scripted DevOps engineer drives the real runner paths: the real `aom devops-guard` hook command (its classifier and the
// audit call to the runner), the card-folder fence, and the real `guildwise-runner` CLI for the sealed policy.
test.describe.configure({ mode: 'serial' });

const OWNER = person('c3owner');
let api: APIRequestContext;
let host: Host;
let remote: Remote;
let page: ApprovalsPage;
let projectId: string;
let repoId: string;
let card = '';
const TERMINAL = (s?: string) => s === 'done' || s === 'failed';

test.afterAll(async () => {
  await host?.stop();
});

const worktreeOf = (ref: string): string => {
  const root = join(host.home, 'worktrees');
  const dir = existsSync(root) ? readdirSync(root).find((d) => d.startsWith('CAU-')) : undefined;
  return join(root, dir ?? 'CAU', ref);
};
const guardResults = (name: 'on' | 'off') =>
  JSON.parse(readFileSync(join(host.gateDir, `guard-${name}.json`), 'utf8')) as Array<{
    command: string;
    decision: 'allowed' | 'denied';
    rule: string | null;
  }>;

test('[C12] setup: a runner with a local grant, a project, one built card that waits in review', async () => {
  api = await newOwner(OWNER);
  remote = makeRemote('c-authority', { 'README.md': '# toy\n', 'index.js': "console.log('toy');\n" });
  host = await startHost(api, { password: OWNER.password, name: 'c3-box', repoRoot: remote.repoRoot });
  page = new ApprovalsPage(host.approvalsPort, host.policyDir);
  projectId = await createProject(api, 'CAU', 'Authority project');
  repoId = await addRepo(api, projectId, remote.origin, 'c-authority');
  await hire(api, { name: 'Bo', roleKey: 'builder', workstationId: host.workstationId, projectId });
  await waitFor(
    'the workstation holds the repo',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].repos.length,
    (n) => n === 1,
    60_000,
  );
  card = await createCard(api, { projectId, repoId, title: 'Card to guard' });
  await waitBuilt(card);
});

test('[C12] the runner guard (the real hook command, given a test-built config) refuses installs, Docker, outside folders, the policy folder and card worktrees by rule; the Install and Docker switches lift only their own rules', async () => {
  const wt = worktreeOf(card);
  // runner-bare-bin (S4): run in the OUTER box (a runtime with no inner box: the request goes outside), where the runner has the
  // guard configuration it judges a refusal with; the in-box hook's own report is untrusted there
  setBoxState(host, 'none');
  // with no box the request waits for one local yes, given on the approvals page
  const yesOutside = async () => {
    const held = await waitFor(
      'the outside run waits for a yes',
      async () => (await page.state()).waiting,
      (w) => w.length === 1,
      90_000,
    );
    expect((await page.approve(held[0]?.id as string)).status).toBe(200);
  };
  // switches off
  const offId = await sendDevopsRequest(api, host.workstationId, `probe the guard [scn:guard;path=${wt}]`);
  await yesOutside();
  await waitRequest(offId, 'finished', (r) => TERMINAL(r?.status), 180_000);
  const off = guardResults('off');
  const rule = (needle: string) => off.find((r) => r.command.includes(needle));
  const exact = (cmd: string) => off.find((r) => r.command === cmd);
  expect(rule('pipx install')).toMatchObject({ decision: 'denied', rule: 'install_off' });
  expect(rule('docker run')).toMatchObject({ decision: 'denied', rule: 'docker_off' });
  expect(rule('/etc/combined-probe')?.decision).toBe('denied');
  expect(rule('policy.json')).toMatchObject({ decision: 'denied', rule: 'policy_fence' });
  expect(rule('guildwise-runner approve')).toMatchObject({ decision: 'denied', rule: 'policy_fence' });
  expect(rule('commit --allow-empty')).toMatchObject({ decision: 'denied', rule: 'card_worktree' });
  expect(exact('ls')?.decision, 'a harmless read is allowed').toBe('allowed');
  // the shell's audit reached the runner (the hook's report call), and the refused `pipx install` is in the audit. runner-bare-bin
  // (S4): the hook runs in the box, so its own entries are stored as untrusted and its refusal is not taken; the refusal on
  // record is the runner's own verdict of that command (`runner:install_off`), the trusted record
  const audit = readFileSync(join(host.home, 'logs', 'devops-audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { rule: string; decision: string; command: string });
  expect(audit).toContainEqual(
    expect.objectContaining({
      decision: 'refused',
      rule: 'runner:install_off',
      command: 'pipx install yt-dlp',
    }),
  );
  expect(audit.some((e) => e.command === 'ls' && e.rule.startsWith('untrusted:'))).toBe(true);
  // switches ON (Install and Docker): those two commands pass, the fences stay
  const onId = await sendDevopsRequest(
    api,
    host.workstationId,
    `probe the guard again [scn:guard;path=${wt};on]`,
  );
  await yesOutside();
  await waitRequest(onId, 'finished', (r) => TERMINAL(r?.status), 180_000);
  const on = guardResults('on');
  const ruleOn = (needle: string) => on.find((r) => r.command.includes(needle));
  expect(ruleOn('pipx install')?.decision).toBe('allowed');
  expect(ruleOn('docker run')?.decision).toBe('allowed');
  expect(ruleOn('policy.json')).toMatchObject({ decision: 'denied', rule: 'policy_fence' });
  expect(ruleOn('guildwise-runner approve')).toMatchObject({ decision: 'denied', rule: 'policy_fence' });
  expect(ruleOn('commit --allow-empty')).toMatchObject({ decision: 'denied', rule: 'card_worktree' });
  setBoxState(host, 'ok');
});

test('[C9] a DevOps shift that moves a card branch (update-ref in the clone) is put back and kept off the branch', async () => {
  const wt = worktreeOf(card);
  const branch = git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const before = git(remote.clone, 'rev-parse', `refs/heads/${branch}`).trim();
  const main = git(remote.clone, 'rev-parse', 'main').trim();
  expect(before).not.toBe(main);
  const id = await sendDevopsRequest(
    api,
    host.workstationId,
    `tidy the card branches [scn:movebranch;path=${wt};clone=${remote.clone}]`,
  );
  await waitRequest(id, 'finished', (r) => TERMINAL(r?.status), 180_000);
  const progress = await progressOfRequest(id);
  expect(progress, 'the script really moved it').toContain(`scn: moved ${branch}`);
  expect(
    git(remote.clone, 'rev-parse', `refs/heads/${branch}`).trim(),
    'the card branch is back where it was',
  ).toBe(before);
  expect(git(wt, 'rev-parse', 'HEAD').trim()).toBe(before);
  // the runner told the shift it was refused (its first report failed)
  expect(progress).toMatch(/first report [1-9]/);
  const shift = ((await shiftsOfRequest(id)).slice(-1)[0] ?? '').slice(0, 8);
  const kept = git(remote.clone, 'for-each-ref', '--format=%(refname)', `refs/guildwise/refused/${shift}`);
  expect(kept.trim().length, 'the moved state is kept off the branch').toBeGreaterThan(0);
});

test('[C3] the approval settings are sealed: an edit made outside the runner makes everything ask, the page says so, and `policy accept` is the way back', async () => {
  const sealed = runnerCli(host, ['policy']);
  expect(sealed.out, sealed.out).toContain('sealed with');
  // someone (or an agent) edits policy.json directly
  const file = join(host.policyDir, 'policy.json');
  const obj = JSON.parse(readFileSync(file, 'utf8'));
  obj.tampered = true;
  writeFileSync(file, JSON.stringify(obj, null, 2));
  const bad = runnerCli(host, ['policy']);
  expect(bad.out, bad.out).toMatch(/INVALID|changed outside the runner/i);
  await waitFor(
    'the page shows the policy problem',
    async () => (await page.state()).status.policyError ?? '',
    (e) => /outside the runner|seal/i.test(e),
    30_000,
  );
  // the local grant is gone while it is unsealed: the runner turns the DevOps shift away and the request waits
  const id = await sendDevopsRequest(api, host.workstationId, 'look at the disk');
  const rejected = await waitFor(
    'the DevOps shift was turned away',
    async () => {
      const ids = await shiftsOfRequest(id);
      return q<{ outcome: string | null }>(`SELECT outcome FROM shifts WHERE id = ANY($1::uuid[])`, [ids]);
    },
    (r) => r.some((x) => x.outcome === 'rejected'),
    120_000,
  );
  expect(rejected.length).toBeGreaterThan(0);
  expect((await devopsRequest(id))?.status, 'not done while nothing is granted').not.toBe('done');
  // the owner reads the file and seals it as it is (typed yes at the keyboard)
  const accept = runnerCli(host, ['policy', 'accept'], ['yes']);
  expect(accept.code, accept.out).toBe(0);
  await waitFor(
    'the page is clean again',
    async () => (await page.state()).status.policyError ?? '',
    (e) => e === '',
    30_000,
  );
  // the server sends the waiting request again once its back-off is over: with the policy sealed again it runs
  await advanceClock(10 * 60_000);
  expect((await waitRequest(id, 'done', (r) => TERMINAL(r?.status), 180_000))?.status).toBe('done');
});

test('[C13] an upgrade over a sealed policy with the shared Docker daemon: setup and the record step as the runner, then a start: connected, sealed, the shared-daemon acceptance holds', async () => {
  // installer-policy-seal (Combined-QA blocker 3). The harness has no root and no Docker: the root step (guildwise-admin, which
  // no longer writes policy.json) and the start-up refusal are unit-tested (installer-policy-seal.test.ts, startup-check.test.ts)
  const sock = '/run/docker-c13/docker.sock';
  let h = await startHost(api, {
    password: OWNER.password,
    name: 'c13-box',
    repoRoot: remote.repoRoot,
    policy: {
      extra: {
        docker: 'shared',
        dockerHost: `unix://${sock}`,
        sharedDocker: { socket: sock, group: 'docker-c13', acceptedAt: '2026-11-26T08:00:00.000Z' },
      },
    },
  });
  try {
    // the first start sealed it
    const first = runnerCli(h, ['policy']);
    expect(first.out, first.out).toContain('sealed with');
    expect(first.out).toContain('"devopsRequests": "auto"');
    await stopHost(h);
    // the installer's choices step: the real `guildwise-runner setup` as the runner, with a changed choice
    const setup = runnerCli(h, [
      'setup',
      '--yes',
      '--runner-user',
      'current',
      '--docker',
      'shared',
      '--docker-socket',
      sock,
      '--accept-shared-daemon',
      '--devops-requests',
      'ask',
      '--no-ytdlp',
    ]);
    expect(setup.code, setup.out).toBe(0);
    expect(setup.out).toContain('policy record-shared-docker');
    // the installer's record step after root's join: already recorded for this socket, nothing to change
    const rec = runnerCli(h, ['policy', 'record-shared-docker']);
    expect(rec.code, rec.out).toBe(0);
    expect(rec.out).toContain(`The shared Docker daemon ${sock} is already recorded`);
    // the service starts again: no new pairing, policy.json is not rewritten by the harness
    h = await restartHost(h);
    const after = runnerCli(h, ['policy']);
    expect(after.out, after.out).toContain('sealed with');
    expect(after.out).not.toMatch(/INVALID|changed outside the runner/);
    expect(after.out).toContain('"devopsRequests": "ask"');
    expect(after.out).toContain('"docker": "shared"');
    expect(after.out).toContain(`"socket": "${sock}"`);
    expect(after.out).toContain('"group": "docker-c13"');
    const page13 = new ApprovalsPage(h.approvalsPort, h.policyDir);
    expect((await page13.state()).status.policyError ?? '').toBe('');
    const ws = await q<{ connected: boolean }>('SELECT connected FROM workstations WHERE id=$1', [
      h.workstationId,
    ]);
    expect(ws[0]?.connected).toBe(true);
  } finally {
    await h.stop();
  }
});
