import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Installs that run no repository code (R18-S [rv3-2, rv4-3]): `env.ensure` and worktree preparation run a dependency
 * install by themselves only in these exact modes. Everything else (Bundler, `dotnet restore`, Gradle, Maven, pip, Poetry,
 * uv, CocoaPods, Mix, sbt, any unknown tool) is refused unless the workstation owner allowed that repository locally
 * (`guildwise-runner repo allow-scripts <url>`, policy.json `installScripts`), which restores the normal install.
 *
 * Why: a card can make an agent edit `package.json` (a `postinstall`), `.pnpmfile.cjs`, `.yarnrc.yml` (`yarnPath`,
 * `plugins`), a Gemfile, MSBuild targets or a Gradle build, and the install then runs that code outside the sandbox.
 */

export type InstallPlan =
  | { ok: true; cmd: string; args: string[]; env: Record<string, string>; scriptFree: boolean }
  | { ok: false; reason: string };

export const allowScriptsHint = (repo: string): string =>
  `allow scripts for ${repo} on the workstation: \`guildwise-runner repo allow-scripts ${repo}\``;

/** Corepack and pnpm never switch to the package manager version a repository's `packageManager` names. */
const NO_PM_SWITCH: Record<string, string> = {
  COREPACK_ENABLE_STRICT: '0',
  COREPACK_ENABLE_AUTO_PIN: '0',
  npm_config_manage_package_manager_versions: 'false',
};

const withFlags = (args: string[], flags: string[]): string[] => [
  ...args,
  ...flags.filter((f) => !args.includes(f)),
];

/** `.yarnrc.yml` lists plugins (code Yarn Berry loads before anything else). */
function yarnPlugins(dir: string): boolean {
  try {
    return /^\s*plugins\s*:/m.test(readFileSync(join(dir, '.yarnrc.yml'), 'utf8'));
  } catch {
    return false;
  }
}

/**
 * How a dependency step runs in `dir`. `scriptsAllowed`: the repository is in policy.json `installScripts` (the step then
 * runs as written). Otherwise only the proven script-free modes run, with their flags forced on.
 */
export function planInstall(
  step: { cmd: string; args: string[] },
  dir: string,
  repo: string,
  scriptsAllowed: boolean,
): InstallPlan {
  if (scriptsAllowed) return { ok: true, cmd: step.cmd, args: step.args, env: {}, scriptFree: false };
  const tool = basename(step.cmd).replace(/\.(cmd|exe|bat)$/i, '');
  const sub = step.args[0] ?? '';
  if (tool === 'npm' && (sub === 'ci' || sub === 'install' || sub === 'i'))
    return {
      ok: true,
      cmd: step.cmd,
      // `--git=git`: a project `.npmrc` `git=<path>` would run that program for git dependencies even with
      // --ignore-scripts (the command line wins over the project config)
      args: withFlags(step.args, ['--ignore-scripts', '--git=git']),
      env: { ...NO_PM_SWITCH },
      scriptFree: true,
    };
  if (tool === 'pnpm' && (sub === 'install' || sub === 'i'))
    return {
      ok: true,
      cmd: step.cmd,
      // `packageManager` must not make pnpm (9.7+) or corepack fetch and run another package manager the repo names
      args: withFlags(step.args, [
        '--ignore-scripts',
        '--ignore-pnpmfile',
        '--config.manage-package-manager-versions=false',
      ]),
      env: { ...NO_PM_SWITCH },
      scriptFree: true,
    };
  if (tool === 'yarn' && (sub === '' || sub === 'install')) {
    const berry = existsSync(join(dir, '.yarnrc.yml'));
    if (berry && yarnPlugins(dir))
      return {
        ok: false,
        reason: `.yarnrc.yml loads Yarn plugins (repository code): ${allowScriptsHint(repo)}`,
      };
    return {
      ok: true,
      cmd: step.cmd,
      args: withFlags(
        step.args.length ? step.args : ['install'],
        berry ? ['--mode=skip-build'] : ['--ignore-scripts'],
      ),
      // never the Yarn binary the repository points at (`yarnPath`)
      env: { YARN_IGNORE_PATH: '1', ...NO_PM_SWITCH },
      scriptFree: true,
    };
  }
  if (tool === 'composer' && sub === 'install')
    return {
      ok: true,
      cmd: step.cmd,
      args: withFlags(step.args, ['--no-scripts', '--no-plugins']),
      env: {},
      scriptFree: true,
    };
  if (tool === 'go' && sub === 'mod' && step.args[1] === 'download' && step.args.length === 2)
    return { ok: true, cmd: step.cmd, args: step.args, env: {}, scriptFree: true };
  if (tool === 'cargo' && sub === 'fetch' && step.args.length === 1) {
    // a repository `.cargo/config(.toml)` can name a credential provider or other programs cargo runs
    if (existsSync(join(dir, '.cargo', 'config')) || existsSync(join(dir, '.cargo', 'config.toml')))
      return {
        ok: false,
        reason: `the repository has a .cargo/config (it can make cargo run programs): ${allowScriptsHint(repo)}`,
      };
    return { ok: true, cmd: step.cmd, args: step.args, env: {}, scriptFree: true };
  }
  return {
    ok: false,
    reason: `\`${[tool, ...step.args].join(' ')}\` can run repository code (build scripts, plugins, MSBuild targets): ${allowScriptsHint(repo)}`,
  };
}
