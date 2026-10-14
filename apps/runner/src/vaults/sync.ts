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
  | { status: 'ok'; cloned: boolean; committed: boolean; pulled: boolean; pushed: boolean }
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

/** Rebases local commits onto the remote branch. Conflict: files listed, rebase aborted, worktree left clean. */
async function pullRebase(
  dir: string,
  branch: string,
  env: Record<string, string>,
): Promise<
  { ok: true; changed: boolean } | { ok: false; conflict: string[] } | { ok: false; error: string }
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
    await git(dir, ['rebase', '--abort'], { env });
    if (files.length > 0) return { ok: false, conflict: files };
    return { ok: false, error: `git pull --rebase failed: ${pull.stderr.trim() || pull.stdout.trim()}` };
  }
  const after = (await git(dir, ['rev-parse', 'HEAD'], { env })).stdout.trim();
  return { ok: true, changed: before !== after };
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
    for (let attempt = 0; attempt < 2; attempt++) {
      const pull = await pullRebase(input.dir, branch, env);
      if (!pull.ok) {
        if ('conflict' in pull) return { status: 'conflict', files: pull.conflict };
        return { status: 'error', error: pull.error };
      }
      pulled ||= pull.changed;
      if (!(await needsPush(input.dir, branch, env)))
        return { status: 'ok', cloned, committed, pulled, pushed };
      const push = await git(input.dir, ['push', 'origin', `HEAD:refs/heads/${branch}`], { env });
      if (push.exitCode === 0) {
        pushed = true;
        // keep origin/<branch> current without another network round trip
        await git(input.dir, ['fetch', 'origin'], { env });
        return { status: 'ok', cloned, committed, pulled, pushed };
      }
      if (attempt === 1) return { status: 'error', error: `git push failed: ${push.stderr.trim()}` };
    }
    return { status: 'error', error: 'sync did not converge' };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/** True if the clone has uncommitted changes (reported in `hello.vaults[].clean`). */
export async function isClean(dir: string): Promise<boolean> {
  if (!isCloned(dir)) return true;
  const r = await git(dir, ['status', '--porcelain']);
  return r.exitCode === 0 && r.stdout.trim() === '';
}
