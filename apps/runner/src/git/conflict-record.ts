import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../policy/store.ts';
import { ledgerRepoKey } from './branch-ledger.ts';
import { currentBranch, git } from './git.ts';

/**
 * Conflicts the runner saw itself (runner-authority-fixes T7): `<dataDir>/conflicts.json`, mode 600, in
 * `RUNNER_PRIVATE`. A record is written where the runner's own rebase of a card branch conflicted, and where hygiene
 * could not combine the working branch with its remote. After a DevOps conflict request ends "Resolved:", the runner
 * moves the branch forward only when such a record matches the branch and its current head (devops/conflict-ff.ts),
 * so a compromised server cannot point the step at another branch. Records are dropped when used or after 7 days.
 * A failed write never fails the caller.
 */

export const CONFLICT_RECORD_FILE = 'conflicts.json';
const MAX_AGE_MS = 7 * 24 * 3_600_000;
const MAX_ENTRIES = 500;

export interface ConflictRecord {
  /** The ledger key of the clone (normalized origin, else its real path). */
  repo: string;
  branch: string;
  /** The branch head when the conflict was seen. */
  head: string;
  /** A working-branch record: `origin/<wb>` when the conflict was seen. */
  originHead?: string;
  kind: 'card' | 'working';
  at: string;
  /**
   * Rework 1 (B2): `refs/heads/conflict/*` when the runner recorded the conflict. The resolution is the one scratch branch
   * made or moved since then, whichever of the request's shifts made it (an approval or a usage limit resumes it).
   */
  refs?: Record<string, string>;
}

/** `refs/heads/conflict/*` -> sha of a clone. */
export async function conflictRefSnapshot(repoPath: string): Promise<Map<string, string>> {
  const r = await git(repoPath, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/heads/conflict/',
  ]);
  const out = new Map<string, string>();
  for (const line of r.stdout.split('\n')) {
    const [ref, sha] = line.trim().split(' ');
    if (ref && sha) out.set(ref, sha);
  }
  return out;
}

export class ConflictRecords {
  constructor(readonly file: string) {}

  static forRoot(root: string): ConflictRecords {
    return new ConflictRecords(join(root, CONFLICT_RECORD_FILE));
  }

  entries(now = Date.now()): ConflictRecord[] {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as { entries?: unknown };
      if (!Array.isArray(v.entries)) return [];
      return (v.entries as ConflictRecord[]).filter(
        (e) =>
          !!e &&
          typeof e.repo === 'string' &&
          typeof e.branch === 'string' &&
          /^[0-9a-f]{40,64}$/.test(e.head ?? '') &&
          (e.kind === 'card' || e.kind === 'working') &&
          now - Date.parse(e.at) < MAX_AGE_MS,
      );
    } catch {
      return [];
    }
  }

  private save(entries: ConflictRecord[]): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileAtomic(
        this.file,
        `${JSON.stringify({ entries: entries.slice(-MAX_ENTRIES) }, null, 1)}\n`,
        0o600,
      );
    } catch {
      // the record only allows a later fast-forward; without it the branch is simply not moved
    }
  }

  /** Records a conflict (replacing one of the same repository, branch and kind). Never throws. */
  record(r: Omit<ConflictRecord, 'at'>): void {
    const rest = this.entries().filter(
      (e) => !(e.repo === r.repo && e.branch === r.branch && e.kind === r.kind),
    );
    rest.push({ ...r, at: new Date().toISOString() });
    this.save(rest);
  }

  find(repo: string, branch: string, kind: ConflictRecord['kind']): ConflictRecord | null {
    return this.entries().find((e) => e.repo === repo && e.branch === branch && e.kind === kind) ?? null;
  }

  drop(repo: string, branch: string, kind: ConflictRecord['kind']): void {
    this.save(this.entries().filter((e) => !(e.repo === repo && e.branch === branch && e.kind === kind)));
  }
}

/** The runner's records, set once at start (tests set their own). Unset: nothing is recorded. */
let current: ConflictRecords | null = null;
export const setConflictRecords = (r: ConflictRecords | null): void => {
  current = r;
};
export const conflictRecords = (): ConflictRecords | null => current;

/**
 * After a card rebase conflicted (and was aborted): records the card branch at `head`. gate-fixes-2: the caller passes
 * the branch it checked (the worktree may be detached during the runner's move). Never throws.
 */
export async function recordCardConflict(
  worktree: string,
  head: string,
  checkedBranch?: string,
): Promise<void> {
  const store = current;
  if (!store || !/^[0-9a-f]{40,64}$/.test(head)) return;
  try {
    const branch = checkedBranch ?? (await currentBranch(worktree));
    if (!branch) return;
    store.record({
      repo: await ledgerRepoKey(worktree),
      branch,
      head,
      kind: 'card',
      refs: Object.fromEntries(await conflictRefSnapshot(worktree)),
    });
  } catch {
    // best effort
  }
}

/**
 * Hygiene could not combine `wb` with origin's: records both heads. gate-fixes-2 B2: the shas are the ones hygiene used
 * (its trusted local tip, read once, and origin's Rule B tip from ls-remote), never re-read from refs an agent session
 * could have moved meanwhile. Never throws.
 */
export async function recordWorkingConflict(
  repoPath: string,
  wb: string,
  shas: { head: string; originHead: string },
): Promise<void> {
  const store = current;
  if (!store) return;
  try {
    const { head, originHead } = shas;
    if (!/^[0-9a-f]{40,64}$/.test(head) || !/^[0-9a-f]{40,64}$/.test(originHead)) return;
    store.record({
      repo: await ledgerRepoKey(repoPath),
      branch: wb,
      head,
      originHead,
      kind: 'working',
      refs: Object.fromEntries(await conflictRefSnapshot(repoPath)),
    });
  } catch {
    // best effort
  }
}
