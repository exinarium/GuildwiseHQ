import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectStacks, scanRepoFiles, viewOf } from '../src/toolchain/detect.ts';
import { versionAtLeast } from '../src/toolchain/ensure.ts';
import { STACKS, TOOLS } from '../src/toolchain/stacks.ts';
import type { Platform } from '../src/toolchain/types.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/** A fixture repository on disk. */
function fixture(files: Record<string, string>): string {
  const root = tmp('aom-fixture-');
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}

const detect = (files: Record<string, string>, platform: Platform = 'linux') =>
  detectStacks(viewOf(fixture(files), platform));
const ids = (files: Record<string, string>, platform: Platform = 'linux') =>
  detect(files, platform).map((d) => d.id);
/** Tool ids the table asks for, per stack of the fixture. */
const toolsOf = (files: Record<string, string>, platform: Platform = 'linux') => {
  const out = new Set<string>();
  for (const d of detect(files, platform))
    for (const t of STACKS.find((s) => s.id === d.id)?.tools(d, platform) ?? []) out.add(t);
  return [...out];
};

const MAUI_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net8.0-android;net8.0-ios;net8.0-maccatalyst</TargetFrameworks>
    <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net8.0-windows10.0.19041.0</TargetFrameworks>
    <UseMaui>true</UseMaui>
    <SingleProject>true</SingleProject>
  </PropertyGroup>
</Project>`;

describe('toolchain: stack detection', () => {
  it('recognizes a .NET MAUI app from <UseMaui> and its target frameworks, and reports it instead of plain .NET', () => {
    const d = detect({ 'src/App/App.csproj': MAUI_CSPROJ, 'App.sln': '' });
    expect(d.map((x) => x.id)).toEqual(['dotnet-maui']);
    expect(d[0]?.params).toMatchObject({ sdkMajor: '8', android: '1', ios: '1', maccatalyst: '1' });
    expect(d[0]?.evidence).toBe('src/App/App.csproj');
  });

  it('recognizes MAUI from a Microsoft.Maui package reference alone', () => {
    const csproj = `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net9.0-android</TargetFramework></PropertyGroup>
      <ItemGroup><PackageReference Include="Microsoft.Maui.Controls" Version="9.0.0" /></ItemGroup></Project>`;
    const d = detect({ 'App.csproj': csproj });
    expect(d.map((x) => x.id)).toEqual(['dotnet-maui']);
    expect(d[0]?.params).toMatchObject({ sdkMajor: '9', android: '1' });
    expect(d[0]?.params.ios).toBeUndefined();
  });

  it('asks for the right workloads per platform: maui-android on Linux, maui + android + ios on macOS', () => {
    const files = { 'App.csproj': MAUI_CSPROJ };
    expect(toolsOf(files, 'linux')).toEqual(['dotnet-sdk', 'dotnet-workload-maui-android', 'jdk']);
    expect(toolsOf(files, 'darwin')).toEqual([
      'dotnet-sdk',
      'dotnet-workload-maui',
      'dotnet-workload-android',
      'dotnet-workload-ios',
      'dotnet-workload-maccatalyst',
      'jdk',
    ]);
    expect(toolsOf(files, 'win32')).toEqual([
      'dotnet-sdk',
      'dotnet-workload-maui',
      'dotnet-workload-android',
      'jdk',
    ]);
  });

  it('plain .NET: SDK major from global.json wins over the target framework', () => {
    const d = detect({
      'global.json': '{ "sdk": { "version": "9.0.101", "rollForward": "latestFeature" } }',
      'Api/Api.csproj':
        '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
    });
    expect(d.map((x) => x.id)).toEqual(['dotnet']);
    expect(d[0]?.params.sdkMajor).toBe('9');
  });

  it('plain .NET without global.json: the highest target framework; .NET Framework gives no version', () => {
    expect(
      detect({
        'a/A.csproj':
          '<Project><PropertyGroup><TargetFrameworks>net6.0;net8.0</TargetFrameworks></PropertyGroup></Project>',
      })[0]?.params.sdkMajor,
    ).toBe('8');
    expect(
      detect({
        'a.csproj':
          '<Project><PropertyGroup><TargetFramework>net48</TargetFramework></PropertyGroup></Project>',
      })[0]?.params.sdkMajor,
    ).toBeUndefined();
  });

  it('a .NET project is not MAUI just because it has a platform target framework', () => {
    expect(
      ids({
        'W.csproj':
          '<Project><PropertyGroup><TargetFramework>net8.0-windows10.0.19041.0</TargetFramework></PropertyGroup></Project>',
      }),
    ).toEqual(['dotnet']);
  });

  it('Node: package manager from packageManager, else the lock file; node major from .nvmrc, else engines', () => {
    const a = detect({
      'package.json': JSON.stringify({ packageManager: 'pnpm@9.12.0', engines: { node: '>=18' } }),
      '.nvmrc': 'v22.11.0\n',
      'pnpm-lock.yaml': '',
    });
    expect(a[0]?.params).toMatchObject({ pm: 'pnpm', pmVersion: '9.12.0', nodeMajor: '22' });
    const b = detect({ 'package.json': '{"engines":{"node":">=20.1"}}', 'yarn.lock': '' });
    expect(b[0]?.params).toMatchObject({ pm: 'yarn', nodeMajor: '20' });
    const c = detect({ 'package.json': '{}', 'package-lock.json': '' });
    expect(c[0]?.params.pm).toBe('npm');
    expect(toolsOf({ 'package.json': '{}', 'bun.lockb': '' })).toEqual(['node', 'node-bun']);
    expect(toolsOf({ 'package.json': '{}', 'package-lock.json': '' })).toEqual(['node']);
  });

  it('Node: a broken package.json is still a Node project; .tool-versions gives the version', () => {
    const d = detect({ 'package.json': '{not json', '.tool-versions': 'nodejs 20.10.0\npython 3.12.1\n' });
    expect(d.map((x) => x.id)).toEqual(['node']);
    expect(d[0]?.params.nodeMajor).toBe('20');
  });

  it('Python: uv, poetry and pipenv are told apart; the version comes from .python-version or requires-python', () => {
    expect(
      detect({ 'pyproject.toml': '[project]\nrequires-python = ">=3.11"\n', 'uv.lock': '' })[0]?.params,
    ).toMatchObject({
      manager: 'uv',
      pythonVersion: '3.11',
    });
    expect(
      detect({ 'pyproject.toml': '[tool.poetry]\nname="x"\n', '.python-version': '3.12.4\n' })[0]?.params,
    ).toMatchObject({
      manager: 'poetry',
      pythonVersion: '3.12',
    });
    expect(detect({ Pipfile: '' })[0]?.params.manager).toBe('pipenv');
    expect(toolsOf({ 'requirements-dev.txt': 'pytest' })).toEqual(['python', 'python-venv']);
    expect(toolsOf({ 'pyproject.toml': '[tool.poetry]\n' })).toEqual([
      'python',
      'python-venv',
      'python-poetry',
    ]);
  });

  it('Docker: Dockerfile, compose files in any common spelling, also in a subfolder', () => {
    for (const f of [
      'Dockerfile',
      'api/Dockerfile.dev',
      'docker-compose.yml',
      'compose.yaml',
      'docker-compose.prod.yaml',
    ])
      expect(ids({ [f]: '' }), f).toEqual(['docker']);
    expect(toolsOf({ Dockerfile: '' })).toEqual(['docker', 'docker-daemon']);
    expect(ids({ 'notes/Dockerfile.md': '' })).toEqual([]);
  });

  it('Go, Rust, Ruby, PHP: one marker file each; Go reads the language version', () => {
    expect(detect({ 'go.mod': 'module x\n\ngo 1.22.1\n' })[0]).toMatchObject({
      id: 'go',
      params: { goVersion: '1.22' },
    });
    expect(ids({ 'Cargo.toml': '[package]\n' })).toEqual(['rust']);
    expect(toolsOf({ Gemfile: '' })).toEqual(['ruby', 'bundler']);
    expect(toolsOf({ 'composer.json': '{}' })).toEqual(['php', 'composer']);
  });

  it('Java: Maven reads the release; a Gradle/Maven wrapper means the build tool itself is not needed', () => {
    const pom =
      '<project><properties><maven.compiler.release>21</maven.compiler.release></properties></project>';
    expect(detect({ 'pom.xml': pom })[0]?.params.javaMajor).toBe('21');
    expect(toolsOf({ 'pom.xml': pom })).toEqual(['jdk', 'maven']);
    expect(toolsOf({ 'pom.xml': pom, mvnw: '' })).toEqual(['jdk']);
    const gradle = 'java { sourceCompatibility = JavaVersion.VERSION_17 }';
    expect(detect({ 'build.gradle': gradle })[0]?.params.javaMajor).toBe('17');
    expect(toolsOf({ 'build.gradle.kts': '', gradlew: '' })).toEqual(['jdk']);
    expect(toolsOf({ 'settings.gradle': '' })).toEqual(['jdk', 'gradle']);
  });

  it('a monorepo reports every stack it contains, once each', () => {
    const files = {
      'package.json': '{}',
      'pnpm-lock.yaml': '',
      'server/Dockerfile': '',
      'tools/pyproject.toml': 'x', // too deep for a root marker: only root markers count for python
      'mobile/App.csproj': MAUI_CSPROJ,
    };
    expect(ids(files)).toEqual(['dotnet-maui', 'node', 'docker']);
  });

  it('skips dependency and build folders and stops at depth 3', () => {
    const root = fixture({
      'node_modules/foo/package.json': '{}',
      'a/b/c/d/Deep.csproj': '<Project/>',
      'obj/Debug/X.csproj': '<Project/>',
      'src/Ok.csproj':
        '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
    });
    const files = scanRepoFiles(root);
    expect(files).toEqual(['src/Ok.csproj']);
  });

  it('an empty repository needs nothing', () => {
    expect(ids({ 'README.md': '# hi' })).toEqual([]);
  });

  it('every tool a stack names exists in the tool table, and every tool has a manual fix text', () => {
    const samples: Array<Record<string, string>> = [
      { 'App.csproj': MAUI_CSPROJ },
      { 'package.json': '{"packageManager":"pnpm@9"}' },
      { 'package.json': '{}', 'yarn.lock': '' },
      { 'package.json': '{}', 'bun.lockb': '' },
      { 'pyproject.toml': '[tool.uv]\n' },
      { 'pyproject.toml': '[tool.poetry]\n' },
      { Pipfile: '' },
      { Dockerfile: '' },
      { 'go.mod': 'go 1.22' },
      { 'Cargo.toml': '' },
      { 'pom.xml': '<project/>' },
      { 'build.gradle': '' },
      { Gemfile: '' },
      { 'composer.json': '{}' },
    ];
    for (const platform of ['linux', 'darwin', 'win32'] as const)
      for (const s of samples) for (const t of toolsOf(s, platform)) expect(TOOLS[t], t).toBeDefined();
    for (const t of Object.values(TOOLS)) {
      expect(t.manual, t.id).toBeTypeOf('function');
      for (const platform of ['linux', 'darwin', 'win32'] as const) {
        expect(t.checks({}, platform).length, `${t.id} checks`).toBeGreaterThan(0);
        // a recipe table is computed without throwing for any platform
        expect(() => t.recipes({}, platform), `${t.id} recipes`).not.toThrow();
      }
    }
  });
});

describe('toolchain: install recipes', () => {
  const recipes = (tool: string, p: Record<string, string>, platform: Platform) =>
    TOOLS[tool]?.recipes(p, platform) ?? {};

  it('.NET SDK: the version is part of every installer, the script needs no administrator rights', () => {
    const r = recipes('dotnet-sdk', { sdkMajor: '9' }, 'linux');
    expect(r.apt?.[0]).toMatchObject({
      cmd: 'apt-get',
      args: ['install', '-y', 'dotnet-sdk-9.0'],
      root: true,
    });
    expect(r.brew?.[0]?.args).toEqual(['install', 'dotnet@9']);
    expect(r.winget?.[0]?.args).toContain('Microsoft.DotNet.SDK.9');
    expect(r.any?.[0]?.args.join(' ')).toContain('dotnet-install.sh --channel 9.0');
    expect(r.any?.[0]?.root).toBeUndefined();
    expect(recipes('dotnet-sdk', {}, 'win32').any).toBeUndefined();
  });

  it('MAUI workloads install with `dotnet workload install <id>`', () => {
    expect(recipes('dotnet-workload-maui', {}, 'darwin').any).toEqual([
      { cmd: 'dotnet', args: ['workload', 'install', 'maui'] },
    ]);
    expect(recipes('dotnet-workload-maui-android', {}, 'linux').any?.[0]?.args).toEqual([
      'workload',
      'install',
      'maui-android',
    ]);
  });

  it('pnpm is pinned to the version the repository asks for', () => {
    expect(recipes('node-pnpm', { pmVersion: '9.12.0' }, 'linux').any?.[0]?.args).toEqual([
      'install',
      '-g',
      'pnpm@9.12.0',
    ]);
  });

  it('only system-wide package managers need root', () => {
    expect(recipes('go', {}, 'linux').apt?.[0]?.root).toBe(true);
    expect(recipes('go', {}, 'darwin').brew?.[0]?.root).toBeUndefined();
  });
});

describe('versionAtLeast', () => {
  it.each([
    ['8.0.100', '8', true],
    ['9.0', '8', true],
    ['7.0.400', '8', false],
    ['1.22.1', '1.22', true],
    ['1.21.9', '1.22', false],
    ['3.12', '3.12', true],
    ['20', '22', false],
  ])('%s >= %s is %s', (have, want, expected) => {
    expect(versionAtLeast(have, want)).toBe(expected);
  });
});
