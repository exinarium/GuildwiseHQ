import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findPackageManager } from '../src/devops/dependency-install.ts';
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
function userNode(): { root: string; bin: string; npmCli: string } {
  const root = join(tmp('aom-node26-'), 'node-v26.13.1-linux-x64');
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
    expect(r).toEqual({ toolPath: join(n.bin, 'npm'), nodeExec: join(n.bin, 'node') });
    expect(findPackageManager('npm', { toolchainDirs: [], realHome: tmp(), path: tmp() })).toBeNull();
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
});
