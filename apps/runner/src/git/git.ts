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
