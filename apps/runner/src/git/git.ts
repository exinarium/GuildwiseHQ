import { isAbsolute, resolve } from 'node:path';
import { normalizeRemoteUrl } from '@aom/shared';
import { execa } from 'execa';
import { APP_GIT_MARKER, appRepos, tripwireMessage } from '../forge/app-repos.ts';
import { clearLockStub } from './config-lock.ts';
import { GIT_HARDEN_ENV, gitlinkExcludes, gitPointerProblem, hardenedGitArgs } from './harden.ts';

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
  /** Keep stdout byte-exact: the final newline is not stripped (file contents read with `git show`). */
  keepFinalNewline?: boolean;
}

/** git lost a race for a lock file (two operations in one clone at once); it did nothing and can simply be run again. */
const LOCK_ERROR =
  /could not lock|unable to create '[^']*\.lock'|index\.lock|cannot lock ref|another git process/i;

const CONFIG_LOCK_ERROR = /could not lock config file|config(\.worktree)?\.lock/i;

/** Removes the sandbox's `config.lock` stub of the clone `cwd` belongs to; true when one was removed. */
async function clearConfigLockStub(cwd: string): Promise<boolean> {
  if (gitPointerProblem(cwd)) return false;
  const r = await execa('git', hardenedGitArgs(['rev-parse', '--git-common-dir']), {
    cwd,
    reject: false,
    stdin: 'ignore',
    env: { ...GIT_HARDEN_ENV },
    extendEnv: true,
  });
  const out = String(r.stdout ?? '').trim();
  if (r.exitCode !== 0 || !out) return false;
  return clearLockStub(isAbsolute(out) ? out : resolve(cwd, out)).length > 0;
}

/**
 * Index of the subcommand in `args`: after any leading `-c <setting>` / `-C <dir>` pairs. -1 when another global
 * option comes first: the guards below would then look at the wrong word, so such a call is refused.
 */
function subcommandIndex(args: readonly string[]): number {
  let i = 0;
  while (i < args.length && (args[i] === '-c' || args[i] === '-C')) i += 2;
  return args[i]?.startsWith('-') ? -1 : i;
}

/**
 * Keeps a superproject command from starting git inside a submodule or a nested repository (harden.ts,
 * `GIT_HARDEN_ARGS`): the option forms that an agent-written `.gitmodules` cannot override.
 * - `status`, `diff`: `--ignore-submodules=dirty` (the command-line option beats `submodule.<name>.ignore`).
 * - `checkout`, `switch`: quiet, so they do not report local changes (that report looks into submodules).
 * - `fetch`, `pull`: `--no-recurse-submodules` (beats `submodule.<name>.fetchRecurseSubmodules`).
 * An autostash (`git stash` and a plain `git status` as children, without these option forms) is switched off as a
 * configuration default in `GIT_HARDEN_ARGS`; only the vault sync asks for one explicitly (`pull --rebase --autostash`
 * in the runner's own vault clone, which agents cannot write).
 * - `add`: an exclude pathspec for every gitlink of the index (read with `ls-files -s`, which starts nothing, in the
 *   same environment so a private index file is honoured). When the index cannot be read the add is not run.
 * Returns the arguments to run, or a refusal.
 */
async function withSubmoduleGuards(
  cwd: string,
  args: string[],
  env: Record<string, string> | undefined,
): Promise<{ args: string[] } | { refused: string }> {
  const at = subcommandIndex(args);
  if (at < 0) return { refused: `an option before the subcommand that the runner does not use (${args[0]})` };
  const sub = args[at];
  const head = args.slice(0, at + 1);
  const rest = args.slice(at + 1);
  // The options are the words before `--`; what follows are paths, which a caller may take from an agent (a file
  // named `--ignore-submodules=none` must not be read as "the option is already there"). An inserted option goes right
  // after the subcommand, so it is an option whatever follows. A weaker form among the options is refused, since git
  // lets the last one win.
  const options = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest;
  if (sub === 'status' || sub === 'diff') {
    const given = options.filter((a) => a.startsWith('--ignore-submodules'));
    if (given.some((a) => a !== '--ignore-submodules=dirty' && a !== '--ignore-submodules=all'))
      return { refused: `${sub} asked to look inside submodules (${given.join(' ')})` };
    return given.length ? { args } : { args: [...head, '--ignore-submodules=dirty', ...rest] };
  }
  if (sub === 'checkout' || sub === 'switch') {
    if (options.includes('-q') || options.includes('--quiet')) return { args };
    return { args: [...head, '-q', ...rest] };
  }
  if (sub === 'fetch' || sub === 'pull') {
    // `submodule.<name>.fetchRecurseSubmodules` in an agent-written .gitmodules beats the config default; the option wins
    if (options.some((a) => a.startsWith('--recurse-submodules')))
      return { refused: `${sub} asked to recurse into submodules` };
    if (options.includes('--no-recurse-submodules')) return { args };
    return { args: [...head, '--no-recurse-submodules', ...rest] };
  }
  if (sub !== 'add') return { args };
  const ls = await execa('git', hardenedGitArgs(['ls-files', '-s', '-z', '--full-name', ':/']), {
    cwd,
    reject: false,
    stdin: 'ignore',
    env: { ...GIT_HARDEN_ENV, ...env },
    extendEnv: true,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (ls.exitCode !== 0) return { refused: 'the index could not be read to keep git add out of submodules' };
  const links = new Set<string>();
  for (const entry of String(ls.stdout ?? '').split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab > 0 && entry.startsWith('160000 ')) links.add(entry.slice(tab + 1));
  }
  if (links.size === 0) return { args };
  const excludes = gitlinkExcludes([...links]);
  return { args: rest.includes('--') ? [...args, ...excludes] : [...args, '--', ...excludes] };
}

/**
 * The refusal for a `push` without the app credential to a repository a runner root registered as posting as an app
 * (`forge/app-repos.ts`), or null. The push target is the first non-option word after `push` (a url, or a remote
 * name read with `git remote get-url`), `origin` when there is none.
 */
async function pushTripwire(
  cwd: string,
  args: string[],
  env: Record<string, string> | undefined,
): Promise<string | null> {
  const at = subcommandIndex(args);
  if (at < 0 || args[at] !== 'push' || env?.[APP_GIT_MARKER]) return null;
  if (!appRepos.watches(cwd)) return null;
  const rest = args.slice(at + 1);
  const words = rest.includes('--') ? rest.filter((a) => a !== '--') : rest.filter((a) => !a.startsWith('-'));
  const target = words[0] ?? 'origin';
  let url = target;
  if (!/[:/]/.test(target)) {
    const r = await execa('git', hardenedGitArgs(['remote', 'get-url', target]), {
      cwd,
      reject: false,
      stdin: 'ignore',
      env: { ...GIT_HARDEN_ENV },
      extendEnv: true,
    });
    url = String(r.stdout ?? '').trim();
    if (r.exitCode !== 0 || !url) return null;
  }
  const normalized = normalizeRemoteUrl(url);
  const hit = appRepos.find(cwd, normalized);
  return hit ? tripwireMessage(normalized, hit.label) : null;
}

/** Pauses (ms) between the retries of a command that hit a lock error; tests shorten them. */
export const lockRetry = { delaysMs: [100, 250, 500, 1000, 2000] };

/**
 * Runs git without a shell. Never throws on a non-zero exit; see `gitOk`. A command that failed on a lock another git
 * process held (`.git/config.lock`, `index.lock`, a ref lock) is run again a few times: it changed nothing.
 */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  // a worktree whose .git file points somewhere it should not is not a place to run git (docs/RUNNER.md, "the repository's configuration")
  const pointer = gitPointerProblem(cwd);
  if (pointer) return { stdout: '', stderr: `refusing to run git: ${pointer}`, exitCode: 128 };
  // no superproject command the runner starts looks inside a submodule or a nested repository
  const guarded = await withSubmoduleGuards(cwd, args, opts.env);
  if ('refused' in guarded)
    return { stdout: '', stderr: `refusing to run git: ${guarded.refused}`, exitCode: 128 };
  args = guarded.args;
  // a push to a repository that posts as an app must carry the app credential (fail closed, never another identity)
  const tripped = await pushTripwire(cwd, args, opts.env);
  if (tripped) return { stdout: '', stderr: tripped, exitCode: 128 };
  for (let attempt = 0; ; attempt++) {
    const r = await execa('git', hardenedGitArgs(args), {
      cwd,
      reject: false,
      stdin: 'ignore',
      env: { ...GIT_HARDEN_ENV, ...opts.env },
      extendEnv: true,
      stripFinalNewline: !opts.keepFinalNewline,
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    });
    const res = { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), exitCode: r.exitCode ?? 1 };
    if (afterHook) await afterHook(args, cwd, res);
    const delay = lockRetry.delaysMs[attempt];
    // A sandbox's empty read-only config.lock stub (never a real lock) is removed; the command then runs again.
    if (
      res.exitCode !== 0 &&
      attempt < 3 &&
      CONFIG_LOCK_ERROR.test(res.stderr) &&
      (await clearConfigLockStub(cwd))
    ) {
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    if (res.exitCode === 0 || delay === undefined || !LOCK_ERROR.test(res.stderr)) return res;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * gate-fixes-2 S8: a test seam called after every git command the runner runs (unset in production). `GIT_HARDEN_ARGS`
 * turns hooks off, so race tests change a ref here, right after the named command.
 */
type AfterHook = (args: string[], cwd: string, res: GitResult) => void | Promise<void>;
let afterHook: AfterHook | null = null;
export const setGitAfterHook = (h: AfterHook | null): void => {
  afterHook = h;
};

/**
 * gate-fixes-2 Rule B: origin's tip of `branch`, read from the network (`ls-remote`), never from `refs/remotes`,
 * `FETCH_HEAD` or a local ref a writer could have changed. Null when origin has no such branch. Throws `GitError` when
 * origin cannot be asked. The caller fetches and checks the commit is here (`hasCommit`) before it uses the sha.
 */
export async function originTip(
  cwd: string,
  branch: string,
  auth?: { args: string[]; env: Record<string, string> },
): Promise<string | null> {
  const args = [...(auth?.args ?? []), 'ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`];
  const r = await git(cwd, args, { ...(auth ? { env: auth.env } : {}), timeoutMs: 120_000 });
  if (r.exitCode === 2) return null;
  if (r.exitCode !== 0) throw new GitError(args, r);
  const line = r.stdout.split('\n').find((l) => l.trim().endsWith(`\trefs/heads/${branch}`));
  const sha = line?.split('\t')[0]?.trim() ?? '';
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new GitError(args, { ...r, stderr: 'ls-remote gave no sha' });
  return sha;
}

/**
 * Rule B in one call: origin's tip of `branch` from ls-remote when it is a commit in this clone (fetched), else null
 * (no such branch, not fetched, or origin could not be asked).
 */
export async function ruleBTip(
  cwd: string,
  branch: string,
  auth?: { args: string[]; env: Record<string, string> },
): Promise<string | null> {
  const sha = await originTip(cwd, branch, auth).catch(() => null);
  return sha && (await hasCommit(cwd, sha)) ? sha : null;
}

/** Is `sha` a commit in this clone's object store? */
export async function hasCommit(cwd: string, sha: string): Promise<boolean> {
  return (await git(cwd, ['cat-file', '-e', `${sha}^{commit}`])).exitCode === 0;
}

/**
 * gate-fixes-2 B3: every runner move of a branch is detached, pinned and compare-and-swap. `refs/heads/<branch>` must
 * equal `checked`; the worktree is detached at `checked` (the detached HEAD lives in the worktree's own admin dir), `op`
 * runs there (a rebase or merge onto a Rule B sha), the result is read once, and the branch is moved with
 * `update-ref <ref> <new> <checked>`: a ref that moved meanwhile fails the move, the worktree is re-attached and nothing
 * moves. Returns the new sha.
 */
export async function moveBranchAt(
  worktree: string,
  branch: string,
  checked: string,
  op: () => Promise<GitResult>,
  /**
   * When `op` fails, before re-attaching: git arguments (`['rebase', '--abort']`) or a callback that reads what it needs
   * (the conflicted files) and aborts.
   */
  onFail?: string[] | ((r: GitResult) => Promise<void>),
): Promise<{ ok: true; sha: string } | { ok: false; reason: string; opFailed?: GitResult }> {
  const ref = `refs/heads/${branch}`;
  // HEAD (detached) equals the branch tip in both uses below, so re-attaching needs no checkout (no index, no files)
  const reattach = () => git(worktree, ['symbolic-ref', 'HEAD', ref]);
  const now = (await git(worktree, ['rev-parse', '--verify', '-q', ref])).stdout.trim();
  if (now !== checked) return { ok: false, reason: `${branch} moved since it was checked` };
  const det = await git(worktree, ['checkout', '--detach', checked]);
  if (det.exitCode !== 0)
    return { ok: false, reason: `could not detach at ${checked.slice(0, 10)}: ${det.stderr.trim()}` };
  const r = await op();
  if (r.exitCode !== 0) {
    if (typeof onFail === 'function') await onFail(r);
    else if (onFail) await git(worktree, onFail);
    const at = (await git(worktree, ['rev-parse', '--verify', '-q', 'HEAD'])).stdout.trim();
    if (at === checked) await reattach();
    else await git(worktree, ['checkout', branch]);
    return { ok: false, reason: (r.stderr || r.stdout).trim().split('\n')[0] ?? 'failed', opFailed: r };
  }
  const sha = (await git(worktree, ['rev-parse', '--verify', '-q', 'HEAD'])).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) {
    await git(worktree, ['checkout', branch]);
    return { ok: false, reason: 'the result could not be read' };
  }
  const cas = await git(worktree, ['update-ref', ref, sha, checked]);
  if (cas.exitCode !== 0) {
    // the branch moved meanwhile: it is not moved by the runner, the worktree goes back onto it as it is now
    await git(worktree, ['checkout', branch]);
    return { ok: false, reason: `${branch} moved while the runner worked on it` };
  }
  const back = await reattach();
  if (back.exitCode !== 0) return { ok: false, reason: `moved, but could not check ${branch} out again` };
  return { ok: true, sha };
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

/** The credentials for origin (none without `auth`); null when `auth` refused (an app that cannot mint). */
export async function originAuth(
  cwd: string,
  auth?: RemoteAuth,
): Promise<{ args: string[]; env: Record<string, string> } | null> {
  if (!auth) return { args: [], env: {} };
  const url = (await git(cwd, ['remote', 'get-url', 'origin'])).stdout.trim();
  try {
    return url ? await auth(url) : { args: [], env: {} };
  } catch {
    return null;
  }
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
        const a = await originAuth(cwd, opts.auth);
        if (a) await git(cwd, [...a.args, 'fetch', '--', 'origin', fromRemote], { env: a.env });
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

/** Fast-forwards the clone's local working branch to the merge commit when that is safe (best effort). */
export async function advanceLocalBranch(repo: string, base: string, sha: string): Promise<void> {
  const local = await revParse(repo, `refs/heads/${base}`);
  if (!local || local === sha) return;
  if ((await git(repo, ['merge-base', '--is-ancestor', local, sha])).exitCode !== 0) return;
  const current = (await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  if (current === base) {
    if ((await git(repo, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim()) return;
    await git(repo, ['merge', '--ff-only', sha]);
  } else {
    await git(repo, ['update-ref', `refs/heads/${base}`, sha, local]);
  }
}
