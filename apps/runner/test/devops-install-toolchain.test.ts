import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TreePins } from '../src/box/tool-box.ts';
import { findPackageManager, runDependencyChange, type ToolGate } from '../src/devops/dependency-install.ts';
import { ensurePolicyKey } from '../src/policy/integrity.ts';
import { type ExecOptions, type Executor, realExecutor } from '../src/toolchain/exec.ts';
import { toolchainHash } from '../src/toolchain/registry.ts';
import { type Harness, startHarness, worktreeOf } from './harness.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const bwrapOk =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', 'true'], { stdio: 'ignore' }).status === 0;

/**
 * uat-runner-fixes-3 finding 1: Forge installed Node 26 / npm 11 at user level and registered it as an agent toolchain
 * (`aom toolchain add`), yet a builder's `aom devops install npm add ...` answered "npm is not installed": the install
 * looked only at the runner's PATH, the fixed user bin folders and Homebrew, never at the registered toolchains.
 */

/** A user-level Node install the way nvm or the official tarball lays it out: bin/node, bin/npm -> the npm package. */
function userNode(parent: string = tmp('aom-node26-')): { root: string; bin: string; npmCli: string } {
  const root = join(parent, 'node-v26.13.1-linux-x64');
  const bin = join(root, 'bin');
  const npmDir = join(root, 'lib', 'node_modules', 'npm');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(npmDir, 'bin'), { recursive: true });
  writeFileSync(join(npmDir, 'package.json'), '{"name":"npm","version":"11.20.0"}\n');
  const npmCli = join(npmDir, 'bin', 'npm-cli.js');
  writeFileSync(npmCli, '#!/usr/bin/env node\n', { mode: 0o755 });
  symlinkSync(join('..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(bin, 'npm'));
  // the toolchain's own Node (a stand-in: the box run is intercepted, it never runs)
  writeFileSync(join(bin, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`, { mode: 0o755 });
  return { root, bin, npmCli: realpathSync(npmCli) };
}

describe('findPackageManager', () => {
  it('looks in the registered toolchains first and pairs the tool with that toolchain Node', () => {
    const n = userNode();
    const r = findPackageManager('npm', { toolchainDirs: [n.bin], realHome: tmp(), path: '/usr/bin:/bin' });
    expect(r).toEqual({
      toolPath: join(n.bin, 'npm'),
      real: n.npmCli,
      nodeExec: realpathSync(join(n.bin, 'node')),
    });
    expect(findPackageManager('npm', { toolchainDirs: [], realHome: tmp(), path: tmp() })).toBeNull();
  });
});

describe('e2e-found-fixes B2: `aom devops install` applies the agents’ PATH pin check', () => {
  const HASH = 'a'.repeat(64);
  /** A guarded (box-writable) root with real tree pins, like `toolBoxWritable` + `TreePins` in the runner. */
  function guarded() {
    // a legacy root (the user's own tool folder): its bin folders keep their own pin (tool-pin-lib S1)
    const root = realpathSync(tmp('aom-guarded-'));
    const policy = tmp('aom-pins-policy-');
    ensurePolicyKey(policy);
    const pins = new TreePins(policy);
    const gate = (waiting: ToolGate['waiting'] = []): ToolGate => ({
      waiting,
      treeOk: (d) => pins.ok(d, { whole: [], legacy: [root] }),
      guardedRootOf: (p) => {
        try {
          const r = realpathSync(p);
          return r === root || r.startsWith(`${root}/`) ? root : null;
        } catch {
          return null;
        }
      },
    });
    return { root, pins, gate };
  }
  /** A plain `npm` file in its own folder. */
  function plainNpm(dir = tmp('aom-npm-')): string {
    writeFileSync(join(dir, 'npm'), '#!/bin/sh\n', { mode: 0o755 });
    return dir;
  }
  const find = (o: { toolchainDirs?: string[]; path?: string; gate: ToolGate }) =>
    findPackageManager('npm', {
      toolchainDirs: o.toolchainDirs ?? [],
      realHome: tmp(),
      path: o.path ?? '/nonexistent',
      gate: () => o.gate,
    });

  it('a tool in a toolchain that waits for the owner is not used, on PATH or in the toolchain list; the answer names the approve step', () => {
    const g = guarded();
    const w = plainNpm();
    const waiting = [{ name: 'node-stub', hash: HASH, dirs: [w] }];
    for (const r of [
      find({ path: w, gate: g.gate(waiting) }),
      find({ toolchainDirs: [w], gate: g.gate(waiting) }),
    ])
      expect(r).toEqual({
        refusal: `\`npm\` is in the tool "node-stub" DevOps registered, which waits for your yes on this computer: run \`guildwise-runner toolchain approve ${HASH}\` (it is on the Desk), then ask again`,
      });
    // registered somewhere no search path reaches: still the approve step, never "not installed"
    expect(find({ gate: g.gate(waiting) })).toMatchObject({
      refusal: expect.stringContaining(`approve ${HASH}`),
    });
    // a link on PATH whose target lies in the waiting toolchain is not used either
    const link = tmp('aom-link-');
    symlinkSync(join(w, 'npm'), join(link, 'npm'));
    expect(find({ path: link, gate: g.gate(waiting) })).toMatchObject({ refusal: expect.any(String) });
  });

  it('another allowed npm is used instead of the waiting one', () => {
    const g = guarded();
    const w = plainNpm();
    const ok = plainNpm();
    const r = find({ path: [w, ok].join(':'), gate: g.gate([{ name: 'node-stub', hash: HASH, dirs: [w] }]) });
    expect(r).toEqual({ toolPath: join(ok, 'npm'), real: realpathSync(join(ok, 'npm')) });
  });

  it('npm in a guarded bin folder whose tree pin no longer matches is not used (refused with the reinstall text)', () => {
    const g = guarded();
    const bin = join(g.root, 'node', 'bin');
    mkdirSync(bin, { recursive: true });
    plainNpm(bin);
    expect(find({ toolchainDirs: [bin], gate: g.gate() })).toMatchObject({
      refusal: expect.stringContaining('changed since it was installed'),
    });
    g.pins.pin([], [bin]);
    expect(find({ toolchainDirs: [bin], gate: g.gate() })).toMatchObject({ toolPath: join(bin, 'npm') });
    // the box changed the folder after the pin
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho changed\n', { mode: 0o755 });
    expect(find({ toolchainDirs: [bin], gate: g.gate() })).toMatchObject({
      refusal: expect.stringContaining('guildwise-runner pending'),
    });
  });

  it('a pinned Node layout (bin/npm -> ../lib/...) is used and its checked real path is what runs', () => {
    const g = guarded();
    const n = userNode(g.root);
    g.pins.pin([], [n.bin]);
    expect(find({ toolchainDirs: [n.bin], gate: g.gate() })).toEqual({
      toolPath: join(n.bin, 'npm'),
      real: n.npmCli,
      nodeExec: realpathSync(join(n.bin, 'node')),
    });
  });

  it('PREREVIEW 1: a toolchain node that is a link is returned as its checked real path (that is what runs)', () => {
    const g = guarded();
    const n = userNode(g.root);
    const nodeReal = join(n.root, 'libexec', 'node');
    mkdirSync(dirname(nodeReal), { recursive: true });
    writeFileSync(nodeReal, '#!/bin/sh\n', { mode: 0o755 });
    rmSync(join(n.bin, 'node'));
    symlinkSync(join('..', 'libexec', 'node'), join(n.bin, 'node'));
    g.pins.pin([], [n.bin]);
    const r = find({ toolchainDirs: [n.bin], gate: g.gate() });
    expect(r).toMatchObject({ nodeExec: realpathSync(nodeReal) });
    expect((r as { nodeExec?: string }).nodeExec).not.toBe(join(n.bin, 'node'));
  });

  it('a link from an unguarded folder into an unpinned guarded folder is not used', () => {
    const g = guarded();
    const n = userNode(g.root);
    const outside = tmp('aom-outside-');
    symlinkSync(n.npmCli, join(outside, 'npm'));
    expect(find({ path: outside, gate: g.gate() })).toMatchObject({ refusal: expect.any(String) });
  });

  it('"the same guarded root" needs a known root on both sides (two nulls never count)', () => {
    const target = plainNpm();
    const d = tmp('aom-cand-');
    symlinkSync(join(target, 'npm'), join(d, 'npm'));
    // the candidate folder passes, the link target's folder does not, and neither has a guarded root
    const gate: ToolGate = { waiting: [], treeOk: (x) => x === d, guardedRootOf: () => null };
    expect(find({ path: d, gate })).toMatchObject({ refusal: expect.any(String) });
  });
});

describe.skipIf(!bwrapOk)('e2e-found-fixes S1: the pin check is read when the tool is looked up', () => {
  it('a toolchain registered (waiting) while the worktree is staged is honoured: nothing runs', async () => {
    const n = userNode();
    const dir = tmp('aom-ws-');
    writeFileSync(join(dir, 'package.json'), '{"name":"toy","private":true}\n');
    let waiting: ToolGate['waiting'] = [];
    let gateReads = 0;
    let installs = 0;
    const exec: Executor = {
      run: async (cmd, args, opts) => {
        if (args.includes('--unshare-all')) {
          const r = await realExecutor.run(cmd, args, opts);
          // DevOps registers the toolchain while the copy-in runs (after the install was asked for)
          waiting = [{ name: 'node-26', hash: 'b'.repeat(64), dirs: [n.bin] }];
          return r;
        }
        installs++;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const r = await runDependencyChange({
      dir,
      repo: 'github.com/o/r',
      change: { tool: 'npm', action: 'install', packages: [] },
      exec,
      scriptsAllowed: false,
      runnerRoot: tmp(),
      realHome: tmp(),
      cacheRoot: tmp(),
      tmpRoot: tmp(),
      parentEnv: { PATH: '/nonexistent' },
      toolchainDirs: [n.bin],
      toolGate: () => {
        gateReads++;
        return { waiting, treeOk: () => true, guardedRootOf: () => null };
      },
    });
    expect(gateReads).toBe(1);
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining(`toolchain approve ${'b'.repeat(64)}`),
    });
    expect(installs).toBe(0);
  });
});

describe.skipIf(!bwrapOk)('PREREVIEW 1: the install runs the checked real path of the toolchain Node', () => {
  it('a linked toolchain node: the box argv carries its real path, not the link', async () => {
    const n = userNode();
    const nodeReal = join(n.root, 'libexec', 'node');
    mkdirSync(dirname(nodeReal), { recursive: true });
    writeFileSync(nodeReal, '#!/bin/sh\n', { mode: 0o755 });
    rmSync(join(n.bin, 'node'));
    symlinkSync(join('..', 'libexec', 'node'), join(n.bin, 'node'));
    const dir = tmp('aom-ws-');
    writeFileSync(join(dir, 'package.json'), '{"name":"toy","private":true}\n');
    const calls: string[][] = [];
    const exec: Executor = {
      run: async (cmd, args, opts) => {
        if (args.includes('--unshare-all')) return realExecutor.run(cmd, args, opts);
        calls.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    await runDependencyChange({
      dir,
      repo: 'github.com/o/r',
      change: { tool: 'npm', action: 'install', packages: [] },
      exec,
      scriptsAllowed: false,
      runnerRoot: tmp(),
      realHome: tmp(),
      cacheRoot: tmp(),
      tmpRoot: tmp(),
      parentEnv: { PATH: '/nonexistent' },
      toolchainDirs: [n.bin],
      toolGate: () => ({ waiting: [], treeOk: () => true, guardedRootOf: () => null }),
    });
    expect(calls).toHaveLength(1);
    const args = calls[0] as string[];
    const argv = args.slice(args.indexOf('--') + 1);
    expect(argv.slice(4, 6)).toEqual([realpathSync(nodeReal), n.npmCli]);
  });
});

describe.skipIf(!bwrapOk)('a builder gets npm through DevOps once DevOps registered the toolchain', () => {
  let h: Harness | undefined;
  const savedPath = process.env.PATH;
  afterEach(async () => {
    process.env.PATH = savedPath;
    await h?.stop();
    h = undefined;
  });

  it('`aom devops install npm add` finds the registered npm and runs it boxed with that toolchain PATH only', async () => {
    const n = userNode();
    const calls: Array<{ args: string[]; opts?: ExecOptions }> = [];
    const executor: Executor = {
      run: async (cmd, args, opts) => {
        if (cmd !== 'bwrap' || args.includes('--unshare-all') || !args.includes('--unshare-net'))
          return realExecutor.run(cmd, args, opts);
        calls.push({ args, ...(opts ? { opts } : {}) });
        const stage = opts?.cwd as string;
        writeFileSync(
          join(stage, 'package.json'),
          `${JSON.stringify({ name: 'toy', devDependencies: { 'left-pad': '1.3.0' } }, null, 2)}\n`,
        );
        writeFileSync(join(stage, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
        return { exitCode: 0, stdout: 'added 1 package', stderr: '' };
      },
    };
    // the runner's own PATH has no npm (a service PATH: the system folders only)
    process.env.PATH = '/usr/bin:/bin';
    expect(spawnSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).stdout.trim()).not.toMatch(/npm$/);
    h = await startHarness({}, { executor });
    // what Forge did on the devbox: `aom toolchain add node-26 --bin <node>/bin`
    const added = h.runner.toolchains.add({ name: 'node-26', bin: [n.bin] });
    // ... and the owner approved it on the workstation (runner-authority-fixes T2: `guildwise-runner toolchain approve`)
    h.runner.toolchains.pinned = (hash) => hash === toolchainHash(added);
    const { ended } = await h.runShift({ stage: 'build', ref: 'TOY-1', mock: { build: ['deps_install'] } });
    expect(ended.outcome).toBe('reported');
    const answer = readFileSync(join(worktreeOf(h), '.guildwise-mock', 'deps-install.txt'), 'utf8');
    expect(answer).not.toContain('npm is not installed');
    expect(answer.split('\n')[0]).toBe('0');
    expect(calls).toHaveLength(1);
    const c = calls[0] as { args: string[]; opts?: ExecOptions };
    const argv = c.args.slice(c.args.indexOf('--') + 1);
    // the registered toolchain's node and npm-cli.js, not the runner's own Node
    const nodeBin = realpathSync(n.bin);
    expect(argv.slice(4, 6)).toEqual([join(nodeBin, 'node'), n.npmCli]);
    const box = c.args.slice(0, c.args.indexOf('--')).join(' ');
    expect(box).toContain('--unshare-net');
    // the npm package folder is re-opened read-only, exactly
    expect(box).toContain(`--ro-bind ${dirname(dirname(n.npmCli))} ${dirname(dirname(n.npmCli))}`);
    const env = c.opts?.env as Record<string, string>;
    expect(env.PATH).toBe([nodeBin, '/usr/local/bin', '/usr/bin', '/bin'].join(':'));
  }, 90_000);

  it('e2e-found-fixes Observation 2: a registered toolchain the owner has not approved yet is not run; the answer names the approve step', async () => {
    const n = userNode();
    const calls: string[][] = [];
    const executor: Executor = {
      run: async (cmd, args, opts) => {
        if (cmd !== 'bwrap' || args.includes('--unshare-all') || !args.includes('--unshare-net'))
          return realExecutor.run(cmd, args, opts);
        calls.push(args);
        return { exitCode: 0, stdout: 'added 1 package', stderr: '' };
      },
    };
    process.env.PATH = '/usr/bin:/bin';
    h = await startHarness({}, { executor });
    // nothing is pinned on this computer: the entry DevOps registers waits for `guildwise-runner toolchain approve`
    h.runner.toolchains.pinned = () => false;
    const added = h.runner.toolchains.add({ name: 'node-26', bin: [n.bin] });
    expect(h.runner.toolchains.isWaiting(added)).toBe(true);
    const { ended } = await h.runShift({ stage: 'build', ref: 'TOY-1', mock: { build: ['deps_install'] } });
    expect(ended.outcome).toBe('reported');
    const answer = readFileSync(join(worktreeOf(h), '.guildwise-mock', 'deps-install.txt'), 'utf8');
    expect(answer.split('\n')[0]).not.toBe('0');
    expect(answer).toContain(`guildwise-runner toolchain approve ${toolchainHash(added)}`);
    expect(calls).toHaveLength(0);
  }, 90_000);
});
