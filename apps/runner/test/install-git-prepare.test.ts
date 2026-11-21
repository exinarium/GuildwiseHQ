import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planInstall } from '../src/policy/installs.ts';

/**
 * [rv5-9]: a git dependency whose `prepare` script would run on install. The script-free plan (R18-S) must keep it from
 * running with the real npm and pnpm. Local git+file remotes only, no network.
 */
const has = (bin: string) => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0;

function fixture(): { root: string; app: string; marker: string } {
  const root = mkdtempSync(join(tmpdir(), 'aom-gitdep-'));
  const marker = join(root, 'MARKER');
  const dep = join(root, 'dep');
  mkdirSync(dep);
  writeFileSync(
    join(dep, 'package.json'),
    JSON.stringify({
      name: 'dep',
      version: '1.0.0',
      scripts: { prepare: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"` },
    }),
  );
  const g = (args: string[]) => spawnSync('git', args, { cwd: dep, stdio: 'ignore' });
  g(['init', '-q']);
  g(['add', '.']);
  g(['-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  const app = join(root, 'app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { dep: `git+file://${dep}` } }),
  );
  return { root, app, marker };
}

describe('a git dependency with a prepare script never runs it (script-free installs)', () => {
  it.skipIf(!has('npm'))(
    'npm install',
    () => {
      const f = fixture();
      const plan = planInstall({ cmd: 'npm', args: ['install'] }, f.app, 'x/app', false);
      if (!plan.ok) throw new Error(plan.reason);
      spawnSync(plan.cmd, [...plan.args, '--no-audit', '--no-fund'], {
        cwd: f.app,
        stdio: 'ignore',
        timeout: 120_000,
        env: { ...process.env, ...plan.env, npm_config_cache: join(f.root, 'npm-cache') },
      });
      expect(existsSync(f.marker)).toBe(false);
    },
    150_000,
  );

  it.skipIf(!has('pnpm'))(
    'pnpm install',
    () => {
      const f = fixture();
      const plan = planInstall({ cmd: 'pnpm', args: ['install'] }, f.app, 'x/app', false);
      if (!plan.ok) throw new Error(plan.reason);
      spawnSync(plan.cmd, plan.args, {
        cwd: f.app,
        stdio: 'ignore',
        timeout: 120_000,
        env: { ...process.env, ...plan.env, npm_config_store_dir: join(f.root, 'pnpm-store') },
      });
      expect(existsSync(f.marker)).toBe(false);
    },
    150_000,
  );

  it.skipIf(!has('npm'))(
    'npm install with a project .npmrc naming another git program never runs it',
    () => {
      const f = fixture();
      const evil = join(f.root, 'evil-git.sh');
      writeFileSync(evil, `#!/bin/sh\necho ran > ${JSON.stringify(f.marker)}\nexec git "$@"\n`, {
        mode: 0o755,
      });
      writeFileSync(join(f.app, '.npmrc'), `git=${evil}\n`);
      const plan = planInstall({ cmd: 'npm', args: ['install'] }, f.app, 'x/app', false);
      if (!plan.ok) throw new Error(plan.reason);
      spawnSync(plan.cmd, [...plan.args, '--no-audit', '--no-fund'], {
        cwd: f.app,
        stdio: 'ignore',
        timeout: 120_000,
        env: { ...process.env, ...plan.env, npm_config_cache: join(f.root, 'npm-cache') },
      });
      expect(existsSync(f.marker)).toBe(false);
    },
    150_000,
  );
});
