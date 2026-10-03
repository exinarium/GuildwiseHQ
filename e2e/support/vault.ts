import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from './env.ts';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Vault Editor',
  GIT_AUTHOR_EMAIL: 'editor@e2e.test',
  GIT_COMMITTER_NAME: 'Vault Editor',
  GIT_COMMITTER_EMAIL: 'editor@e2e.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });

export interface VaultFixture {
  /** Bare origin: the vault URL registered on the site (a local path, never a real remote). */
  origin: string;
  /** Another machine's clone: edits made here reach the runner through sync. */
  other: string;
}

/** Bare origin seeded with `files` plus a second clone; everything under `<E2E_DIR>/vaults/<name>`. */
export function makeVault(name: string, files: Record<string, string>): VaultFixture {
  const root = join(paths.vaults, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const origin = join(root, 'origin.git');
  const other = join(root, 'other');
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'clone', origin, other);
  git(other, 'checkout', '-b', 'main');
  for (const [path, content] of Object.entries(files)) writeVaultFile(other, path, content);
  git(other, 'add', '-A');
  git(other, 'commit', '-m', 'seed');
  git(other, 'push', '-u', 'origin', 'main');
  return { origin, other };
}

export function writeVaultFile(dir: string, path: string, content: string): void {
  const file = join(dir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Commits and pushes an edit from the other machine (pulls first: the runner may have pushed meanwhile). */
export function pushFromOther(v: VaultFixture, path: string, content: string, msg = `edit ${path}`): void {
  git(v.other, 'pull', '--rebase', 'origin', 'main');
  writeVaultFile(v.other, path, content);
  git(v.other, 'add', '-A');
  git(v.other, 'commit', '-m', msg);
  git(v.other, 'push', 'origin', 'main');
}

export const originFile = (v: VaultFixture, path: string): string => git(v.origin, 'show', `main:${path}`);
export const originHas = (v: VaultFixture, path: string): boolean => {
  try {
    git(v.origin, 'cat-file', '-e', `main:${path}`);
    return true;
  } catch {
    return false;
  }
};
export const originLog = (v: VaultFixture): string[] =>
  git(v.origin, 'log', '--format=%an|%s', 'main').split('\n').filter(Boolean);
