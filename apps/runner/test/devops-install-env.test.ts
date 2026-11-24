import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planDependencyChange } from '../src/devops/dependency-install.ts';
import { classifyCommand, defaultGuardConfig, type GuardConfig } from '../src/devops/guard.ts';
import {
  INSTALL_SCRIPTS_OFF_ENV,
  installScriptsOffFor,
  withInstallScriptsOff,
} from '../src/devops/install-env.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, makeRepo, tmp } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';
import { makeDevopsStart } from './vault-fixtures.ts';

/**
 * runner-authority-fixes T4 (AC6): a builder can write package.json lifecycle scripts, `.npmrc` or a pnpmfile in its
 * card worktree, but installs that follow never run them: `aom devops install` runs script-free (flags beat the
 * repository's `.npmrc`), and the DevOps engineer's own sessions run with install scripts off.
 */

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const has = (tool: string) => spawnSync(tool, ['--version'], { encoding: 'utf8' }).status === 0;

/** A project whose own postinstall and whose local dependency's postinstall each leave a marker; `.npmrc` turns scripts on. */
function scriptedProject(): { dir: string; markers: () => string[] } {
  const dir = tmp();
  mkdirSync(join(dir, 'dep'));
  writeFileSync(
    join(dir, 'dep', 'package.json'),
    JSON.stringify({
      name: 'dep',
      version: '1.0.0',
      scripts: {
        postinstall: "node -e \"require('fs').writeFileSync(process.env.INIT_CWD + '/DEP_RAN', 'x')\"",
      },
    }),
  );
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'app',
      version: '1.0.0',
      dependencies: { dep: 'file:./dep' },
      scripts: { postinstall: "node -e \"require('fs').writeFileSync('APP_RAN', 'x')\"" },
    }),
  );
  // a builder-written .npmrc that tries to turn scripts back on
  writeFileSync(join(dir, '.npmrc'), 'ignore-scripts=false\n');
  return { dir, markers: () => ['APP_RAN', 'DEP_RAN'].filter((m) => existsSync(join(dir, m))) };
}

const run = (cmd: string, args: string[], cwd: string, env: Record<string, string>) =>
  spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, npm_config_offline: 'true', ...env },
  });

describe('AC6: installs after a builder never run builder-written lifecycle scripts', () => {
  it.skipIf(!has('npm'))('control: without the switch, npm runs both postinstall scripts', () => {
    const p = scriptedProject();
    const r = run('npm', ['install', '--no-audit', '--no-fund'], p.dir, {});
    expect(r.status, r.stderr).toBe(0);
    expect(p.markers().sort()).toEqual(['APP_RAN', 'DEP_RAN']);
  });

  it.skipIf(!has('npm'))(
    'the `aom devops install` path (planDependencyChange, script-free) runs none, .npmrc notwithstanding',
    () => {
      const p = scriptedProject();
      const plan = planDependencyChange(
        { tool: 'npm', action: 'install', packages: [] },
        p.dir,
        'github.com/o/r',
        false,
      );
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const r = run(plan.cmd, [...plan.args, '--no-audit', '--no-fund'], p.dir, plan.env);
      expect(r.status, r.stderr).toBe(0);
      expect(p.markers()).toEqual([]);
    },
  );

  it.skipIf(!has('npm'))(
    'a DevOps session environment (npm install) runs none, .npmrc notwithstanding',
    () => {
      const p = scriptedProject();
      const r = run('npm', ['install', '--no-audit', '--no-fund'], p.dir, withInstallScriptsOff({}));
      expect(r.status, r.stderr).toBe(0);
      expect(p.markers()).toEqual([]);
    },
  );

  it.skipIf(!has('pnpm'))('a DevOps session environment (pnpm install) runs none', () => {
    const p = scriptedProject();
    const r = run('pnpm', ['install', '--no-frozen-lockfile'], p.dir, withInstallScriptsOff({}));
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(p.markers()).toEqual([]);
  });

  it('the environment carries the npm, pnpm and Yarn 2+ switches and the corepack pins', () => {
    const env = withInstallScriptsOff({ PATH: '/bin' });
    expect(env).toMatchObject({
      PATH: '/bin',
      npm_config_ignore_scripts: 'true',
      pnpm_config_ignore_scripts: 'true',
      npm_config_ignore_pnpmfile: 'true',
      YARN_ENABLE_SCRIPTS: 'false',
      YARN_IGNORE_PATH: '1',
      COREPACK_ENABLE_STRICT: '0',
    });
    // Yarn 2+ refuses unknown YARN_ settings, so Yarn 1's switch is never put in the environment (the guard asks for the flag)
    expect(Object.keys(INSTALL_SCRIPTS_OFF_ENV)).not.toContain('YARN_IGNORE_SCRIPTS');
  });

  it('scripts stay on only when the owner allowed them for every repository of the request', () => {
    const allowed = (r: string) => r === 'github.com/o/allowed';
    expect(installScriptsOffFor(undefined, allowed)).toBe(true);
    expect(installScriptsOffFor([], allowed)).toBe(true);
    expect(installScriptsOffFor([{ remoteUrlNormalized: 'github.com/o/allowed' }], allowed)).toBe(false);
    expect(
      installScriptsOffFor(
        [{ remoteUrlNormalized: 'github.com/o/allowed' }, { remoteUrlNormalized: 'github.com/o/other' }],
        allowed,
      ),
    ).toBe(true);
  });
});

describe('T4 S-A/S-B: the guard asks for the script-free flag where no env switch exists', () => {
  const cfg: GuardConfig = { ...defaultGuardConfig('shift'), installScriptsOff: true };
  const verdict = (c: string, g: GuardConfig = cfg) => classifyCommand(c, g, '/tmp');

  it.each([
    'bun install',
    'bun i',
    'bun add left-pad',
    'bun a left-pad',
    'bun update',
    'bun remove x',
    'bun rm x',
    'bun link',
    'bun pm trust --all',
    'bun pm trust esbuild --ignore-scripts',
    'yarn',
    'yarn install',
    'yarn add left-pad',
    'yarn global add x',
    'composer install',
    'composer update --no-scripts',
    'composer require x/y --no-plugins',
  ])('refuses `%s`', (c) => {
    const v = verdict(c);
    expect(v.decision).toBe('refused');
    expect(v.rule).toBe('install_scripts');
  });

  it.each([
    'bun install --ignore-scripts',
    'bun add left-pad --ignore-scripts',
    'bun run build',
    'yarn install --ignore-scripts',
    'yarn install --mode=skip-build',
    'yarn build',
    'composer install --no-scripts --no-plugins',
    'npm install',
    'pnpm install',
  ])('allows `%s`', (c) => {
    expect(verdict(c).decision).toBe('allowed');
  });

  it('without the switch (the owner allowed scripts for every repository) bun install is not refused for scripts', () => {
    expect(verdict('bun install', defaultGuardConfig('shift')).rule).not.toBe('install_scripts');
  });
});

describe('T4: the DevOps shift environment and guard', () => {
  async function devopsShift(installScriptsAllowed?: (r: string) => boolean, postAsRepos: string[] = []) {
    const repo = makeRepo();
    const adapter = new ScriptedAdapter(async () => {});
    h = await startHarness(
      {},
      {
        adapters: new Map([['mock', adapter]]),
        supervisorOverrides: installScriptsAllowed ? { installScriptsAllowed } : {},
      },
      repo,
    );
    const base = makeDevopsStart({ summary: 'install the tools' }) as Record<string, any>;
    const msg: Record<string, any> = {
      ...base,
      ...(postAsRepos.length
        ? {
            postAs: {
              repos: postAsRepos.map((r) => ({
                repoId: '0b9f3c0e-1d2a-4c1b-9a51-6f0e2a7d8c12',
                remoteUrlNormalized: r,
                source: 'project',
                projectKey: 'GWP',
              })),
            },
          }
        : {}),
    };
    h.server.send('shift.start', msg);
    await h.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 60_000);
    await h.runner.supervisor.whenSettled(msg.shiftId);
    return adapter.inputs[0];
  }

  it('a DevOps shift runs with install scripts off and tells its guard', async () => {
    const input = await devopsShift();
    expect(input?.env.npm_config_ignore_scripts).toBe('true');
    expect(input?.env.YARN_ENABLE_SCRIPTS).toBe('false');
    expect(input?.devopsGuard?.installScriptsOff).toBe(true);
  });

  it('scripts stay on when the owner allowed them for every repository of the request', async () => {
    const input = await devopsShift((r) => r === 'github.com/o/r', ['github.com/o/r']);
    expect(input?.env.npm_config_ignore_scripts).toBeUndefined();
    expect(input?.devopsGuard?.installScriptsOff).toBeUndefined();
  });

  it('one repository without the owner allowing it keeps scripts off', async () => {
    const input = await devopsShift((r) => r === 'github.com/o/r', ['github.com/o/r', 'github.com/o/x']);
    expect(input?.env.npm_config_ignore_scripts).toBe('true');
  });
});
