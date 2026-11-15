import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/** The file the registry of one runner root is kept in (repository -> app label; never a credential). */
export const APP_REPOS_FILE = 'app-repos.json';

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
  /** Roots whose entries are kept on disk, so a restart does not forget which repositories post as an app. */
  private readonly persisted = new Set<string>();

  /**
   * Keeps one root's entries in `<root>/app-repos.json` from now on, loading what an earlier process left there. An
   * unreadable file loads nothing (the next plan registers the repositories again).
   */
  persist(root: string): void {
    const key = resolve(root);
    this.persisted.add(key);
    const file = join(key, APP_REPOS_FILE);
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { repos?: unknown };
      if (!Array.isArray(raw.repos)) return;
      let m = this.byRoot.get(key);
      for (const e of raw.repos as Array<Partial<AppRepoEntry>>) {
        if (typeof e?.remoteUrlNormalized !== 'string' || !e.remoteUrlNormalized) continue;
        if (typeof e.integrationId !== 'string' || typeof e.label !== 'string') continue;
        if (!m) {
          m = new Map();
          this.byRoot.set(key, m);
        }
        if (!m.has(e.remoteUrlNormalized))
          m.set(e.remoteUrlNormalized, {
            remoteUrlNormalized: e.remoteUrlNormalized,
            integrationId: e.integrationId,
            label: e.label,
          });
      }
    } catch {
      // a damaged file: start empty for this root
    }
  }

  /** The view of one runner root. */
  forRoot(root: string): AppRepoRoot {
    const key = resolve(root);
    return {
      set: (remoteUrlNormalized, entry) => {
        let m = this.byRoot.get(key);
        if (!entry) {
          if (!m?.has(remoteUrlNormalized)) return;
          m.delete(remoteUrlNormalized);
          if (m.size === 0) this.byRoot.delete(key);
          this.save(key);
          return;
        }
        if (!m) {
          m = new Map();
          this.byRoot.set(key, m);
        }
        const prev = m.get(remoteUrlNormalized);
        m.set(remoteUrlNormalized, { ...entry, remoteUrlNormalized });
        if (prev?.integrationId !== entry.integrationId || prev?.label !== entry.label) this.save(key);
      },
      get: (remoteUrlNormalized) => this.byRoot.get(key)?.get(remoteUrlNormalized) ?? null,
    };
  }

  private save(key: string): void {
    if (!this.persisted.has(key)) return;
    const repos = [...(this.byRoot.get(key)?.values() ?? [])];
    const file = join(key, APP_REPOS_FILE);
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ repos }, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      // the in-memory registry still refuses; only the restart memory is lost
    }
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
    this.persisted.clear();
  }
}

export interface AppRepoRoot {
  /** Registers (or, with `null`, removes) a repository that posts as an app. */
  set(remoteUrlNormalized: string, entry: Omit<AppRepoEntry, 'remoteUrlNormalized'> | null): void;
  /** The entry registered under this root for a repository, if any. */
  get(remoteUrlNormalized: string): AppRepoEntry | null;
}

/** The process-wide registry (no credentials in it; entries are keyed by runner root, so pairings stay apart). */
export const appRepos = new AppRepoRegistry();

/** The env marker every git process that carries an app credential has. */
export const APP_GIT_MARKER = 'AOM_GIT_APP';

/** Refusal text of the tripwire. */
export const tripwireMessage = (repo: string, label: string): string =>
  `refusing to push: ${repo} posts as the app '${label}'; this push had no app credential, so nothing was pushed with another identity`;
