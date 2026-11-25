import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { ShiftStartInput } from '../src/adapters/types.ts';
import { APPROVED_REQUESTS_FILE, ApprovedRequests } from '../src/policy/approved-requests.ts';
import { FileAuthority } from '../src/policy/authority.ts';
import { approve, defaultCliDeps } from '../src/policy/cli.ts';
import { HeldStore } from '../src/policy/held.ts';
import { PolicyStore } from '../src/policy/store.ts';
import { sandboxFor } from '../src/sandbox/sandbox.ts';
import { type Harness, startHarness } from './harness.ts';
import { tmp, waitUntil } from './helpers.ts';
import { type Ctl, ScriptedAdapter } from './scripted-adapter.ts';
import { makeDevopsStart, serverShapedRedispatch } from './vault-fixtures.ts';

/**
 * quiet-approvals phase A end to end (DESIGN test plan, integration): the runner with the REAL local authority and a
 * scripted agent. A DevOps request runs inside the box without a hold; `aom devops-outside` holds the same shift once;
 * the local yes runs it outside and remembers the exact job; an identical re-dispatch then runs outside without asking,
 * a changed one goes back into the box; a hygiene request never starts an AI session.
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const ORG = '0190a000-0000-7000-8000-000000000001';

/** A scripted runtime that builds the box (like Claude Code with bubblewrap present). */
class BoxScripted extends ScriptedAdapter {
  boxMissing(): string | null {
    return null;
  }
}

async function withRealAuthority(
  script: (input: ShiftStartInput, ctl: Ctl) => Promise<unknown>,
  over: Record<string, unknown> = {},
) {
  const dir = tmp('aom-qa-policy-');
  const store = new PolicyStore(dir);
  store.write({ ...store.get(), setupDone: true, ...over });
  const adapter = new BoxScripted(script);
  h = await startHarness(
    {},
    {
      authority: new FileAuthority(store),
      policyDir: dir,
      approvalsPollMs: 50,
      adapters: new Map([['mock', adapter]]),
    },
  );
  return { dir, store, adapter, harness: h };
}

function devopsMsg(agentId: string, summary = 'look at the logs', devops: Record<string, unknown> = {}) {
  const base = makeDevopsStart({ summary, agentId }) as Record<string, any>;
  return { ...base, orgId: ORG, devops: { ...base.devops, ...devops } } as Record<string, any>;
}

const done = (ctl: Ctl) =>
  ctl.post('/v1/report', {
    report: {
      kind: 'outcome',
      outcomeId: 'devops_done',
      note: 'done',
      data: { summary: 'done', commands: [] },
    },
  });

describe('phase A: DevOps work starts inside the box', () => {
  it('a request runs in the box with no hold; DevOps verbs are refused there with the way out', async () => {
    const seen: Record<string, any> = {};
    const env = await withRealAuthority(async (input, ctl) => {
      seen.push = await ctl.post('/v1/rpc', {
        method: 'git.push',
        params: { repo: '/x', refspecs: ['main'] },
      });
      seen.install = await ctl.post('/v1/rpc', { method: 'devops.install', params: {} });
      seen.list = await ctl.post('/v1/rpc', { method: 'toolchain.list', params: {} });
      seen.approval = await ctl.post('/v1/report', {
        report: {
          kind: 'outcome',
          outcomeId: 'devops_approval',
          note: 'x',
          data: { action: 'run docker', reason: 'r', commands: ['docker ps'] },
        },
      });
      seen.cwd = input.cwd;
      await done(ctl);
    });
    const agentId = uuidv7();
    env.store.update((p) => ({ ...p, devops: { agents: { [ORG]: agentId } } }));
    const msg = devopsMsg(agentId);
    env.harness.server.send('shift.start', msg);
    await env.harness.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 60_000);
    expect(env.harness.server.of('approvals.held').every((m) => m.items.length === 0)).toBe(true);
    expect(env.adapter.inputs).toHaveLength(1);
    expect(env.adapter.inputs[0]?.devopsBox).toBe(true);
    expect(env.adapter.inputs[0]?.devopsGuard).toBeUndefined();
    expect(seen.cwd).toContain(join('devops', msg.devops.requestId));
    expect(seen.push.json.ok).toBe(false);
    expect(seen.push.json.error).toContain('aom devops-outside');
    expect(seen.install.json.ok).toBe(false);
    expect(seen.list.json.ok).toBe(true);
    expect(seen.approval.json.accepted).toBe(false);
    expect(String(seen.approval.json.message ?? seen.approval.json.error)).toContain('devops-outside');
    expect(env.adapter.instructions[0]).toContain('You work inside the safety box');
  }, 90_000);

  it('devops-outside holds the same shift once; the local yes runs it outside and remembers the exact job', async () => {
    let calls = 0;
    const env = await withRealAuthority(async (_input, ctl) => {
      calls++;
      if (calls === 1) {
        await ctl.post('/v1/rpc', {
          method: 'devops.outside',
          params: { needs: 'docker', why: 'the app runs in docker compose' },
        });
        // the runner stops the session; stay until it does
        await new Promise<void>((r) => ctl.signal.addEventListener('abort', () => r()));
        return;
      }
      await done(ctl);
    });
    const agentId = uuidv7();
    env.store.update((p) => ({ ...p, devops: { agents: { [ORG]: agentId } } }));
    const msg = devopsMsg(agentId, 'start the app');
    env.harness.server.send('shift.start', msg);
    const heldMsg = await env.harness.server.waitFor('approvals.held', (m) =>
      m.items.some((i) => i.kind === 'devops.task'),
    );
    const item = heldMsg.items.find((i) => i.kind === 'devops.task');
    expect(item?.shiftId).toBe(msg.shiftId);
    expect(item?.summary).toContain('needs to work outside the safety box: docker');
    // the box session ended without ending the shift on the server
    expect(env.harness.server.of('shift.ended').some((m) => m.shiftId === msg.shiftId)).toBe(false);
    expect(env.adapter.inputs).toHaveLength(1);
    await approve(
      { ...defaultCliDeps(env.dir), ask: async () => 'yes', out: () => undefined },
      item?.id as string,
    );
    await env.harness.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 60_000);
    expect(env.adapter.inputs).toHaveLength(2);
    expect(env.adapter.inputs[1]?.devopsBox).toBeUndefined();
    expect(env.adapter.inputs[1]?.devopsGuard).toBeDefined();
    expect(existsSync(join(env.harness.dataDir, APPROVED_REQUESTS_FILE))).toBe(true);

    // R2: the identical job, re-dispatched (new shift ids, nested brief.shift.id too), runs outside without a hold
    await env.harness.runner.supervisor.whenSettled(msg.shiftId);
    const again = {
      ...msg,
      shiftId: uuidv7(),
      claimId: uuidv7(),
      brief: { ...msg.brief, shift: { ...msg.brief.shift, id: uuidv7() } },
    };
    again.brief.shift.id = again.shiftId;
    env.harness.server.send('shift.start', again);
    await env.harness.server.waitFor('shift.ended', (m) => m.shiftId === again.shiftId, 60_000);
    expect(env.adapter.inputs).toHaveLength(3);
    expect(env.adapter.inputs[2]?.devopsBox).toBeUndefined();
    expect(new HeldStore(env.dir).list().filter((r) => r.state === 'held')).toEqual([]);

    // a changed job goes back into the box
    await env.harness.runner.supervisor.whenSettled(again.shiftId);
    const changed = {
      ...msg,
      shiftId: uuidv7(),
      claimId: uuidv7(),
      devops: { ...msg.devops, summary: 'and wipe it' },
    };
    env.harness.server.send('shift.start', changed);
    await waitUntil(() => env.adapter.inputs.length === 4, 30_000, 'the changed job starts');
    expect(env.adapter.inputs[3]?.devopsBox).toBe(true);
  }, 120_000);

  it('a passkey decision is never remembered as an exact job', async () => {
    let calls = 0;
    const env = await withRealAuthority(async (_input, ctl) => {
      calls++;
      if (calls === 1) {
        await ctl.post('/v1/rpc', { method: 'devops.outside', params: { needs: 'docker', why: 'compose' } });
        await new Promise<void>((r) => ctl.signal.addEventListener('abort', () => r()));
        return;
      }
      await done(ctl);
    });
    const agentId = uuidv7();
    env.store.update((p) => ({ ...p, devops: { agents: { [ORG]: agentId } } }));
    const msg = devopsMsg(agentId, 'start it');
    env.harness.server.send('shift.start', msg);
    const heldMsg = await env.harness.server.waitFor('approvals.held', (m) =>
      m.items.some((i) => i.kind === 'devops.task'),
    );
    const item = heldMsg.items.find((i) => i.kind === 'devops.task');
    // the runner's own record of a decision made elsewhere than this computer's keyboard or page
    new HeldStore(env.dir).decide(item?.id as string, 'approved', 'passkey');
    await env.harness.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 60_000);
    expect(existsSync(join(env.harness.dataDir, APPROVED_REQUESTS_FILE))).toBe(false);
  }, 90_000);
});

describe('phase A: the tidy-up is a fixed routine', () => {
  const hygiene = (localPath: string) => ({
    trigger: 'schedule',
    repos: [
      {
        repoId: uuidv7(),
        projectId: uuidv7(),
        projectKey: 'TOY',
        projectName: 'Toy',
        name: 'toy',
        localPath,
        remoteUrl: 'https://example.test/toy.git',
        workingBranch: 'main',
        branchSource: 'repo',
        branchPrefix: 'aom/',
        finishedBranches: [],
        mainBranch: null,
        finishedCards: [],
      },
    ],
  });

  it('with the tick it runs without asking and starts no AI session; without it, one local yes, still no session', async () => {
    const env = await withRealAuthority(async () => {
      throw new Error('a hygiene request never starts an AI session');
    });
    const agentId = uuidv7();
    env.store.update((p) => ({ ...p, devops: { agents: { [ORG]: agentId } }, hygiene: 'run' }));
    const msg = devopsMsg(agentId, 'tidy', { hygiene: hygiene(env.harness.repo.clone) });
    env.harness.server.send('shift.start', msg);
    await env.harness.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 60_000);
    const rep = env.harness.server.of('shift.report').find((m) => m.shiftId === msg.shiftId);
    expect((rep?.report as { outcomeId?: string } | undefined)?.outcomeId).toBe('devops_done');
    expect(env.adapter.inputs).toHaveLength(0);

    env.store.update((p) => ({ ...p, hygiene: 'ask' }));
    const second = devopsMsg(agentId, 'tidy', { hygiene: hygiene(env.harness.repo.clone) });
    env.harness.server.send('shift.start', second);
    const heldMsg = await env.harness.server.waitFor('approvals.held', (m) =>
      m.items.some((i) => i.shiftId === second.shiftId),
    );
    const item = heldMsg.items.find((i) => i.shiftId === second.shiftId);
    expect(item?.summary).toContain('fixed routine');
    await approve(
      { ...defaultCliDeps(env.dir), ask: async () => 'yes', out: () => undefined },
      item?.id as string,
    );
    await env.harness.server.waitFor('shift.ended', (m) => m.shiftId === second.shiftId, 60_000);
    expect(env.adapter.inputs).toHaveLength(0);
  }, 120_000);
});

describe('phase A: a DevOps chat turn runs inside the box', () => {
  it('no hold, the box profile and no guard; without a box on this computer it waits for a local yes', async () => {
    const { FakeChatAdapter, THREAD } = await import('./owner-helpers.ts');
    const dir = tmp('aom-qa-policy-');
    const store = new PolicyStore(dir);
    const agentId = uuidv7();
    store.write({ ...store.get(), setupDone: true, devops: { agents: { [ORG]: agentId } } });
    const adapter = new FakeChatAdapter();
    h = await startHarness(
      {},
      {
        authority: new FileAuthority(store),
        policyDir: dir,
        approvalsPollMs: 50,
        adapters: new Map([['mock', adapter]]),
      },
    );
    const chat = (message: string) => ({
      chatId: uuidv7(),
      threadId: THREAD,
      agent: {
        agentId,
        name: 'Forge',
        roleKey: 'devops',
        seniority: 'senior',
        runtime: 'mock',
        model: 'sonnet',
        skills: [],
        permissions: BUILTIN_ROLES.find((r) => r.key === 'devops')?.permissions,
        isDevops: true,
      },
      message,
      context: { orgId: ORG },
    });
    const m = chat('what is running?');
    h.server.send('chat.start', m);
    await h.server.waitFor('chat.done', (d) => d.chatId === m.chatId);
    expect(adapter.chats[0]?.devopsBox).toBe(true);
    expect(adapter.chats[0]?.devopsGuard).toBeUndefined();
    expect(h.server.of('approvals.held').every((x) => x.items.length === 0)).toBe(true);
    // REVIEW S4: the same runtime whose box cannot start here: refused with the reason and one Desk step, no hold
    (adapter as unknown as { boxMissing: () => string | null }).boxMissing = () =>
      'bwrap and socat not installed';
    const n = chat('and now?');
    h.server.send('chat.start', n);
    const err = await h.server.waitFor('chat.error', (x) => x.chatId === n.chatId);
    expect(String(err.error)).toMatch(
      /DevOps cannot work on this computer yet: bwrap and socat not installed/,
    );
    const step = await h.server.waitFor('approvals.held', (x) =>
      (x.steps ?? []).some((st) => st.kind === 'devops.box'),
    );
    expect(step.items.some((i) => i.kind === 'devops.task')).toBe(false);
    // a runtime with no box at all: one local yes, and then the turn runs as before
    (adapter as unknown as { boxMissing?: unknown }).boxMissing = undefined;
    const m2 = chat('and later?');
    h.server.send('chat.start', m2);
    const held = await h.server.waitFor('approvals.held', (x) =>
      x.items.some((i) => i.kind === 'devops.task'),
    );
    expect(held.items.find((i) => i.kind === 'devops.task')?.summary).toContain('DevOps chat turn');
    expect(adapter.chats).toHaveLength(1);
  }, 90_000);
});

describe('phase B: a Desk click beyond the local ceiling', () => {
  it('runs without it and raises one "needs a change on your computer" step', async () => {
    const env = await withRealAuthority(async (_i, ctl) => done(ctl), {
      allowDocker: true,
      ceiling: { docker: false, mountRoots: [], containerEgress: false },
    });
    const agentId = uuidv7();
    env.store.update((p) => ({ ...p, devops: { agents: { [ORG]: agentId } } }));
    const msg = devopsMsg(agentId, 'start the compose stack', {
      access: { allowInstall: false, allowDocker: true, sudo: false, allowedPaths: ['/srv/app'] },
    });
    env.harness.server.send('shift.start', msg);
    await env.harness.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 60_000);
    const steps = env.harness.server
      .of('approvals.held')
      .flatMap((m) => m.steps ?? [])
      .filter((s) => s.kind === 'devops.ceiling');
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0]?.summary).toContain('Docker');
    expect(steps[0]?.summary).toContain('the folder /srv/app');
    // it ran in the box without Docker or the folder
    expect(env.adapter.inputs[0]?.devopsBox).toBe(true);
  }, 90_000);
});

describe('S6/D9 at runner level, on this computer’s real Docker (skipped without one)', () => {
  const SOCK = '/run/docker-svc/docker.sock';
  const docker = (...a: string[]) =>
    require('node:child_process').spawnSync('docker', ['-H', `unix://${SOCK}`, ...a], {
      encoding: 'utf8',
    }) as {
      status: number | null;
      stdout: string;
    };
  const image = (() => {
    try {
      if (docker('version').status !== 0) return null;
      const d = docker(
        'image',
        'inspect',
        'node:22.23-bookworm-slim',
        '--format',
        '{{index .RepoDigests 0}}',
      );
      return d.status === 0 && /@sha256:/.test(d.stdout) ? d.stdout.trim() : null;
    } catch {
      return null;
    }
  })();

  it.skipIf(!image)(
    'the services come up behind the bridge with no internet; the recipe internet waits for a Desk passkey, then applies',
    async () => {
      const dir = tmp('aom-qa-policy-');
      const store = new PolicyStore(dir);
      store.write({
        ...store.get(),
        setupDone: true,
        allowDocker: true,
        docker: 'shared',
        dockerHost: `unix://${SOCK}`,
        ceiling: { docker: true, mountRoots: [], containerEgress: true },
      });
      h = await startHarness(
        {},
        { authority: new FileAuthority(store), policyDir: dir, approvalsPollMs: 50 },
      );
      (
        h.runner as unknown as { opts: { config: Record<string, unknown> } }
      ).opts.config.testServicesBridgeImage = (image as string).replace(/^[^@]+/, 'node');
      const instance = createHash('sha256').update(h.dataDir).digest('hex').slice(0, 16);
      const hostPort = 20000 + Math.floor(Math.random() * 20000);
      const recipe = JSON.stringify({
        services: [
          {
            name: 'web',
            image: (image as string).replace(/^[^@]+/, 'node'),
            port: 8080,
            hostPort,
            cmd: ['node', '-e', 'require("http").createServer((q,s)=>s.end("SERVICE-OK")).listen(8080)'],
          },
        ],
        egress: true,
      });
      const msg = devopsMsg(uuidv7(), 'bring the test services up');
      const up = (
        h.runner as unknown as { testServicesUp: (m: unknown, t: string) => Promise<any> }
      ).testServicesUp.bind(h.runner);
      try {
        const r1 = await up(msg, recipe);
        expect(r1.ok, r1.error).toBe(true);
        await waitUntil(
          async () =>
            (await fetch(`http://127.0.0.1:${hostPort}/`)
              .then((x) => x.text())
              .catch(() => '')) === 'SERVICE-OK',
          30_000,
          'the service answers through the bridge',
        );
        const svc = docker('ps', '--filter', `label=guildwise.runner=${instance}`, '--format', '{{.Names}}')
          .stdout.split('\n')
          .find((n) => n.endsWith('-web')) as string;
        // round 6: a service container cannot reach the internet directly, by name, or through the bridge's port
        const probe = docker(
          'exec',
          svc,
          'node',
          '-e',
          `const n=require("net");const t=(h,p)=>new Promise(r=>{const s=n.connect({host:h,port:p,timeout:4000},()=>{console.log("REACHED",h);s.destroy();r()});s.on("error",()=>r());s.on("timeout",()=>{s.destroy();r()})});(async()=>{await t("1.1.1.1",443);await t("example.com",80)})()`,
        );
        expect(probe.stdout).not.toContain('REACHED');
        const net = docker(
          'network',
          'ls',
          '--filter',
          `label=guildwise.runner=${instance}`,
          '--format',
          '{{.Name}}',
        ).stdout.trim();
        expect(docker('network', 'inspect', net, '--format', '{{.Internal}}').stdout.trim()).toBe('true');
        // D9: the recipe asked for internet; the ceiling allows it, so a Desk passkey click is asked for (held kind)
        const held = new HeldStore(dir).list().find((x) => x.kind === 'test.recipe_egress');
        expect(held?.state).toBe('held');
        new HeldStore(dir).decide(held?.id as string, 'approved', 'passkey');
        const approvals = new (await import('../src/box/test-services.ts')).RecipeApprovals(dir);
        await waitUntil(() => !!approvals.get(msg.brief.project.id), 10_000, 'the approval is recorded');
        const r2 = await up(msg, recipe);
        expect(r2.ok, r2.error).toBe(true);
        expect(docker('network', 'inspect', net, '--format', '{{.Internal}}').stdout.trim()).toBe('false');
      } finally {
        for (const c of docker('ps', '-aq', '--filter', `label=guildwise.runner=${instance}`)
          .stdout.split('\n')
          .filter(Boolean))
          docker('rm', '-f', c);
        for (const n of docker('network', 'ls', '-q', '--filter', `label=guildwise.runner=${instance}`)
          .stdout.split('\n')
          .filter(Boolean))
          docker('network', 'rm', n);
      }
    },
    120_000,
  );

  it('without the ceiling allowing it, the recipe internet is never held for a click: it needs a change on the computer', async () => {
    const { planTestServices, parseRecipe } = await import('../src/box/test-services.ts');
    const text = JSON.stringify({
      services: [{ name: 'db', image: `postgres@sha256:${'a'.repeat(64)}`, port: 5432, hostPort: 25432 }],
      egress: true,
    });
    const plan = planTestServices({
      instance: 'abcdef0123456789',
      projectKey: 'TOY',
      recipe: parseRecipe(text),
      recipeText: text,
      bridgeImage: `node@sha256:${'d'.repeat(64)}`,
      ceilingEgress: false,
      approved: { recipeSha256: 'x', digests: [] },
    });
    expect(plan.egress).toBe(false);
  });
});

describe('REVIEW S7: devops-outside with devopsRequests auto', () => {
  it('auto: a box shift that asks to leave starts outside at once, with no hold; ask holds it', async () => {
    for (const mode of ['auto', 'ask'] as const) {
      let calls = 0;
      const env = await withRealAuthority(
        async (_input, ctl) => {
          calls++;
          if (calls === 1) {
            await ctl.post('/v1/rpc', {
              method: 'devops.outside',
              params: { needs: 'docker', why: 'compose' },
            });
            await new Promise<void>((r) => ctl.signal.addEventListener('abort', () => r()));
            return;
          }
          await done(ctl);
        },
        { devopsRequests: mode },
      );
      const agentId = uuidv7();
      env.store.update((p) => ({ ...p, devops: { agents: { [ORG]: agentId } } }));
      const msg = devopsMsg(agentId, 'start it');
      env.harness.server.send('shift.start', msg);
      if (mode === 'auto') {
        await env.harness.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 60_000);
        expect(env.adapter.inputs).toHaveLength(2);
        expect(env.adapter.inputs[0]?.devopsBox).toBe(true);
        expect(env.adapter.inputs[1]?.devopsBox).toBeUndefined();
        expect(new HeldStore(env.dir).list()).toEqual([]);
      } else {
        await env.harness.server.waitFor('approvals.held', (m) =>
          m.items.some((i) => i.shiftId === msg.shiftId),
        );
        expect(env.adapter.inputs).toHaveLength(1);
      }
      await h?.stop();
      h = undefined;
    }
  }, 120_000);
});

describe('e2e-found-fixes D2: the same job sent again by the real server, end to end', () => {
  const LOST = /did not complete \(lost\)/;
  const owner = (agentId: string, summary: string) =>
    devopsMsg(agentId, summary, {
      history: [
        { authorName: 'Pieter', kind: 'comment', body: `please: ${summary}`, at: '2026-11-25T06:00:00.000Z' },
      ],
    });

  /** A runner where `msg` was held once (`aom devops-outside`) and approved locally; later starts run `script`. */
  async function approvedOnce(
    summary: string,
    later: (input: ShiftStartInput, ctl: Ctl) => Promise<unknown>,
  ) {
    let calls = 0;
    const env = await withRealAuthority(async (input, ctl) => {
      calls++;
      if (calls === 1) {
        await ctl.post('/v1/rpc', { method: 'devops.outside', params: { needs: 'docker', why: 'compose' } });
        await new Promise<void>((r) => ctl.signal.addEventListener('abort', () => r()));
        return;
      }
      return later(input, ctl);
    });
    const agentId = uuidv7();
    env.store.update((p) => ({ ...p, devops: { agents: { [ORG]: agentId } } }));
    const msg = owner(agentId, summary);
    env.harness.server.send('shift.start', msg);
    const heldMsg = await env.harness.server.waitFor('approvals.held', (m) =>
      m.items.some((i) => i.kind === 'devops.task'),
    );
    const item = heldMsg.items.find((i) => i.kind === 'devops.task');
    await approve(
      { ...defaultCliDeps(env.dir), ask: async () => 'yes', out: () => undefined },
      item?.id as string,
    );
    await env.harness.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 60_000);
    await env.harness.runner.supervisor.whenSettled(msg.shiftId);
    return { env, msg, agentId };
  }
  const requestDir = (env: { harness: Harness }, agentId: string, requestId: string) =>
    join(env.harness.runner.paths.agentDir(agentId), 'devops', requestId);
  const ends = (env: { harness: Harness }, shiftId: string) =>
    env.harness.server.waitFor('shift.ended', (m) => m.shiftId === shiftId, 60_000);

  it('the lost re-send and the identical new request run outside with no hold; the session never sees the "lost" text', async () => {
    const { env, msg } = await approvedOnce('start the app', (_i, ctl) => done(ctl));
    expect(env.adapter.inputs).toHaveLength(2);
    expect(env.adapter.inputs[1]?.prompt).toContain('please: start the app');
    const lost = serverShapedRedispatch(msg, 'lost');
    env.harness.server.send('shift.start', lost);
    await ends(env, lost.shiftId);
    await env.harness.runner.supervisor.whenSettled(lost.shiftId);
    expect(env.adapter.inputs).toHaveLength(3);
    expect(env.adapter.inputs[2]?.devopsBox).toBeUndefined();
    expect(env.adapter.inputs[2]?.devopsGuard).toBeDefined();
    expect(env.adapter.inputs[2]?.prompt).toContain('please: start the app');
    expect(env.adapter.inputs[2]?.prompt).not.toMatch(LOST);
    expect(`${env.adapter.instructions.at(-1)}`).not.toMatch(LOST);
    const fresh = serverShapedRedispatch(msg, 'newRequest');
    env.harness.server.send('shift.start', fresh);
    await ends(env, fresh.shiftId);
    expect(env.adapter.inputs).toHaveLength(4);
    expect(env.adapter.inputs[3]?.devopsBox).toBeUndefined();
    expect(env.adapter.inputs[3]?.cwd).toContain(join('devops', fresh.devops.requestId));
    expect(new HeldStore(env.dir).list().filter((r) => r.state === 'held')).toEqual([]);
    expect(env.harness.server.of('approvals.held').filter((m) => m.items.length > 0)).toHaveLength(1);
  }, 120_000);

  it('B1: under a new request id it goes into the box when that request folder exists, the request was refused, or was seen before', async () => {
    const { env, msg, agentId } = await approvedOnce('start the app', (_i, ctl) => done(ctl));
    // an existing request folder (the request ran here before)
    const b = serverShapedRedispatch(msg, 'newRequest');
    mkdirSync(requestDir(env, agentId, b.devops.requestId), { recursive: true });
    env.harness.server.send('shift.start', b);
    await ends(env, b.shiftId);
    expect(env.adapter.inputs.at(-1)?.devopsBox).toBe(true);
    // an existing temp folder of the request
    const t = serverShapedRedispatch(msg, 'newRequest');
    mkdirSync(join(sandboxFor(env.harness.runner.paths, agentId).tmp, t.devops.requestId), {
      recursive: true,
    });
    env.harness.server.send('shift.start', t);
    await ends(env, t.shiftId);
    expect(env.adapter.inputs.at(-1)?.devopsBox).toBe(true);
    // a request refused on this computer
    const c = serverShapedRedispatch(msg, 'newRequest');
    (env.harness.runner as unknown as { refusedRequests: Map<string, number> }).refusedRequests.set(
      c.devops.requestId,
      Date.now(),
    );
    env.harness.server.send('shift.start', c);
    await ends(env, c.shiftId);
    expect(env.adapter.inputs.at(-1)?.devopsBox).toBe(true);
    // a request seen before (a box shift of another job under it), then the approved body under it
    const d = serverShapedRedispatch(msg, 'newRequest');
    const other = { ...d, devops: { ...d.devops, summary: 'something else' } };
    env.harness.server.send('shift.start', other);
    await ends(env, other.shiftId);
    await env.harness.runner.supervisor.whenSettled(other.shiftId);
    const again = serverShapedRedispatch(d, 'lost');
    rmSync(requestDir(env, agentId, d.devops.requestId), { recursive: true, force: true });
    env.harness.server.send('shift.start', again);
    await ends(env, again.shiftId);
    expect(env.adapter.inputs.at(-1)?.devopsBox).toBe(true);
    expect(new HeldStore(env.dir).list().filter((r) => r.state === 'held')).toEqual([]);
  }, 180_000);

  it('S4: while the approved job runs outside under a request, a second shift of that request is answered busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    let later = 0;
    const { env, msg } = await approvedOnce('start the app', async (_i, ctl) => {
      // the approved run itself ends at once; the next one stays running until released
      if (later++ > 0) {
        started();
        await gate;
      }
      await done(ctl);
    });
    const outside = serverShapedRedispatch(msg, 'lost');
    env.harness.server.send('shift.start', outside);
    await running;
    const box = {
      ...serverShapedRedispatch(msg, 'lost'),
      devops: { ...outside.devops, summary: 'other work' },
    };
    env.harness.server.send('shift.start', box);
    const rejected = await env.harness.server.waitFor('shift.rejected', (m) => m.shiftId === box.shiftId);
    expect(rejected.reason).toBe('busy');
    expect(env.adapter.inputs).toHaveLength(3);
    release();
    await ends(env, outside.shiftId);
  }, 120_000);

  it('REVIEW B-2: after a box shift of the request (another job), the approved job sent again under it goes into the box', async () => {
    const { env, msg } = await approvedOnce('start the app', (_i, ctl) => done(ctl));
    const box = {
      ...serverShapedRedispatch(msg, 'lost'),
      devops: { ...msg.devops, summary: 'write a script there' },
    };
    box.devops.history = msg.devops.history;
    env.harness.server.send('shift.start', box);
    await ends(env, box.shiftId);
    await env.harness.runner.supervisor.whenSettled(box.shiftId);
    expect(env.adapter.inputs.at(-1)?.devopsBox).toBe(true);
    const again = serverShapedRedispatch(msg, 'lost');
    env.harness.server.send('shift.start', again);
    await ends(env, again.shiftId);
    expect(env.adapter.inputs.at(-1)?.devopsBox).toBe(true);
  }, 120_000);

  it('REVIEW S-1: a held shift approved while another shift of its request runs is answered busy, not started', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const env = await withRealAuthority(async (_input, ctl) => {
      calls++;
      if (calls === 1) {
        await ctl.post('/v1/rpc', { method: 'devops.outside', params: { needs: 'docker', why: 'compose' } });
        await new Promise<void>((r) => ctl.signal.addEventListener('abort', () => r()));
        return;
      }
      started();
      await gate;
      await done(ctl);
    });
    const agentId = uuidv7();
    env.store.update((p) => ({ ...p, devops: { agents: { [ORG]: agentId } } }));
    const msg = owner(agentId, 'start the app');
    env.harness.server.send('shift.start', msg);
    const heldMsg = await env.harness.server.waitFor('approvals.held', (m) =>
      m.items.some((i) => i.kind === 'devops.task'),
    );
    const item = heldMsg.items.find((i) => i.kind === 'devops.task');
    // while it waits for the yes, a box shift of the same request starts (the held one is not active)
    const box = { ...serverShapedRedispatch(msg, 'lost'), devops: { ...msg.devops, summary: 'other work' } };
    env.harness.server.send('shift.start', box);
    await running;
    await approve(
      { ...defaultCliDeps(env.dir), ask: async () => 'yes', out: () => undefined },
      item?.id as string,
    );
    const rejected = await env.harness.server.waitFor(
      'shift.rejected',
      (m) => m.shiftId === msg.shiftId && m.reason === 'busy',
      30_000,
    );
    expect(rejected.reason).toBe('busy');
    expect(env.adapter.inputs).toHaveLength(2);
    // REVIEW B-3: the busy answer came before the yes was remembered: nothing is kept for the request
    expect(ApprovedRequests.forRoot(env.harness.dataDir, env.dir).ofRequest(msg.devops.requestId)).toEqual(
      [],
    );
    release();
    await ends(env, box.shiftId);
    await env.harness.runner.supervisor.whenSettled(box.shiftId);
    // ... so the same job sent again under that request does not run outside without a yes
    const again = serverShapedRedispatch(msg, 'lost');
    env.harness.server.send('shift.start', again);
    await waitUntil(() => env.adapter.inputs.length === 3, 30_000, 'the re-sent job starts');
    expect(env.adapter.inputs[2]?.devopsBox).toBe(true);
  }, 120_000);
});
