import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { depsBoxPlan, toolBoxExecutor } from '../src/box/tool-box.ts';
import { realExecutor } from '../src/toolchain/exec.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/**
 * tool-pin-lib: real installs work in the deps box with every tool folder read-only (caches in the box home, output in the
 * clone), and a write into a tool folder fails. Each tool is skipped when this computer does not have it.
 */

const bwrapOk =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', 'true'], { stdio: 'ignore' }).status === 0;

const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const dotnet = join(userInfo().homedir, '.dotnet', 'dotnet');
const uv = join(userInfo().homedir, '.cache', 'aom-video', 'venv', 'bin', 'uv');
const uvOk = existsSync(uv) && existsSync('/usr/bin/python3');
const dotnetOk = existsSync(dotnet) && spawnSync(dotnet, ['--list-sdks']).stdout?.toString().includes('10.0');

function box(root: string) {
  const base = realpathSync(tmp('aom-tplbox-'));
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  return { repo, ex: toolBoxExecutor(realExecutor, depsBoxPlan([root], repo, home)) };
}

describe.skipIf(!bwrapOk)('the deps box with read-only tool folders (real bubblewrap)', () => {
  it('npm install runs (Node from a read-only folder); a write into the folder is refused', async () => {
    const b = box(nodeRoot);
    writeFileSync(join(b.repo, 'package.json'), '{"name":"toy","version":"1.0.0","private":true}\n');
    const r = await b.ex.run(join(nodeRoot, 'bin', 'npm'), ['install', '--no-audit', '--no-fund'], {
      cwd: b.repo,
      timeoutMs: 120_000,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(existsSync(join(b.repo, 'package-lock.json'))).toBe(true);
    const w = await b.ex.run('/bin/sh', ['-c', `touch ${join(nodeRoot, 'planted')}`], { cwd: b.repo });
    expect(w.exitCode).not.toBe(0);
    expect(w.stderr).toMatch(/Read-only file system/);
    expect(existsSync(join(nodeRoot, 'planted'))).toBe(false);
  }, 180_000);

  it.skipIf(!dotnetOk)(
    'dotnet restore runs with ~/.dotnet read-only (NuGet and first-use files in the box home)',
    async () => {
      const root = dirname(dotnet);
      const b = box(root);
      writeFileSync(
        join(b.repo, 'toy.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n',
      );
      // (the newest SDK: the 8.0 SDK's NuGet-Migrations mutex fails in any bubblewrap box, read-only or not: the known
      // sandbox-caches failure)
      const r = await b.ex.run(dotnet, ['restore'], {
        cwd: b.repo,
        timeoutMs: 240_000,
        env: { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_ROOT: root },
      });
      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(existsSync(join(b.repo, 'obj', 'project.assets.json'))).toBe(true);
      const w = await b.ex.run('/bin/sh', ['-c', `touch ${join(root, 'planted')}`], { cwd: b.repo });
      expect(w.stderr).toMatch(/Read-only file system/);
    },
    300_000,
  );

  it.skipIf(!uvOk)(
    'uv sync runs with uv in a read-only folder (system Python, no download; cache in the box home)',
    async () => {
      const root = dirname(dirname(uv));
      const b = box(root);
      writeFileSync(
        join(b.repo, 'pyproject.toml'),
        '[project]\nname = "toy"\nversion = "0.1.0"\nrequires-python = ">=3.8"\ndependencies = []\n',
      );
      const r = await b.ex.run(uv, ['sync', '--python', '/usr/bin/python3', '--no-python-downloads'], {
        cwd: b.repo,
        timeoutMs: 120_000,
        env: { UV_NO_PROGRESS: '1' },
      });
      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(existsSync(join(b.repo, '.venv'))).toBe(true);
      const w = await b.ex.run('/bin/sh', ['-c', `touch ${join(root, 'planted')}`], { cwd: b.repo });
      expect(w.stderr).toMatch(/Read-only file system/);
    },
    180_000,
  );
});
