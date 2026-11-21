import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planInstall } from '../src/policy/installs.ts';

const REPO = 'github.com/acme/app';
const dir = () => mkdtempSync(join(tmpdir(), 'aom-install-'));

describe('installs that run no repository code (R18-S [rv3-2, rv4-3])', () => {
  it('npm and pnpm always get --ignore-scripts (pnpm also --ignore-pnpmfile): a prepare or a .pnpmfile.cjs never runs', () => {
    expect(planInstall({ cmd: 'npm', args: ['ci'] }, dir(), REPO, false)).toMatchObject({
      ok: true,
      args: ['ci', '--ignore-scripts', '--git=git'],
    });
    expect(planInstall({ cmd: 'pnpm', args: ['install'] }, dir(), REPO, false)).toMatchObject({
      ok: true,
      args: [
        'install',
        '--ignore-scripts',
        '--ignore-pnpmfile',
        '--config.manage-package-manager-versions=false',
      ],
    });
  });

  it('config gadgets: a project .npmrc git= program, packageManager switching, a repo .cargo/config (round-1 should-fix 2)', () => {
    const npm = planInstall({ cmd: 'npm', args: ['install'] }, dir(), REPO, false);
    expect(npm.ok && npm.args).toContain('--git=git');
    for (const step of [
      { cmd: 'npm', args: ['ci'] },
      { cmd: 'pnpm', args: ['install'] },
      { cmd: 'yarn', args: ['install'] },
    ]) {
      const r = planInstall(step, dir(), REPO, false);
      expect(r.ok && r.env).toMatchObject({
        COREPACK_ENABLE_STRICT: '0',
        npm_config_manage_package_manager_versions: 'false',
      });
    }
    const cargo = dir();
    mkdirSync(join(cargo, '.cargo'));
    writeFileSync(join(cargo, '.cargo', 'config.toml'), '[registry]\ncredential-provider = ["./evil"]\n');
    expect(planInstall({ cmd: 'cargo', args: ['fetch'] }, cargo, REPO, false)).toMatchObject({ ok: false });
  });

  it('Yarn ignores yarnPath (YARN_IGNORE_PATH=1); Berry skips builds and refuses plugins; classic ignores scripts', () => {
    const classic = dir();
    expect(planInstall({ cmd: 'yarn', args: ['install'] }, classic, REPO, false)).toMatchObject({
      ok: true,
      args: ['install', '--ignore-scripts'],
      env: { YARN_IGNORE_PATH: '1' },
    });
    const berry = dir();
    writeFileSync(join(berry, '.yarnrc.yml'), 'yarnPath: .yarn/releases/evil.cjs\n');
    expect(planInstall({ cmd: 'yarn', args: ['install'] }, berry, REPO, false)).toMatchObject({
      ok: true,
      args: ['install', '--mode=skip-build'],
      env: { YARN_IGNORE_PATH: '1' },
    });
    writeFileSync(join(berry, '.yarnrc.yml'), 'plugins:\n  - path: .yarn/plugins/evil.cjs\n');
    expect(planInstall({ cmd: 'yarn', args: ['install'] }, berry, REPO, false)).toMatchObject({ ok: false });
  });

  it('composer runs without scripts and plugins; go mod download and cargo fetch run as they are', () => {
    expect(planInstall({ cmd: 'composer', args: ['install'] }, dir(), REPO, false)).toMatchObject({
      args: ['install', '--no-scripts', '--no-plugins'],
    });
    expect(planInstall({ cmd: 'go', args: ['mod', 'download'] }, dir(), REPO, false)).toMatchObject({
      ok: true,
    });
    expect(planInstall({ cmd: 'cargo', args: ['fetch'] }, dir(), REPO, false)).toMatchObject({ ok: true });
  });

  it('Bundler, dotnet restore, Gradle, Maven, pip, Poetry, uv and unknown tools are refused without the repo opt-in', () => {
    for (const step of [
      { cmd: 'bundle', args: ['install'] },
      { cmd: 'dotnet', args: ['restore'] },
      { cmd: './gradlew', args: ['dependencies'] },
      { cmd: './mvnw', args: ['-B', '-q', 'dependency:resolve'] },
      { cmd: 'pip', args: ['install', '-r', 'requirements.txt'] },
      { cmd: 'poetry', args: ['install'] },
      { cmd: 'uv', args: ['sync'] },
      { cmd: 'mix', args: ['deps.get'] },
      { cmd: 'npm', args: ['run', 'build'] },
    ]) {
      const r = planInstall(step, dir(), REPO, false);
      expect(r).toMatchObject({ ok: false });
      expect(r.ok ? '' : r.reason).toContain(`guildwise-runner repo allow-scripts ${REPO}`);
    }
  });

  it('the per-repo opt-in restores the normal install', () => {
    expect(planInstall({ cmd: 'dotnet', args: ['restore'] }, dir(), REPO, true)).toEqual({
      ok: true,
      cmd: 'dotnet',
      args: ['restore'],
      env: {},
      scriptFree: false,
    });
    expect(planInstall({ cmd: 'npm', args: ['install'] }, dir(), REPO, true)).toMatchObject({
      args: ['install'],
    });
  });
});
