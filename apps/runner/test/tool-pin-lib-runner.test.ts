import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ROLES, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { TreePins } from '../src/box/tool-box.ts';
import { type PolicyCliDeps, toolchainTrust } from '../src/policy/cli.ts';
import { ensurePolicyKey } from '../src/policy/integrity.ts';
import { TOOL_FOLDER_CHANGED } from '../src/toolchain/ensure.ts';
import { noteOutside, resetEnsureLockForTests, withEnsureLock } from '../src/toolchain/ensure-lock.ts';
import type { ExecResult, Executor } from '../src/toolchain/exec.ts';
import { realExecutor } from '../src/toolchain/exec.ts';
import type { ToolchainRegistry } from '../src/toolchain/registry.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, makeRepo, tmp } from './helpers.ts';
import { grantedAuthority } from './test-authority.ts';

cleanupTmp();

/**
 * tool-pin-lib in the runner: env.ensure runs one at a time, installs nothing from a Guildwise tool folder that changed,
 * raises one trust step for it (never for a folder a run in flight verified), pins in `finally`, and an approved outside
 * run overlapping it re-approves nothing that changed (S6).
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
  resetEnsureLockForTests();
});

type Hook = (cmd: string, args: string[]) => Promise<ExecResult | undefined> | ExecResult | undefined;

/** git runs for real; the box command is unwrapped (`bwrap ... -- cmd args`) and handed to `hook`; the rest is missing. */
function machine(hook: Hook = () => undefined): Executor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(cmd, args, o): Promise<ExecResult> {
      if (cmd === 'git') return realExecutor.run(cmd, args, o);
      let c = cmd;
      let a = args;
      if (cmd === 'bwrap') {
        const i = args.indexOf('--');
        c = args[i + 1] ?? '';
        a = args.slice(i + 2);
      }
      calls.push([c, ...a].join(' '));
      return (await hook(c, a)) ?? { exitCode: 127, stdout: '', stderr: 'not found' };
    },
  };
}

function world() {
  const policyDir = tmp('aom-tplr-policy-');
  ensurePolicyKey(policyDir);
  const tc = join(tmp('aom-tplr-'), 'toolchains');
  mkdirSync(join(tc, 'bin'), { recursive: true });
  writeFileSync(join(tc, 'bin', 'tool'), '#!/bin/sh\n', { mode: 0o755 });
  const repo = makeRepo();
  writeFileSync(join(repo.clone, 'go.mod'), 'module x\n\ngo 1.22\n');
  return { policyDir, tc, repo };
}

const send = (command: string, payload: Record<string, unknown>) => {
  const commandId = uuidv7();
  h?.server.send('command', { commandId, command, payload });
  return h?.server.waitFor('command.result', (m) => m.commandId === commandId, 60_000) as Promise<{
    ok: boolean;
    error?: string;
    result: { tools: Array<{ tool: string; status: string; detail?: string }> };
  }>;
};

/** `allowInstall` only where nothing would download (no real network in tests): a refused or blocked install. */
const ensure = (repoNormalized: string, allowInstall = false) =>
  send('env.ensure', {
    requestId: uuidv7(),
    projectId: uuidv7(),
    repos: [{ repoId: uuidv7(), name: 'toy', remoteUrlNormalized: repoNormalized }],
    access: { allowInstall, allowDocker: false, allowedPaths: [], sudo: false },
  });

/** Review S1: the first start pins the tool folder asynchronously; wait for it before changing the folder. */
async function adopted(policyDir: string, tc: string): Promise<void> {
  const until = Date.now() + 10_000;
  while (!new TreePins(policyDir).read().roots[tc] && Date.now() < until)
    await new Promise((r) => setTimeout(r, 20));
}

/** The runner's open local steps of the trust kind. */
const trustSteps = () =>
  (
    (h as Harness).runner as unknown as {
      approvals: { listSteps(): Array<{ kind: string; args: string[] }> };
    }
  ).approvals
    .listSteps()
    .filter((s) => s.kind === 'toolchain.trust');

describe.skipIf(process.platform !== 'linux')('tool-pin-lib in the runner', () => {
  it('a changed Guildwise folder: nothing installed, one trust step bound to its content; the yes clears it', async () => {
    const w = world();
    const m = machine();
    h = await startHarness(
      {},
      { executor: m, platform: 'linux', policyDir: w.policyDir, toolchainsRoot: w.tc },
      w.repo,
    );
    // adopted as it was at the first start; then changed outside Guildwise's installs
    await adopted(w.policyDir, w.tc);
    writeFileSync(join(w.tc, 'bin', 'tool'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
    const r = await ensure(w.repo.remoteNormalized, true);
    expect(r.result.tools.find((t) => t.tool === 'Go')).toMatchObject({
      status: 'failed',
      detail: TOOL_FOLDER_CHANGED,
    });
    expect(m.calls.filter((c) => c.startsWith('go '))).toEqual([]);
    const steps = trustSteps();
    expect(steps).toHaveLength(1);
    const pins = new TreePins(w.policyDir);
    const now = pins.fullHash(w.tc);
    expect(steps[0]?.args).toEqual([(now as { hash: string }).hash]);
    // the owner's yes on the computer
    await toolchainTrust(
      {
        store: { dir: w.policyDir },
        out: () => {},
        ask: async () => 'yes',
        treePins: () => pins,
        guardRoots: () => ({ whole: [w.tc], legacy: [] }),
        logsDir: () => tmp(),
      } as unknown as PolicyCliDeps,
      steps[0]?.args[0] as string,
    );
    (h.runner as unknown as { recheckTreeSteps(): void }).recheckTreeSteps();
    expect(trustSteps()).toEqual([]);
  });

  it('a spawn while a run installs gets no trust step and is told why; the run pins at its end', async () => {
    const w = world();
    let resolved: { offNote?: string; dropped: string[] } | undefined;
    const m = machine((cmd) => {
      if (cmd === 'go') {
        // the recipe box writes the folder; a helper starts meanwhile
        writeFileSync(join(w.tc, 'bin', 'go'), '#!/bin/sh\n', { mode: 0o755 });
        const reg = ((h as Harness).runner as unknown as { toolchains: ToolchainRegistry }).toolchains;
        reg.add({ name: 'mine', bin: [join(w.tc, 'bin')], read: [], env: {} }, 'owner');
        resolved = reg.resolve();
        return { exitCode: 127, stdout: '', stderr: 'not found' };
      }
      return undefined;
    });
    h = await startHarness(
      {},
      { executor: m, platform: 'linux', policyDir: w.policyDir, toolchainsRoot: w.tc },
      w.repo,
    );
    await ensure(w.repo.remoteNormalized);
    expect(resolved?.dropped).toContain('mine');
    expect(resolved?.offNote).toContain('environment preparation is installing tools');
    expect(trustSteps()).toEqual([]);
    const pins = new TreePins(w.policyDir);
    expect(pins.status(w.tc).state).toBe('ok');
  });

  it('finally pins after a throw', async () => {
    const w = world();
    const m = machine((cmd) => {
      if (cmd === 'go') {
        writeFileSync(join(w.tc, 'bin', 'go'), '#!/bin/sh\n', { mode: 0o755 });
        throw new Error('boom');
      }
      return undefined;
    });
    h = await startHarness(
      {},
      { executor: m, platform: 'linux', policyDir: w.policyDir, toolchainsRoot: w.tc },
      w.repo,
    );
    const r = await ensure(w.repo.remoteNormalized);
    expect(r.ok).toBe(false);
    expect(new TreePins(w.policyDir).status(w.tc).state).toBe('ok');
  });

  it('S6: an approved outside run overlapping the run: the changed folder is not approved again and the step is raised', async () => {
    const w = world();
    const m = machine((cmd) => {
      if (cmd === 'go') writeFileSync(join(w.tc, 'bin', 'go'), '#!/bin/sh\n', { mode: 0o755 });
      return undefined;
    });
    h = await startHarness(
      {},
      { executor: m, platform: 'linux', policyDir: w.policyDir, toolchainsRoot: w.tc },
      w.repo,
    );
    noteOutside(1);
    try {
      const r = await ensure(w.repo.remoteNormalized, true);
      // and no user-space install ran meanwhile
      expect(r.result.tools.find((t) => t.tool === 'Go')?.detail).toContain(
        'outside the safety box is active',
      );
    } finally {
      noteOutside(-1);
    }
    expect(new TreePins(w.policyDir).status(w.tc).state).toBe('changed');
    expect(trustSteps()).toHaveLength(1);
  });

  it('two env.ensure calls run one after the other', async () => {
    const w = world();
    let inside = 0;
    let most = 0;
    const m = machine(async (cmd) => {
      if (cmd === 'go') {
        inside++;
        most = Math.max(most, inside);
        await new Promise((r) => setTimeout(r, 200));
        inside--;
      }
      return undefined;
    });
    h = await startHarness(
      {},
      { executor: m, platform: 'linux', policyDir: w.policyDir, toolchainsRoot: w.tc },
      w.repo,
    );
    await Promise.all([ensure(w.repo.remoteNormalized), ensure(w.repo.remoteNormalized)]);
    expect(m.calls.filter((c) => c.startsWith('go ')).length).toBeGreaterThanOrEqual(2);
    expect(most).toBe(1);
  });

  it('pre-review 4: an open trust step clears by itself once the folder verifies again (the periodic recheck)', async () => {
    const w = world();
    h = await startHarness(
      {},
      {
        executor: machine(),
        platform: 'linux',
        policyDir: w.policyDir,
        toolchainsRoot: w.tc,
        treeRecheckMs: 100,
      },
      w.repo,
    );
    await adopted(w.policyDir, w.tc);
    const f = join(w.tc, 'bin', 'tool');
    writeFileSync(f, '#!/bin/sh\necho planted\n', { mode: 0o755 });
    await ensure(w.repo.remoteNormalized);
    expect(trustSteps()).toHaveLength(1);
    // put back as it was: no one calls the recheck, the timer does
    writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 });
    const until = Date.now() + 5_000;
    while (trustSteps().length && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    expect(trustSteps()).toEqual([]);
  });

  it('pre-review 4: the box `aom toolchain ensure` answers at once while another environment preparation runs', async () => {
    const w = world();
    h = await startHarness(
      {},
      {
        executor: machine(),
        platform: 'linux',
        policyDir: w.policyDir,
        toolchainsRoot: w.tc,
        authority: grantedAuthority({ toolInstall: true }),
      },
      w.repo,
    );
    let release!: () => void;
    const busy = withEnsureLock(() => new Promise<void>((r) => (release = r)));
    const runner = h.runner as unknown as {
      toolchainEnsure(msg: unknown, tool: string): Promise<{ ok: boolean; error?: string }>;
    };
    const answer = await Promise.race([
      runner.toolchainEnsure({ devops: { card: { remoteUrlNormalized: w.repo.remoteNormalized } } }, 'go'),
      new Promise<{ ok: boolean; error?: string }>((r) =>
        setTimeout(() => r({ ok: false, error: 'no answer in 3 s' }), 3_000),
      ),
    ]);
    release();
    await busy;
    expect(answer).toEqual({
      ok: false,
      error: 'waiting for another environment preparation on this computer: ask again in a few minutes',
    });
  });

  it('pre-review 1: a user tool folder whose pinned bin folder changed is not mounted in the boxes', async () => {
    const w = world();
    const cargo = join(homedir(), '.cargo');
    mkdirSync(join(cargo, 'bin'), { recursive: true });
    writeFileSync(join(cargo, 'bin', 'cargo'), '#!/bin/sh\n', { mode: 0o755 });
    try {
      const boxes: string[][] = [];
      const m = machine();
      const run = m.run.bind(m);
      m.run = async (cmd, args, o) => {
        if (cmd === 'bwrap') boxes.push(args);
        return run(cmd, args, o);
      };
      // adopted (pinned as it is) at the first start
      h = await startHarness(
        {},
        { executor: m, platform: 'linux', policyDir: w.policyDir, toolchainsRoot: w.tc },
        w.repo,
      );
      const mounted = () => boxes.some((a) => a.some((x, i) => x === '--ro-bind' && a[i + 1] === cargo));
      await ensure(w.repo.remoteNormalized);
      expect(mounted()).toBe(true);
      writeFileSync(join(cargo, 'bin', 'cargo'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
      boxes.length = 0;
      await ensure(w.repo.remoteNormalized);
      expect(boxes.length).toBeGreaterThan(0);
      expect(mounted()).toBe(false);
    } finally {
      rmSync(cargo, { recursive: true, force: true });
    }
  });

  it('review S1: the first start without a pin file reads the tool folder asynchronously before it pins it, with no Desk step', async () => {
    const w = world();
    const order: string[] = [];
    const proto = TreePins.prototype;
    const { warm, pin } = proto;
    proto.warm = function (this: TreePins, r: string) {
      if (r === w.tc) order.push('warm tc');
      return warm.call(this, r);
    };
    proto.pin = function (this: TreePins, roots, bins, expect) {
      if (roots.includes(w.tc)) order.push('pin tc');
      return pin.call(this, roots, bins, expect);
    };
    try {
      h = await startHarness(
        {},
        { executor: machine(), platform: 'linux', policyDir: w.policyDir, toolchainsRoot: w.tc },
        w.repo,
      );
      const until = Date.now() + 10_000;
      while (!order.includes('pin tc') && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    } finally {
      proto.warm = warm;
      proto.pin = pin;
    }
    expect(order[0]).toBe('warm tc');
    expect(order).toContain('pin tc');
    expect(order.indexOf('warm tc')).toBeLessThan(order.indexOf('pin tc'));
    expect(new TreePins(w.policyDir).status(w.tc).state).toBe('ok');
    expect(trustSteps()).toEqual([]);
  });

  it('review S3: a chat turn resolves the toolchains (and so checks the tool folder) once', async () => {
    const w = world();
    h = await startHarness({}, { policyDir: w.policyDir, toolchainsRoot: w.tc }, w.repo);
    const reg = (h.runner as unknown as { toolchains: ToolchainRegistry }).toolchains;
    let calls = 0;
    const resolve = reg.resolve.bind(reg);
    reg.resolve = () => {
      calls++;
      return resolve();
    };
    const builder = BUILTIN_ROLES.find((r) => r.key === 'builder');
    const msg = {
      chatId: uuidv7(),
      threadId: uuidv7(),
      agent: {
        agentId: uuidv7(),
        name: 'Ada',
        roleKey: 'builder',
        seniority: 'junior',
        runtime: 'mock',
        model: 'mock',
        skills: [],
        permissions: builder?.permissions,
        isDevops: false,
      },
      message: 'hello',
      context: {},
    };
    h.server.send('chat.start', msg as never);
    await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    expect(calls).toBe(1);
  });
});
