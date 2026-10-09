import { execa } from 'execa';

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(
      `git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

export interface GitOptions {
  env?: Record<string, string>;
}

/** Runs git without a shell. Never throws on a non-zero exit; see `gitOk`. */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const r = await execa('git', args, {
    cwd,
    reject: false,
    stdin: 'ignore',
    env: { GIT_TERMINAL_PROMPT: '0', ...opts.env },
    extendEnv: true,
  });
  return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), exitCode: r.exitCode ?? 1 };
}

/** Like `git` but throws `GitError` on failure and returns trimmed stdout. */
export async function gitOk(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const r = await git(cwd, args, opts);
  if (r.exitCode !== 0) throw new GitError(args, r);
  return r.stdout.trim();
}

export async function revParse(cwd: string, ref: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export async function hasRemote(cwd: string, name = 'origin'): Promise<boolean> {
  const r = await git(cwd, ['remote', 'get-url', name]);
  return r.exitCode === 0;
}

/** Short names of a clone's branches (local and origin), sorted; `HEAD` excluded. */
export async function branchNames(cwd: string): Promise<string[]> {
  const r = await git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin']);
  const names = new Set<string>();
  for (const ref of r.stdout.split('\n')) {
    const m = /^refs\/(?:heads|remotes\/origin)\/(.+)$/.exec(ref.trim());
    if (m?.[1] && m[1] !== 'HEAD') names.add(m[1]);
  }
  return [...names].sort();
}

/**
 * The repository's own default branch as the clone knows it: `origin/HEAD`, else the only branch there is. Null when
 * it cannot be told (several branches and no `origin/HEAD`).
 */
export async function defaultBranchOf(cwd: string, branches?: string[]): Promise<string | null> {
  const r = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const head = r.exitCode === 0 ? /^origin\/(.+)$/.exec(r.stdout.trim())?.[1] : undefined;
  if (head) return head;
  const all = branches ?? (await branchNames(cwd));
  if (all.length === 1) return all[0] as string;
  // Several branches and no origin/HEAD: the conventional names, `main` before `master`.
  return ['main', 'master'].find((b) => all.includes(b)) ?? null;
}

/** `git --version` as [major, minor], or null. */
export async function gitVersion(): Promise<{ raw: string; major: number; minor: number } | null> {
  try {
    const r = await execa('git', ['--version'], { reject: false });
    const m = /(\d+)\.(\d+)/.exec(String(r.stdout));
    if (!m) return null;
    return { raw: String(r.stdout).trim(), major: Number(m[1]), minor: Number(m[2]) };
  } catch {
    return null;
  }
}
