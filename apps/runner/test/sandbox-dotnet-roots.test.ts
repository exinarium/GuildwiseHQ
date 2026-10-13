import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { buildShiftSettings } from '../src/adapters/claude-policy.ts';
import { runnerPaths } from '../src/paths.ts';
import { DOTNET_SHM_DIR, ensureSandbox, sandboxEnv } from '../src/sandbox/sandbox.ts';
import { selectDotnet } from '../src/toolchain/dotnet.ts';
import { agentPath, ToolchainRegistry } from '../src/toolchain/registry.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { policyCtx } from './policy-fixtures.ts';

cleanupTmp();

const builder = BUILTIN_ROLES.find((r) => r.key === 'builder');
const sel = selectDotnet();
const bwrap = process.platform === 'linux' && existsSync('/usr/bin/bwrap') ? '/usr/bin/bwrap' : undefined;
const bwrapWorks =
  bwrap !== undefined &&
  spawnSync(bwrap, ['--ro-bind', '/', '/', '--dev', '/dev', 'true'], { encoding: 'utf8' }).status === 0;
const has = (major: number) =>
  !!sel.chosen?.sdks.some((v) => v.startsWith(`${major}.`)) &&
  !!sel.chosen?.runtimes.some((v) => v.startsWith(`${major}.`));

/**
 * The owner's machine: `/usr/local/bin/dotnet` (SDK 8 only) is first on the service PATH while `~/.dotnet` holds 8 and
 * 10. With the registry the sandboxed agent gets the root that holds both. /home is hidden (tmpfs) like the sandbox's
 * read block, with only the toolchain roots the registry opens bound back in.
 */
describe.skipIf(!bwrapWorks || !sel.chosen || process.platform !== 'linux')(
  'chosen .NET root in a real bubblewrap sandbox (skipped without bwrap or dotnet)',
  () => {
    const build = async (tfm: string) => {
      const root = realpathSync(tmp());
      const paths = runnerPaths(root);
      const sb = await ensureSandbox(paths, '019e3f6a-7b1c-7a2d-8c3e-0123456789a1', 'Ada');
      const reg = new ToolchainRegistry(paths.toolchains, root, () => ({ toolchainPaths: [] }));
      const tc = reg.resolve();
      const cwd = join(root, 'worktrees', 'P-1', 'X-1');
      mkdirSync(cwd, { recursive: true });
      writeFileSync(
        join(cwd, 'app.csproj'),
        `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>${tfm}</TargetFramework></PropertyGroup></Project>`,
      );
      writeFileSync(
        join(cwd, 'Program.cs'),
        'System.Console.WriteLine($"hello {System.Environment.Version.Major}");\n',
      );
      const policy = buildShiftSettings(
        (builder as NonNullable<typeof builder>).permissions,
        policyCtx({
          runnerRoot: root,
          agentDir: paths.agentDir('019e3f6a-7b1c-7a2d-8c3e-0123456789a1'),
          cwd,
          gitDirs: [],
          sharedCacheDir: sb.cacheRoot,
          dotnetShmDir: DOTNET_SHM_DIR,
          toolchainReadPaths: tc.readDirs,
        }),
        sb,
        'builder',
      );
      const fs = policy.sandbox?.filesystem;
      const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
      // the read block: nothing under /home is visible except the toolchain roots the policy allows
      const home = homedir();
      if (home.startsWith('/home/')) {
        args.push('--tmpfs', '/home');
        // the policy also opens the user's NuGet packages (read-only fallback folder)
        const nuget = join(home, '.nuget', 'packages');
        const opened = [...tc.readDirs, ...(existsSync(nuget) ? [nuget] : [])];
        for (const r of opened.filter((d) => d.startsWith('/home/') && existsSync(d)))
          args.push('--ro-bind', r, r);
      }
      for (const w of (fs?.allowWrite ?? []).filter((p) => existsSync(p))) args.push('--bind', w, w);
      args.push('--bind', cwd, cwd, '--chdir', cwd);
      const env = {
        PATH: agentPath(tc, paths.bin, process.env.PATH),
        ...sandboxEnv(sb, undefined, tc.env),
      };
      const r = spawnSync(
        bwrap as string,
        [
          ...args,
          'bash',
          '-c',
          'dotnet --list-sdks; dotnet build -nologo 2>&1 | tail -15 && dotnet bin/Debug/*/app.dll',
        ],
        {
          env,
          encoding: 'utf8',
          timeout: 180_000,
        },
      );
      return { r, fs, tc };
    };

    it('the policy opens the chosen root for reading and the env points DOTNET_ROOT at it', async () => {
      const { fs, tc } = await build(has(8) ? 'net8.0' : 'net10.0');
      expect(tc.env.DOTNET_ROOT).toBe(sel.chosen?.root);
      expect(tc.pathDirs[0]).toBe(sel.chosen?.root);
      expect(fs?.allowRead).toContain(sel.chosen?.root);
    }, 200_000);

    it.skipIf(!has(8))(
      'builds and runs a net8.0 project',
      async () => {
        const { r } = await build('net8.0');
        expect(r.stdout, r.stderr).toContain('Build succeeded');
        expect(r.stdout).toContain('hello 8');
      },
      200_000,
    );

    it.skipIf(!has(10))(
      'builds and runs a net10.0 project (the system dotnet in front has no SDK 10)',
      async () => {
        const { r } = await build('net10.0');
        expect(r.stdout, r.stderr).toContain('Build succeeded');
        expect(r.stdout).toContain('hello 10');
        expect(r.stdout).toMatch(/^10\.\d+\.\d+ \[/m);
      },
      200_000,
    );
  },
);
