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
  /** Kill git after this long (network probes such as `ls-remote`). */
  timeoutMs?: number;
}

/** git lost a race for a lock file (two operations in one clone at once); it did nothing and can simply be run again. */
const LOCK_ERROR =
  /could not lock|unable to create '[^']*\.lock'|index\.lock|cannot lock ref|another git process/i;

/** Pauses (ms) between the retries of a command that hit a lock error; tests shorten them. */
export const lockRetry = { delaysMs: [100, 250, 500, 1000, 2000] };

/**
 * Runs git without a shell. Never throws on a non-zero exit; see `gitOk`. A command that failed on a lock another git
 * process held (`.git/config.lock`, `index.lock`, a ref lock) is run again a few times: it changed nothing.
 */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  for (let attempt = 0; ; attempt++) {
    const r = await execa('git', args, {
      cwd,
      reject: false,
      stdin: 'ignore',
      env: { GIT_TERMINAL_PROMPT: '0', ...opts.env },
      extendEnv: true,
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    });
    const res = { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), exitCode: r.exitCode ?? 1 };
    const delay = lockRetry.delaysMs[attempt];
    if (res.exitCode === 0 || delay === undefined || !LOCK_ERROR.test(res.stderr)) return res;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
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

/** Branches origin has as the clone last saw them (after the fetch), agent branches left out; at most 200. */
export async function originBranchNames(cwd: string): Promise<string[]> {
  const r = await git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin']);
  const names = new Set<string>();
  for (const ref of r.stdout.split('\n')) {
    const m = /^refs\/remotes\/origin\/(.+)$/.exec(ref.trim());
    if (m?.[1] && m[1] !== 'HEAD' && !/^aom(-integration)?\//.test(m[1])) names.add(m[1]);
  }
  return [...names].sort().slice(0, 200);
}

/** The conventional names of a main branch; a repository with more than one of them has no obvious default. */
export const CONVENTIONAL_MAIN_BRANCHES = ['main', 'master', 'develop', 'trunk'];

/** Credentials for git against the repository's host (see `GitAuth` in worktrees.ts). */
export type RemoteAuth = (url: string) => Promise<{ args: string[]; env: Record<string, string> }>;

/**
 * The branch the remote itself calls its default (`git ls-remote --symref origin HEAD`), or null when origin cannot be
 * reached (offline, no credentials) or says nothing.
 */
export async function remoteDefaultBranch(cwd: string, auth?: RemoteAuth): Promise<string | null> {
  const url = (await git(cwd, ['remote', 'get-url', 'origin'])).stdout.trim();
  if (!url) return null;
  let a: { args: string[]; env: Record<string, string> } = { args: [], env: {} };
  try {
    if (auth) a = await auth(url);
  } catch {
    return null;
  }
  const r = await git(cwd, [...a.args, 'ls-remote', '--symref', 'origin', 'HEAD'], {
    env: a.env,
    timeoutMs: 30_000,
  });
  if (r.exitCode !== 0) return null;
  return /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(r.stdout)?.[1] ?? null;
}

export interface DefaultBranch {
  branch: string | null;
  /** `remote`: the host said so; `local`: the clone's `origin/HEAD`; `only`: the one branch there is; `convention`: the one conventional name present. */
  source: 'remote' | 'local' | 'only' | 'convention' | null;
  /** The conventional names the clone has when there are several and nothing settles which is the main branch. */
  ambiguous: string[];
}

/**
 * The repository's default branch. First the remote's own answer (`ls-remote --symref`), and the clone's `origin/HEAD`
 * is brought in line with it (it is set at clone time and goes stale). When the remote cannot be asked: the clone's
 * `origin/HEAD`, else the only branch there is, else the one of main/master/develop/trunk present. When the clone has
 * several of those names and the remote cannot settle it, the answer is `branch: null` with `ambiguous` listing them:
 * guessing here puts work on a 14 month old branch.
 */
export async function resolveDefaultBranch(
  cwd: string,
  opts: { branches?: string[]; auth?: RemoteAuth } = {},
): Promise<DefaultBranch> {
  if (await hasRemote(cwd)) {
    const fromRemote = await remoteDefaultBranch(cwd, opts.auth);
    if (fromRemote) {
      const set = await git(cwd, ['remote', 'set-head', 'origin', fromRemote]);
      if (set.exitCode !== 0) {
        // The remote-tracking branch is not fetched yet; fetch it and point origin/HEAD at it.
        await git(cwd, ['fetch', '--', 'origin', fromRemote]);
        await git(cwd, ['remote', 'set-head', 'origin', fromRemote]);
      }
      return { branch: fromRemote, source: 'remote', ambiguous: [] };
    }
  }
  const all = opts.branches ?? (await branchNames(cwd));
  const present = CONVENTIONAL_MAIN_BRANCHES.filter((b) => all.includes(b));
  if (present.length > 1) return { branch: null, source: null, ambiguous: present };
  const r = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const head = r.exitCode === 0 ? /^origin\/(.+)$/.exec(r.stdout.trim())?.[1] : undefined;
  if (head) return { branch: head, source: 'local', ambiguous: [] };
  if (all.length === 1) return { branch: all[0] as string, source: 'only', ambiguous: [] };
  if (present[0]) return { branch: present[0], source: 'convention', ambiguous: [] };
  return { branch: null, source: null, ambiguous: [] };
}

/** `resolveDefaultBranch` for callers that only need the name (null: unknown or ambiguous). */
export async function defaultBranchOf(
  cwd: string,
  branches?: string[],
  auth?: RemoteAuth,
): Promise<string | null> {
  return (await resolveDefaultBranch(cwd, { ...(branches ? { branches } : {}), ...(auth ? { auth } : {}) }))
    .branch;
}

/** Owner-facing refusal for a repository whose main branch is unset and cannot be told. */
export function ambiguousMainMessage(repoName: string, names: string[]): string {
  const list =
    names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '');
  return `Set the main branch for ${repoName} in Project settings: it has both ${list}, and the host does not say which is the default.`;
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
