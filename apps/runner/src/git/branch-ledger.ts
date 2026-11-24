import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeRemoteUrl } from '@aom/shared';
import { writeFileAtomic } from '../policy/store.ts';
import { git } from './git.ts';

/**
 * The card branches this runner made or pushed itself (runner-authority-fixes T1, quiet-approvals [B4]):
 * `<dataDir>/card-branches.json`, mode 600, in `RUNNER_PRIVATE` (no agent reads or writes it). The branch tidy-up
 * deletes a branch on origin only when this ledger says the runner pushed it, and only while origin's tip still
 * contains the commit it pushed; a server-supplied name or prefix alone never makes a branch deletable.
 *
 * Writes are synchronous read-modify-write cycles with an atomic rename: two finalizes of one runner process cannot
 * interleave inside one (the event loop runs it to the end), and a lost entry only keeps a branch (the safe direction).
 * A failed write never fails the caller.
 */

export const BRANCH_LEDGER_FILE = 'card-branches.json';

export interface LedgerEntry {
  /** `normalizeRemoteUrl(origin)` of the clone, or the clone's real path when it has no origin. */
  repo: string;
  branch: string;
  kind: 'created' | 'pushed';
  /** `pushed`: the commit the runner pushed (origin's tip must still contain it for a delete). */
  sha?: string;
  at: string;
}

const MAX_ENTRIES = 5000;

/** The ledger key of a clone: its origin, normalized, else its real path. */
export async function ledgerRepoKey(repoPath: string): Promise<string> {
  const url = (await git(repoPath, ['remote', 'get-url', 'origin']).catch(() => null))?.stdout.trim();
  if (url) return normalizeRemoteUrl(url);
  try {
    return realpathSync(repoPath);
  } catch {
    return repoPath;
  }
}

export class BranchLedger {
  constructor(
    readonly file: string,
    private readonly warn: (m: string) => void = () => {},
  ) {}

  static forRoot(root: string, warn?: (m: string) => void): BranchLedger {
    return new BranchLedger(join(root, BRANCH_LEDGER_FILE), warn);
  }

  entries(): LedgerEntry[] {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as { entries?: unknown };
      if (!Array.isArray(v.entries)) return [];
      return v.entries.filter(
        (e): e is LedgerEntry =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as LedgerEntry).repo === 'string' &&
          typeof (e as LedgerEntry).branch === 'string' &&
          ((e as LedgerEntry).kind === 'created' || (e as LedgerEntry).kind === 'pushed'),
      );
    } catch {
      return [];
    }
  }

  /** The runner created or pushed `branch` in `repo`. */
  has(repo: string, branch: string): boolean {
    return this.entries().some((e) => e.repo === repo && e.branch === branch);
  }

  /** The sha the runner last pushed to `branch` on `repo`'s origin, or null when it never pushed it. */
  pushedSha(repo: string, branch: string): string | null {
    const e = this.entries().find((x) => x.repo === repo && x.branch === branch && x.kind === 'pushed');
    return e?.sha ?? null;
  }

  private save(entries: LedgerEntry[]): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileAtomic(
        this.file,
        `${JSON.stringify({ entries: entries.slice(-MAX_ENTRIES) }, null, 1)}\n`,
        0o600,
      );
    } catch (err) {
      this.warn(
        `the card branch ledger could not be written: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Records a branch (replacing an entry of the same kind). Never throws. */
  record(repo: string, branch: string, kind: LedgerEntry['kind'], sha?: string): void {
    const rest = this.entries().filter((e) => !(e.repo === repo && e.branch === branch && e.kind === kind));
    rest.push({ repo, branch, kind, ...(sha ? { sha } : {}), at: new Date().toISOString() });
    this.save(rest);
  }

  /** Forgets a branch, or one kind of entry of it (after it was deleted there). Never throws. */
  drop(repo: string, branch: string, kind?: LedgerEntry['kind']): void {
    const all = this.entries();
    const rest = all.filter((e) => !(e.repo === repo && e.branch === branch && (!kind || e.kind === kind)));
    if (rest.length !== all.length) this.save(rest);
  }

  /** `record` keyed by a clone path. Never throws. */
  async recordFor(repoPath: string, branch: string, kind: LedgerEntry['kind'], sha?: string): Promise<void> {
    try {
      this.record(await ledgerRepoKey(repoPath), branch, kind, sha);
    } catch (err) {
      this.warn(
        `the card branch ledger could not be updated: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
