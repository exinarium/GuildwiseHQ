import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Keeps package managers off the network in the check sandbox (handoff checks and the worktree preparation). A check must
 * never download anything: pnpm 11+ verifies the install state before every `pnpm run` and starts an install (lockfile
 * verification against supply-chain policies, then tarball fetches with retries) when the worktree's `node_modules` is
 * missing or stale; `npx <missing>` fetches the package. With no network those steps retry until the check's time limit.
 * With these variables they fail at once with a plain message (`biome: not found`, `ERR_PNPM_NO_OFFLINE_META`,
 * `ENOTCACHED`), which the judging reports as a missing tool.
 *
 * Both prefixes are set for pnpm: pnpm 8-10 read `npm_config_*`, pnpm 11+ read only `pnpm_config_*`.
 */
export const OFFLINE_ENV: Readonly<Record<string, string>> = Object.freeze({
  // pnpm 11+
  pnpm_config_verify_deps_before_run: 'false',
  pnpm_config_offline: 'true',
  pnpm_config_fetch_retries: '0',
  // npm, npx, and pnpm up to 10
  npm_config_verify_deps_before_run: 'false',
  npm_config_offline: 'true',
  npm_config_fetch_retries: '0',
  npm_config_yes: 'false',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
  // Yarn Berry
  YARN_ENABLE_NETWORK: '0',
  YARN_ENABLE_OFFLINE_MODE: '1',
  // Corepack: never download a package manager
  COREPACK_ENABLE_NETWORK: '0',
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  // Python
  UV_OFFLINE: '1',
  PIP_NO_INDEX: '1',
});

/**
 * The offline variables plus `COREPACK_HOME` at the real home's corepack cache when it exists: the sandbox's HOME is a
 * throwaway, so a host where pnpm comes only from corepack would find no cached pnpm and (offline) fail. The real home is
 * readable in the sandbox (`--ro-bind /`); its credential folders stay masked.
 */
export function offlineEnv(
  realHome?: string,
  exists: (p: string) => boolean = existsSync,
): Record<string, string> {
  const out: Record<string, string> = { ...OFFLINE_ENV };
  if (realHome) {
    const corepack = join(realHome, '.cache', 'node', 'corepack');
    if (exists(corepack)) out.COREPACK_HOME = corepack;
  }
  return out;
}

/**
 * The worktree preparation installs from the shared package store only (offline, no network namespace). pnpm's offline
 * install cannot re-verify the lockfile against its supply-chain policies (that needs registry metadata), so the
 * preparation trusts the committed lockfile. Switched by the runner config `prepTrustLockfile` (default on).
 */
export const TRUST_LOCKFILE_ENV: Readonly<Record<string, string>> = Object.freeze({
  pnpm_config_trust_lockfile: 'true',
  npm_config_trust_lockfile: 'true',
});

/**
 * The argv a check runs with: `dotnet format` gets `--no-restore` (its implicit restore downloads packages; the worktree
 * preparation does the restore). Everything else is unchanged.
 */
export function offlineArgv(argv: readonly string[]): string[] {
  const out = [...argv];
  const tool = basename(out[0] ?? '').replace(/\.exe$/i, '');
  if (tool === 'dotnet' && out[1] === 'format' && !out.includes('--no-restore')) out.push('--no-restore');
  return out;
}
