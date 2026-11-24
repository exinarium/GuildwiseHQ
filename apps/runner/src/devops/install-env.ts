/**
 * Install scripts off in DevOps sessions (runner-authority-fixes T4, D4). A builder may write `package.json` scripts,
 * `.npmrc`, `.pnpmfile.cjs` or `.yarnrc.yml` in its card worktree; the DevOps engineer runs unsandboxed, so an install
 * it runs later must not execute them. Its shift and chat environments carry these variables, so npm, pnpm and Yarn
 * Berry skip lifecycle scripts, pnpmfiles and repository-pinned package manager binaries. Yarn 1, Bun and Composer have
 * no environment switch that is safe for every version: the guard refuses their install commands without the
 * script-free flag while this is on (`installScriptGuard`).
 *
 * Skipped only for a DevOps shift whose every repository is in policy.json `installScripts` (the owner allowed scripts
 * there); a DevOps chat always gets it. Residual (stated in the design): `npm run build`, `npm test`, Bundler and pip
 * still run repository code; this switch covers installs only.
 */

/** Corepack and pnpm never switch to the package manager version a repository's `packageManager` names. */
export const NO_PM_SWITCH: Record<string, string> = {
  COREPACK_ENABLE_STRICT: '0',
  COREPACK_ENABLE_AUTO_PIN: '0',
  npm_config_manage_package_manager_versions: 'false',
};

export const INSTALL_SCRIPTS_OFF_ENV: Record<string, string> = {
  npm_config_ignore_scripts: 'true',
  pnpm_config_ignore_scripts: 'true',
  npm_config_ignore_pnpmfile: 'true',
  pnpm_config_ignore_pnpmfile: 'true',
  npm_config_verify_deps_before_run: 'false',
  pnpm_config_verify_deps_before_run: 'false',
  // a git dependency is fetched with plain git, never a program a repository's .npmrc names
  npm_config_git: 'git',
  // Yarn 2+: no lifecycle scripts, never the yarn binary a repository points at (`yarnPath`)
  YARN_ENABLE_SCRIPTS: 'false',
  YARN_IGNORE_PATH: '1',
  ...NO_PM_SWITCH,
};

/** The marker the guard reads (through its config) to know scripts are off in this session. */
export function withInstallScriptsOff(env: Record<string, string>): Record<string, string> {
  return { ...env, ...INSTALL_SCRIPTS_OFF_ENV };
}

/**
 * Whether a DevOps shift's environment gets scripts off: yes unless it names at least one repository and the owner
 * allowed install scripts for every one of them.
 */
export function installScriptsOffFor(
  repos: ReadonlyArray<{ remoteUrlNormalized: string }> | undefined,
  allowed: (remote: string) => boolean,
): boolean {
  if (!repos || repos.length === 0) return true;
  return !repos.every((r) => allowed(r.remoteUrlNormalized));
}
