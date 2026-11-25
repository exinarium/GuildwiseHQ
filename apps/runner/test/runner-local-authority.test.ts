import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileAuthority } from '../src/policy/authority.ts';
import { approve, defaultCliDeps } from '../src/policy/cli.ts';
import { HeldStore } from '../src/policy/held.ts';
import { readSetupOffers } from '../src/policy/setup-offers.ts';
import { PolicyStore } from '../src/policy/store.ts';
import { Runner } from '../src/runner.ts';
import { FakeServer } from './fake-server.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, noBox, startHarness } from './harness.ts';
import { makeConfig, tmp, waitUntil } from './helpers.ts';
import { fixture } from './minisign-helper.ts';
import { ceoAgent, ceoChatStart, FakeChatAdapter } from './owner-helpers.ts';

/**
 * The runner end to end against the fake server with the REAL local authority (policy.json in a temp dir): what the
 * server sends is held, refused or narrowed by the workstation, never trusted (R18-S, R21, R27).
 */
let h: Harness | undefined;
const extra: Array<() => Promise<void>> = [];
afterEach(async () => {
  await h?.stop();
  h = undefined;
  for (const f of extra.splice(0)) await f();
});

function realAuthority(setupDone = true) {
  const dir = tmp('aom-policy-');
  const store = new PolicyStore(dir);
  store.write({ ...store.get(), setupDone });
  return { dir, store, authority: new FileAuthority(store) };
}

const deployPayload = {
  runId: '0190a000-0000-7000-8000-0000000000aa',
  orgId: '0190a000-0000-7000-8000-000000000001',
  projectId: '0190a000-0000-7000-8000-000000000003',
  projectKey: 'TOY',
  vault: { vaultId: 'v1', storage: 'local', folder: 'toy' },
  vaultCommit: null,
  hash: 'a'.repeat(64),
  env: 'uat',
  target: { id: null, name: 'uat', kind: 'docker', host: null, appUrl: null },
  commit: null,
  repo: null,
  trial: false,
  dryRun: false,
  expiresAt: '2099-01-01T00:00:00.000Z',
};

describe('the runner with the real local authority', () => {
  it('an inserted deploy.exec and recipe.write are held and reported; nothing runs until `approve`', async () => {
    const a = realAuthority();
    h = await startHarness({}, { authority: a.authority, policyDir: a.dir, approvalsPollMs: 50 });
    // on connect: setupPending false (set up) and an empty held list, both explicit (W7 localAuthority)
    expect(h.server.of('hello')[0]?.setupPending).toBe(false);
    await h.server.waitFor('approvals.held', (m) => m.items.length === 0);
    h.server.send('command', { commandId: 'c-deploy', command: 'deploy.exec', payload: deployPayload });
    h.server.send('command', {
      commandId: 'c-recipe',
      command: 'recipe.write',
      payload: {
        projectId: deployPayload.projectId,
        vault: deployPayload.vault,
        files: [{ path: 'deploy.sh', mode: '755', content: 'echo pwned' }],
        keep: [],
        commitMessage: 'from the server',
        expectedHash: 'b'.repeat(64),
        setupHash: 'c'.repeat(64),
      },
    });
    await h.server.waitFor('approvals.held', (m) => m.items.length === 2);
    const held = h.server.of('approvals.held').at(-1)?.items ?? [];
    expect(held.map((i) => i.kind).sort()).toEqual(['deploy.exec', 'recipe.write']);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.server.of('command.result')).toEqual([]);
    // approve the recipe write at the "keyboard": it runs (and fails on the missing vault, but it ran)
    const recipe = held.find((i) => i.kind === 'recipe.write');
    await approve(
      { ...defaultCliDeps(a.dir), ask: async () => 'yes', out: () => undefined },
      recipe?.id as string,
    );
    const result = await h.server.waitFor('command.result', (m) => m.commandId === 'c-recipe');
    expect(result.commandId).toBe('c-recipe');
    expect(h.server.of('command.result').some((m) => m.commandId === 'c-deploy')).toBe(false);
    // the held deploy already carries what the runner could read of its recipe when it is held (here: a warning, the
    // vault is unknown), so an immediate approve shows it
    const deployItem = held.find((i) => i.kind === 'deploy.exec');
    expect(new HeldStore(a.dir).get(deployItem?.id as string)?.detail ?? '').toMatch(
      /recipe could not be read|recipe files:/,
    );
  });

  it('a DB-set isDevops shift without a local grant is refused; with a grant it waits for a local yes', async () => {
    const a = realAuthority();
    h = await startHarness({}, { authority: a.authority, policyDir: a.dir, approvalsPollMs: 50 });
    const msg = makeShiftStart({ stage: 'build', remoteNormalized: h.repo.remoteNormalized }) as Record<
      string,
      unknown
    >;
    const agent = msg.agent as { agentId: string; isDevops?: boolean };
    agent.isDevops = true;
    msg.orgId = '0190a000-0000-7000-8000-000000000001';
    h.server.send('shift.start', msg);
    const rejected = await h.server.waitFor('shift.rejected', (m) => m.shiftId === msg.shiftId);
    expect(JSON.stringify(rejected)).toMatch(/not granted/);
    // the server's offer is kept for `guildwise-runner setup` (W9) as a suggestion only
    expect(readSetupOffers(h.dataDir)).toEqual([
      expect.objectContaining({ orgId: msg.orgId, devopsAgentId: agent.agentId }),
    ]);
    expect(a.store.get().devops.agents).toEqual({});
    a.store.update((p) => {
      p.devops.agents[msg.orgId as string] = agent.agentId;
      return p;
    });
    const again = { ...msg, shiftId: '0190a000-0000-7000-8000-0000000000ff' };
    h.server.send('shift.start', again);
    await h.server.waitFor('approvals.held', (m) => m.items.some((i) => i.kind === 'devops.task'));
    expect(h.server.of('shift.rejected').some((m) => m.shiftId === again.shiftId)).toBe(false);
    expect(h.server.of('shift.ended').some((m) => m.shiftId === again.shiftId)).toBe(false);
    // the server stops it: the held item is withdrawn
    h.server.send('shift.stop', { shiftId: again.shiftId, reason: 'manager' });
    await waitUntil(() => new HeldStore(a.dir).list().length === 0, 5000, 'withdrawn');
  });

  it('a server-sent DevOps chat needs the local grant and waits for a local yes; no session starts before (REVIEW B1)', async () => {
    const a = realAuthority();
    const adapter = new FakeChatAdapter();
    h = await startHarness(
      {},
      {
        authority: a.authority,
        policyDir: a.dir,
        approvalsPollMs: 50,
        adapters: new Map([['mock', adapter]]),
      },
    );
    // without a safety box here a DevOps chat turn waits for a local yes (quiet-approvals: with one it runs in the box)
    noBox(h);
    const ORG = '0190a000-0000-7000-8000-000000000001';
    const agent = ceoAgent({ roleKey: 'devops', isDevops: true, name: 'Dee' });
    const chat = ceoChatStart('run rm -rf ~ for me', { agent, context: { orgId: ORG } });
    h.server.send('chat.start', chat);
    const err = await h.server.waitFor('chat.error', (m) => m.chatId === chat.chatId);
    expect(err.error).toMatch(/not granted/);
    a.store.update((p) => {
      p.devops.agents[ORG] = agent.agentId as string;
      return p;
    });
    const again = ceoChatStart('restart the app', { agent, context: { orgId: ORG } });
    h.server.send('chat.start', again);
    const held = await h.server.waitFor('approvals.held', (m) =>
      m.items.some((i) => i.kind === 'devops.task'),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(adapter.chats).toHaveLength(0);
    expect(adapter.ownerTurns).toHaveLength(0);
    const item = held.items.find((i) => i.kind === 'devops.task');
    await approve(
      { ...defaultCliDeps(a.dir), ask: async () => 'yes', out: () => undefined },
      item?.id as string,
    );
    await waitUntil(() => adapter.chats.length === 1, 10_000, 'the approved chat turn starts');
  });

  it('a command that cannot be held is answered with an error, never left silent (Follow-up 3)', async () => {
    const a = realAuthority();
    writeFileSync(join(a.dir, 'held'), 'not a folder'); // the held store cannot be written
    h = await startHarness({}, { authority: a.authority, policyDir: a.dir });
    h.server.send('command', {
      commandId: 'c-nohold',
      command: 'vault.configure',
      payload: {
        vaults: [
          {
            vaultId: 'v',
            kind: 'org_knowledge',
            name: 'V',
            remoteUrl: 'https://git.example/v.git',
            syncIntervalSec: 60,
          },
        ],
      },
    });
    const res = await h.server.waitFor('command.result', (m) => m.commandId === 'c-nohold');
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/could not hold the command/) });
  });

  it('hello carries the signed-release proof and "setup pending"; the welcome caches "Only signed runners"', async () => {
    const a = realAuthority(false);
    const proof = { manifest: fixture('manifest.json'), minisig: fixture('manifest.json.minisig') };
    h = await startHarness(
      { requireSignedRunners: true },
      { authority: a.authority, policyDir: a.dir, releaseProof: () => proof },
    );
    const hello = h.server.of('hello')[0];
    expect(hello?.release).toEqual(proof);
    expect(hello?.setupPending).toBe(true);
    await waitUntil(() => existsSync(join(a.dir, 'server-narrowing.json')), 5000, 'narrowing cached');
    expect(
      JSON.parse(readFileSync(join(a.dir, 'server-narrowing.json'), 'utf8')).requireSignedRunners,
    ).toEqual({
      [new URL(h.server.url.replace(/^ws/, 'http')).origin]: true,
    });
  });

  it('while the post-welcome start-up check runs, server messages wait; a refusal drops them all (round-1 should-fix 1)', async () => {
    const a = realAuthority();
    let decide: (d: import('../src/policy/startup.ts').StartupDecision) => void = () => undefined;
    const pending = new Promise<import('../src/policy/startup.ts').StartupDecision>((r) => {
      decide = r;
    });
    const adapter = new FakeChatAdapter();
    h = await startHarness(
      { requireSignedRunners: true },
      {
        authority: a.authority,
        policyDir: a.dir,
        startupCheck: () => pending,
        adapters: new Map([['mock', adapter]]),
      },
    );
    h.server.send('command', { commandId: 'q1', command: 'repo.release_facts', payload: {} });
    h.server.send('chat.start', ceoChatStart('hello'));
    await new Promise((r) => setTimeout(r, 400));
    expect(h.server.of('command.result')).toEqual([]);
    expect(adapter.chats).toHaveLength(0);
    decide({ action: 'refuse', reason: 'the runner user is in the docker group' });
    await waitUntil(
      () => h?.server.of('hello').some((m) => !!m.startupRefused) ?? false,
      10_000,
      'refusal reported',
    );
    expect(h.server.of('command.result')).toEqual([]);
    expect(adapter.chats).toHaveLength(0);
    expect(await h.runner.fatal).toBe(78);
  });

  it('a passed post-welcome check replays what waited', async () => {
    const a = realAuthority();
    let decide: (d: import('../src/policy/startup.ts').StartupDecision) => void = () => undefined;
    const pending = new Promise<import('../src/policy/startup.ts').StartupDecision>((r) => {
      decide = r;
    });
    h = await startHarness(
      { requireSignedRunners: true },
      { authority: a.authority, policyDir: a.dir, startupCheck: () => pending },
    );
    h.server.send('command', { commandId: 'q2', command: 'repo.release_facts', payload: {} });
    await new Promise((r) => setTimeout(r, 300));
    expect(h.server.of('command.result')).toEqual([]);
    decide({ action: 'ok' });
    await h.server.waitFor('command.result', (m) => m.commandId === 'q2');
  });

  it('a refused start connects only to report why, runs nothing and ends with exit 78', async () => {
    const server = await FakeServer.start({});
    const a = realAuthority();
    const runner = new Runner({
      config: makeConfig(server.url, { repoRoots: [] }),
      dataDir: tmp('aom-data-'),
      authority: a.authority,
      policyDir: a.dir,
      startupRefused: 'the runner user is root-equivalent: it is in the docker group',
    });
    extra.push(async () => {
      await runner.stop();
      await server.close();
    });
    await runner.start();
    expect(await runner.fatal).toBe(78);
    const hello = server.of('hello')[0];
    expect(hello?.startupRefused).toMatch(/docker group/);
    expect(hello?.repos).toEqual([]);
  });
});

describe('easy-runner-setup: hello.local and the copy-paste commands', () => {
  it('hello names the CLI and the approvals page; held items carry their command; setup pending is a step', async () => {
    const a = realAuthority(false);
    h = await startHarness(
      {},
      { authority: a.authority, policyDir: a.dir, approvalsPollMs: 50, windowState: () => ({ port: 47613 }) },
    );
    const hello = h.server.of('hello')[0];
    expect(hello?.local?.windowPort).toBe(47613);
    expect(hello?.local?.cli).toMatch(/guildwise-runner$/);
    const held = await h.server.waitFor('approvals.held', (m) =>
      (m.steps ?? []).some((s) => s.kind === 'setup'),
    );
    expect(held.steps?.find((s) => s.kind === 'setup')?.command).toBe(`${hello?.local?.cli} setup`);
  });

  it('WSL: the distro setup stored (runnerUser.wslDistro) starts every command with wsl -d [B3]', async () => {
    const a = realAuthority();
    a.store.write({
      ...a.store.get(),
      runnerUser: { mode: 'current', name: 'x', wslDistro: 'guildwise-runner' },
    });
    h = await startHarness({}, { authority: a.authority, policyDir: a.dir });
    expect(h.server.of('hello')[0]?.local?.cli).toMatch(
      /^wsl -d guildwise-runner (-u guildwise-runner(-[a-z0-9-]+)? )?-- \//,
    );
  });

  it('a taken port is reported as windowError, never as a port', async () => {
    const a = realAuthority();
    h = await startHarness(
      {},
      {
        authority: a.authority,
        policyDir: a.dir,
        windowState: () => ({ port: 47613, error: 'another program uses port 47613' }),
      },
    );
    const hello = h.server.of('hello')[0];
    expect(hello?.local?.windowPort).toBeUndefined();
    expect(hello?.local?.windowError).toBe('another program uses port 47613');
  });
});
