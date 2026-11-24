import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { E2E_DIR } from '../../support/env.ts';

/** Every git call of the harness: an explicit identity, no global or system config (nothing of the owner's leaks in). */
const GIT_ENV = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^GIT_(AUTHOR|COMMITTER)_/.test(k)) delete env[k];
  return {
    ...env,
    GIT_AUTHOR_NAME: 'Other Person',
    GIT_AUTHOR_EMAIL: 'other.person@e2e.test',
    GIT_COMMITTER_NAME: 'Other Person',
    GIT_COMMITTER_EMAIL: 'other.person@e2e.test',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
};

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV(), stdio: ['ignore', 'pipe', 'pipe'] });

export const remotesDir = (name: string): string => join(E2E_DIR, 'combined', name);

export interface Remote {
  /** The bare origin (a local path: the harness never reaches a real remote). */
  origin: string;
  /** Where the runner's clone lives (a repo root of the paired runner). */
  repoRoot: string;
  /** The runner's clone of the origin. */
  clone: string;
  /** Another person's clone: pushes made here move `main` under the runner. */
  other: string;
}

/**
 * A bare origin plus the runner's clone and another person's clone, all under the temp dir. `files` seeds `main` (none:
 * the origin is EMPTY, HEAD pointing at `master` while the working branch is `main`, the shape of the devbox repository).
 */
export function makeRemote(
  name: string,
  files: Record<string, string> | null,
  sharedRepoRoot?: string,
): Remote {
  const root = remotesDir(name);
  const origin = join(root, `${name}.git`);
  const repoRoot = sharedRepoRoot ?? join(root, 'repos');
  const clone = join(repoRoot, name);
  const other = join(root, 'other');
  mkdirSync(root, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });
  git(root, 'init', '--bare', '-b', files ? 'main' : 'master', origin);
  if (files) {
    git(root, 'clone', origin, other);
    git(other, 'checkout', '-b', 'main');
    for (const [p, content] of Object.entries(files)) {
      mkdirSync(dirname(join(other, p)), { recursive: true });
      writeFileSync(join(other, p), content);
    }
    git(other, 'add', '-A');
    git(other, 'commit', '-m', 'Initial commit');
    git(other, 'push', '-u', 'origin', 'main');
  } else {
    git(root, 'clone', origin, other);
  }
  git(root, 'clone', origin, clone);
  return { origin, repoRoot, clone, other };
}

/** Another person pushes a commit to `main` (pulls first, so it also works after the runner pushed). */
export function pushToMain(r: Remote, file: string, content: string, message: string): string {
  try {
    git(r.other, 'pull', '--rebase', 'origin', 'main');
  } catch {
    // an empty origin: nothing to pull yet
  }
  git(r.other, 'checkout', '-B', 'main');
  mkdirSync(dirname(join(r.other, file)), { recursive: true });
  writeFileSync(join(r.other, file), content);
  git(r.other, 'add', '-A');
  git(r.other, 'commit', '-m', message);
  git(r.other, 'push', 'origin', 'main');
  return git(r.other, 'rev-parse', 'HEAD').trim();
}

export const revParse = (cwd: string, ref: string): string => git(cwd, 'rev-parse', ref).trim();
export const commitCount = (cwd: string, ref: string): number => {
  try {
    return Number(git(cwd, 'rev-list', '--count', ref).trim());
  } catch {
    return 0;
  }
};
