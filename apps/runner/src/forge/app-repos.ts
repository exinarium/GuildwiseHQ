import { resolve, sep } from 'node:path';

/**
 * Fail-closed push tripwire: which repositories post as an app, per runner root (every clone and worktree of one
 * pairing lives under its root, and several pairings can share one process). It holds no credential and never chooses
 * an identity: `git()` only uses it to refuse a push that carries no app credential.
 */
export interface AppRepoEntry {
  remoteUrlNormalized: string;
  integrationId: string;
  label: string;
}

export class AppRepoRegistry {
  private readonly byRoot = new Map<string, Map<string, AppRepoEntry>>();

  /** The view of one runner root. */
  forRoot(root: string): AppRepoRoot {
    const key = resolve(root);
    return {
      set: (remoteUrlNormalized, entry) => {
        let m = this.byRoot.get(key);
        if (!entry) {
          m?.delete(remoteUrlNormalized);
          if (m && m.size === 0) this.byRoot.delete(key);
          return;
        }
        if (!m) {
          m = new Map();
          this.byRoot.set(key, m);
        }
        m.set(remoteUrlNormalized, { ...entry, remoteUrlNormalized });
      },
    };
  }

  /** True when some root holding `cwd` has registered app repositories (a cheap pre-check before reading the remote). */
  watches(cwd: string): boolean {
    return this.rootsOf(cwd).length > 0;
  }

  /** The app entry for a push from `cwd` to `remoteUrlNormalized`, if any root holding `cwd` registered one. */
  find(cwd: string, remoteUrlNormalized: string): AppRepoEntry | null {
    for (const m of this.rootsOf(cwd)) {
      const hit = m.get(remoteUrlNormalized);
      if (hit) return hit;
    }
    return null;
  }

  private rootsOf(cwd: string): Array<Map<string, AppRepoEntry>> {
    const at = resolve(cwd);
    const out: Array<Map<string, AppRepoEntry>> = [];
    for (const [root, m] of this.byRoot) if (at === root || at.startsWith(root + sep)) out.push(m);
    return out;
  }

  /** Tests only. */
  clear(): void {
    this.byRoot.clear();
  }
}

export interface AppRepoRoot {
  /** Registers (or, with `null`, removes) a repository that posts as an app. */
  set(remoteUrlNormalized: string, entry: Omit<AppRepoEntry, 'remoteUrlNormalized'> | null): void;
}

/** The process-wide registry (no credentials in it; entries are keyed by runner root, so pairings stay apart). */
export const appRepos = new AppRepoRegistry();

/** The env marker every git process that carries an app credential has. */
export const APP_GIT_MARKER = 'AOM_GIT_APP';

/** Refusal text of the tripwire. */
export const tripwireMessage = (repo: string, label: string): string =>
  `refusing to push: ${repo} posts as the app '${label}'; this push had no app credential, so nothing was pushed with another identity`;
