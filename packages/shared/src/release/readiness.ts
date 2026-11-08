/**
 * Whether a release is ready on the test site and ready to go out. This is the only place the rule lives.
 *
 * A repository is ready when one of its test environments runs the release-branch head as its latest successful,
 * healthy deploy (nothing newer queued, running or failed) and that environment's gate passes, and every live
 * environment that deploys it meets its requirements for the head (release window and freeze do not count).
 * A repository no test environment deploys is not checked and does not block; at least one must be checked.
 */

export interface ReadinessGate {
  satisfied: boolean;
  missing: string[];
}

export interface ReadinessRepoInput {
  repoId: string;
  repoName: string;
  /** Release-branch head, or null when the branch has not been read yet. */
  head: string | null;
  /** Test environments that deploy this repository (empty: no test site). */
  envs: Array<{
    name: string;
    label: string;
    /** Latest succeeded, non-trial, non-dry-run deploy of this environment (any commit), or null. */
    current: { commit: string | null; healthy: boolean | null } | null;
    /** A newer deploy of this environment is queued or running. */
    updating: boolean;
    /** The latest finished deploy failed after `current`. */
    lastFailed: boolean;
    /** The environment's own gate for the head; null when not evaluated. */
    gate: ReadinessGate | null;
  }>;
  /** Live environments that deploy this repository; their requirements for the head (null: not evaluated). */
  live: Array<{ name: string; label: string; requires: ReadinessGate | null }>;
}

export type ReadinessRepoState = 'ready' | 'not_ready' | 'not_checked';

export interface ReleaseReadiness {
  ready: boolean;
  /** Sorted "<repoId>@<head>" of the checked repositories; null when not ready. */
  key: string | null;
  heads: Record<string, string>;
  repos: Array<{
    repoId: string;
    repoName: string;
    state: ReadinessRepoState;
    env: string | null;
    reason: string | null;
  }>;
  /** The not-ready sentences, one per repository. */
  reasons: string[];
}

export const NO_CHECKED_REPO = 'No test site deploys any repository of this release';

const short = (sha: string): string => sha.slice(0, 7);

/** Same commit when one is a prefix of the other and both have at least 7 hex characters. */
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x.length < 7 || y.length < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

type Env = ReadinessRepoInput['envs'][number];

/** Why this test environment is not ready for the head; null when it is. */
function envProblem(repo: string, head: string, e: Env): string | null {
  if (e.updating) return `${repo}: an update of ${e.label} is running`;
  if (e.lastFailed) return `${repo}: the last update of ${e.label} failed`;
  if (!e.current || !sameCommit(e.current.commit, head)) {
    const runs = e.current?.commit ? `it runs ${short(e.current.commit)}` : 'nothing deployed yet';
    return `${repo}: head ${short(head)} is not on ${e.label} yet (${runs})`;
  }
  if (e.current.healthy === false) return `${repo}: ${e.label} is not healthy on ${short(head)}`;
  if (!e.gate) return `${repo}: ${e.label} gate not checked yet`;
  if (!e.gate.satisfied) return `${repo}: ${e.label} gate not met: ${e.gate.missing.join('; ')}`;
  return null;
}

export function releaseReadiness(input: ReadinessRepoInput[]): ReleaseReadiness {
  const heads: Record<string, string> = {};
  const repos: ReleaseReadiness['repos'] = [];
  for (const r of input) {
    if (r.head) heads[r.repoId] = r.head;
    if (r.envs.length === 0) {
      repos.push({
        repoId: r.repoId,
        repoName: r.repoName,
        state: 'not_checked',
        env: null,
        reason: `${r.repoName}: no test site deploys it, not checked`,
      });
      continue;
    }
    if (!r.head) {
      repos.push({
        repoId: r.repoId,
        repoName: r.repoName,
        state: 'not_ready',
        env: null,
        reason: `${r.repoName}: the release branch has not been read yet`,
      });
      continue;
    }
    const head = r.head;
    const problems = r.envs.map((e) => ({ e, problem: envProblem(r.repoName, head, e) }));
    const ok = problems.find((p) => p.problem === null);
    if (!ok) {
      const first = problems[0];
      repos.push({
        repoId: r.repoId,
        repoName: r.repoName,
        state: 'not_ready',
        env: first?.e.name ?? null,
        reason: first?.problem ?? null,
      });
      continue;
    }
    const liveMiss = r.live.find((l) => l.requires?.satisfied !== true);
    if (liveMiss) {
      const why = liveMiss.requires ? liveMiss.requires.missing.join('; ') : 'requirements not checked yet';
      repos.push({
        repoId: r.repoId,
        repoName: r.repoName,
        state: 'not_ready',
        env: liveMiss.name,
        reason: `${r.repoName}: not ready to go out on ${liveMiss.label}: ${why}`,
      });
      continue;
    }
    repos.push({ repoId: r.repoId, repoName: r.repoName, state: 'ready', env: ok.e.name, reason: null });
  }
  const checked = repos.filter((r) => r.state === 'ready');
  const notReady = repos.filter((r) => r.state === 'not_ready');
  const reasons = notReady.map((r) => r.reason as string);
  if (checked.length === 0 && notReady.length === 0) reasons.push(NO_CHECKED_REPO);
  const ready = checked.length > 0 && notReady.length === 0;
  const key = ready
    ? checked
        .map((r) => `${r.repoId}@${heads[r.repoId]}`)
        .sort()
        .join(',')
    : null;
  return { ready, key, heads, repos, reasons };
}
