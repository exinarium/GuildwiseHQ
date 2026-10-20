import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { remoteUrlError } from '@aom/shared';
import { currentBranch, git, gitOk } from '../git/git.ts';
import { commitEnv, requireCommitIdentity } from '../git/identity.ts';

export interface VaultIdentity {
  name: string;
  email: string;
}

export interface VaultSyncInput {
  /** Local clone directory (`<dataDir>/vaults/<vaultId>`). */
  dir: string;
  remoteUrl: string;
  identity: VaultIdentity;
  workstationName: string;
  now?: () => Date;
}

export type VaultSyncResult =
  | {
      status: 'ok';
      cloned: boolean;
      committed: boolean;
      pulled: boolean;
      pushed: boolean;
      /** Folders (`projects/<name>`) whose generated graph files had a conflict that the sync resolved itself. */
      graphResolved?: string[];
    }
  | { status: 'conflict'; files: string[] }
  | { status: 'error'; error: string };

/**
 * Git identity for vault commits: the same resolver as every other commit (backlog #65), without a project: the vault
 * clone's own git config, else the workstation user's global one. Throws `NoCommitIdentityError` when there is none.
 * (The `identity` the server sends in `vault.configure` named an agent and is no longer used for commits.)
 */
export async function vaultCommitEnv(dir: string): Promise<Record<string, string>> {
  return commitEnv(await requireCommitIdentity(dir));
}

/** `file://` and path remotes exist for the test suites only: `AOM_ALLOW_LOCAL_REMOTES=1`. */
export const allowLocalRemotes = (): boolean => process.env.AOM_ALLOW_LOCAL_REMOTES === '1';

const redactUrl = (u: string): string => u.replace(/\/\/[^/@\s]*@/, '//***@').slice(0, 200);

export const isCloned = (dir: string): boolean => existsSync(join(dir, '.git'));

/** `git clone <remote> <dir>` if the clone is missing. Returns true if it cloned. */
export async function ensureClone(
  dir: string,
  remoteUrl: string,
  env: Record<string, string>,
): Promise<boolean> {
  if (isCloned(dir)) return false;
  // The URL comes from the vault owner via the server: only plain https/ssh remotes are cloned (never `ext::`, a
  // leading `-`, or credentials), and `--` keeps it from ever being read as an option.
  const bad = remoteUrlError(remoteUrl, allowLocalRemotes());
  if (bad) throw new Error(`refusing to clone ${JSON.stringify(redactUrl(remoteUrl))}: ${bad}`);
  await mkdir(dirname(dir), { recursive: true });
  const r = await git(dirname(dir), ['clone', '--', remoteUrl, dir], { env });
  if (r.exitCode !== 0) throw new Error(`git clone failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return true;
}

async function commitAll(dir: string, message: string, env: Record<string, string>): Promise<boolean> {
  await gitOk(dir, ['add', '-A'], { env });
  const status = await gitOk(dir, ['status', '--porcelain'], { env });
  if (!status) return false;
  await gitOk(dir, ['-c', 'commit.gpgsign=false', 'commit', '-m', message], { env });
  return true;
}

async function unmergedFiles(dir: string, env: Record<string, string>): Promise<string[]> {
  const r = await git(dir, ['diff', '--name-only', '--diff-filter=U'], { env });
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * A file the project graph generates (docs/design/project-graphs.md section 4): `<folder>/graph/manifest.json`, `modules.md`,
 * `work.md` and everything under `repos/`. Two workstations that indexed the same project write them; a conflict there is
 * never a person's work and never a desk item.
 */
export const isGeneratedGraphFile = (path: string): boolean =>
  /(^|\/)graph\/(manifest\.json|modules\.md|work\.md|repos\/.+)$/.test(path);

/** Placeholder for a generated graph file in text that leaves the runner. */
export const GRAPH_FILE_PLACEHOLDER = '<generated graph file>';

/**
 * A generated graph file's name is derived from the customer's code (`graph/repos/<repo>/<module>.jsonl`): it never reaches
 * the server. Names of such files in git's error text are replaced.
 */
export const scrubGraphPaths = (text: string): string =>
  text.replace(
    /[^\s'"`:]*graph\/(?:manifest\.json|modules\.md|work\.md|repos\/[^\s'"`:]+)/g,
    GRAPH_FILE_PLACEHOLDER,
  );

/** The conflicted files the server may hear about: real notes, never the generated graph. */
export const reportableConflicts = (files: readonly string[]): string[] =>
  files.filter((f) => !isGeneratedGraphFile(f));

const graphFolderOf = (path: string): string => path.slice(0, path.lastIndexOf('/graph/'));

/**
 * A rebase stopped on conflicts in generated graph files only: take the upstream side of each (the indexer rewrites them
 * from the code afterwards), continue, and repeat for the next replayed commit. Returns the folders resolved, or null when
 * a conflict that is not a generated file shows up (the caller then aborts and reports it as before).
 */
async function resolveGraphConflicts(
  dir: string,
  first: string[],
  env: Record<string, string>,
): Promise<string[] | null> {
  const folders = new Set<string>();
  let files = first;
  for (let round = 0; round < 50; round++) {
    if (files.length === 0 || !files.every(isGeneratedGraphFile)) return null;
    for (const f of files) {
      // during a rebase "ours" is the branch being rebased onto, i.e. the remote
      const co = await git(dir, ['checkout', '--ours', '--', f], { env });
      if (co.exitCode !== 0) await git(dir, ['rm', '-f', '--quiet', '--', f], { env });
      else await gitOk(dir, ['add', '--', f], { env });
      folders.add(graphFolderOf(f));
    }
    const cont = await git(
      dir,
      ['-c', 'core.editor=true', '-c', 'commit.gpgsign=false', 'rebase', '--continue'],
      {
        env: { ...env, GIT_EDITOR: 'true' },
      },
    );
    if (cont.exitCode === 0) return [...folders].sort();
    files = await unmergedFiles(dir, env);
    if (files.length === 0) {
      // an empty commit after the resolution: skip it
      const skip = await git(dir, ['rebase', '--skip'], { env });
      if (skip.exitCode === 0) return [...folders].sort();
      return null;
    }
  }
  return null;
}

/** Rebases local commits onto the remote branch. Conflict: files listed, rebase aborted, worktree left clean. */
async function pullRebase(
  dir: string,
  branch: string,
  env: Record<string, string>,
): Promise<
  | { ok: true; changed: boolean; graphResolved?: string[] }
  | { ok: false; conflict: string[] }
  | { ok: false; error: string }
> {
  const fetch = await git(dir, ['fetch', 'origin'], { env });
  if (fetch.exitCode !== 0) return { ok: false, error: `git fetch failed: ${fetch.stderr.trim()}` };
  const remote = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
    env,
  });
  if (remote.exitCode !== 0) return { ok: true, changed: false }; // the remote has no such branch yet: nothing to pull
  const before = (await git(dir, ['rev-parse', 'HEAD'], { env })).stdout.trim();
  const pull = await git(dir, ['pull', '--rebase', '--autostash', 'origin', branch], { env });
  if (pull.exitCode !== 0) {
    const files = await unmergedFiles(dir, env);
    // only generated graph files: resolve them here, they are rebuilt from the code
    if (files.length > 0 && files.every(isGeneratedGraphFile)) {
      const resolved = await resolveGraphConflicts(dir, files, env);
      if (resolved) {
        const afterResolved = (await git(dir, ['rev-parse', 'HEAD'], { env })).stdout.trim();
        return { ok: true, changed: before !== afterResolved, graphResolved: resolved };
      }
    }
    await git(dir, ['rebase', '--abort'], { env });
    // A mixed conflict (a note and generated graph files) names the notes only; graph files are not the person's work.
    const reportable = reportableConflicts(files);
    if (reportable.length > 0) return { ok: false, conflict: reportable };
    if (files.length > 0)
      return { ok: false, error: 'git pull --rebase failed: generated graph files could not be merged' };
    return {
      ok: false,
      error: scrubGraphPaths(`git pull --rebase failed: ${pull.stderr.trim() || pull.stdout.trim()}`),
    };
  }
  const after = (await git(dir, ['rev-parse', 'HEAD'], { env })).stdout.trim();
  return { ok: true, changed: before !== after };
}

/**
 * A sync failure that retrying does not fix: the login or key is refused, the repository does not exist or is not a
 * repository, the URL is refused. Anything else (network, a busy remote) is treated as temporary. Retrying a permanent
 * error every 2.5 minutes only fills the logs and the server's status table.
 */
export function isPermanentSyncError(message: string): boolean {
  return /authentication failed|permission denied|could not read (username|password)|repository not found|not found\b.*\bremote|remote: not found|does not appear to be a git repository|repository .{0,200}does not exist|access denied|\b40[134]\b|refusing to clone|host key verification failed|invalid credentials|bad credentials/i.test(
    message,
  );
}

/** How long a vault whose last `failures` syncs failed permanently waits for the next timer pass: doubles, up to 6 hours. */
export function syncBackoffMs(failures: number, intervalMs: number): number {
  if (failures <= 0) return 0;
  return Math.min(6 * 3600_000, intervalMs * 2 ** Math.min(failures, 16));
}

/** Does the local branch have commits the remote lacks (or does the remote branch not exist yet)? */
async function needsPush(dir: string, branch: string, env: Record<string, string>): Promise<boolean> {
  const remote = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
    env,
  });
  if (remote.exitCode !== 0) {
    const head = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'], { env });
    return head.exitCode === 0; // unborn HEAD in an empty repo has nothing to push
  }
  const n = (await git(dir, ['rev-list', '--count', `origin/${branch}..HEAD`], { env })).stdout.trim();
  return Number(n) > 0;
}

/**
 * One sync pass over a vault (docs/ARCHITECTURE.md section 16.3), deterministic git work without an LLM:
 * 1. clone if missing; 2. commit local edits (`Update notes <time>`, the resolved identity);
 * 3. `pull --rebase --autostash`, a conflict aborts the rebase and is reported; 4. push, retrying once from step 3 when
 * the push is rejected.
 */
export async function syncVault(input: VaultSyncInput): Promise<VaultSyncResult> {
  const now = input.now ?? (() => new Date());
  try {
    const cloned = await ensureClone(input.dir, input.remoteUrl, {});
    const env = await vaultCommitEnv(input.dir);
    const committed = await commitAll(input.dir, `Update notes ${now().toISOString().slice(0, 16)}Z`, env);
    const branch = (await currentBranch(input.dir)) ?? 'main';
    let pulled = false;
    let pushed = false;
    const graphResolved = new Set<string>();
    const done = () => ({ ...(graphResolved.size ? { graphResolved: [...graphResolved].sort() } : {}) });
    for (let attempt = 0; attempt < 2; attempt++) {
      const pull = await pullRebase(input.dir, branch, env);
      if (!pull.ok) {
        if ('conflict' in pull) return { status: 'conflict', files: pull.conflict };
        return { status: 'error', error: pull.error };
      }
      pulled ||= pull.changed;
      for (const f of pull.graphResolved ?? []) graphResolved.add(f);
      if (!(await needsPush(input.dir, branch, env)))
        return { status: 'ok', cloned, committed, pulled, pushed, ...done() };
      const push = await git(input.dir, ['push', 'origin', `HEAD:refs/heads/${branch}`], { env });
      if (push.exitCode === 0) {
        pushed = true;
        // keep origin/<branch> current without another network round trip
        await git(input.dir, ['fetch', 'origin'], { env });
        return { status: 'ok', cloned, committed, pulled, pushed, ...done() };
      }
      if (attempt === 1)
        return { status: 'error', error: scrubGraphPaths(`git push failed: ${push.stderr.trim()}`) };
    }
    return { status: 'error', error: 'sync did not converge' };
  } catch (err) {
    return { status: 'error', error: scrubGraphPaths(err instanceof Error ? err.message : String(err)) };
  }
}

/** True if the clone has uncommitted changes (reported in `hello.vaults[].clean`). */
export async function isClean(dir: string): Promise<boolean> {
  if (!isCloned(dir)) return true;
  const r = await git(dir, ['status', '--porcelain']);
  return r.exitCode === 0 && r.stdout.trim() === '';
}
