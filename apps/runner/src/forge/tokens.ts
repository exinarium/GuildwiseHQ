import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConnectableForge } from '@aom/shared';

/** A token held on this workstation. `user` is the git username (or the e-mail for Bitbucket Cloud). */
export interface StoredToken {
  provider: ConnectableForge;
  host: string;
  token: string;
  user?: string;
  /** Azure DevOps organization. */
  organization?: string;
  savedAt: string;
}

/**
 * Tokens for forges that have no CLI login (Azure DevOps PAT, Bitbucket API token, GitLab PAT without glab). Kept in
 * `<data dir>/secrets/git-tokens.json`, mode 0600 in a 0700 directory, on this workstation only. Status reported to
 * the server says connected or not, never the token.
 */
export interface TokenStore {
  get(provider: ConnectableForge, host: string): StoredToken | undefined;
  set(t: Omit<StoredToken, 'savedAt'>): void;
  remove(provider: ConnectableForge, host: string): boolean;
  list(): Array<Omit<StoredToken, 'token'>>;
}

const key = (p: string, h: string) => `${p}@${h.toLowerCase()}`;

export class FileTokenStore implements TokenStore {
  constructor(private readonly file: string) {}

  private read(): Record<string, StoredToken> {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, StoredToken>;
    } catch {
      return {};
    }
  }

  private write(data: Record<string, StoredToken>): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
      chmodSync(dirname(this.file), 0o700);
    } catch {
      // Windows: the data dir sits in the user's profile
    }
  }

  get(provider: ConnectableForge, host: string) {
    return this.read()[key(provider, host)];
  }

  set(t: Omit<StoredToken, 'savedAt'>) {
    const data = this.read();
    data[key(t.provider, t.host)] = { ...t, savedAt: new Date().toISOString() };
    this.write(data);
  }

  remove(provider: ConnectableForge, host: string) {
    const data = this.read();
    if (!data[key(provider, host)]) return false;
    delete data[key(provider, host)];
    this.write(data);
    return true;
  }

  list() {
    if (!existsSync(this.file)) return [];
    return Object.values(this.read()).map(({ token: _t, ...rest }) => rest);
  }
}

/** In-memory store for tests. */
export class MemoryTokenStore implements TokenStore {
  private readonly m = new Map<string, StoredToken>();
  get(provider: ConnectableForge, host: string) {
    return this.m.get(key(provider, host));
  }
  set(t: Omit<StoredToken, 'savedAt'>) {
    this.m.set(key(t.provider, t.host), { ...t, savedAt: new Date().toISOString() });
  }
  remove(provider: ConnectableForge, host: string) {
    return this.m.delete(key(provider, host));
  }
  list() {
    return [...this.m.values()].map(({ token: _t, ...rest }) => rest);
  }
}
