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
  /** `organization` is required to find an Azure DevOps token (PATs are organization-scoped); other providers ignore it. */
  get(provider: ConnectableForge, host: string, organization?: string): StoredToken | undefined;
  set(t: Omit<StoredToken, 'savedAt'>): void;
  /** Removes only that organization's token for Azure DevOps. */
  remove(provider: ConnectableForge, host: string, organization?: string): boolean;
  list(): Array<Omit<StoredToken, 'token'>>;
}

/**
 * `provider@host`, and for Azure DevOps `azure-devops@host#organization` (organization lower-cased): two organisations on
 * dev.azure.com each keep their own PAT.
 */
export const tokenKey = (p: string, h: string, org?: string): string =>
  p === 'azure-devops' && org?.trim()
    ? `${p}@${h.toLowerCase()}#${org.trim().toLowerCase()}`
    : `${p}@${h.toLowerCase()}`;

/** Moves an old `azure-devops@host` entry that carries an organization to its organization key (the new key wins). */
function migrate(data: Record<string, StoredToken>): Record<string, StoredToken> {
  const out: Record<string, StoredToken> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v?.provider === 'azure-devops' && v.organization && !k.includes('#')) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(data)) {
    if (v?.provider === 'azure-devops' && v.organization && !k.includes('#')) {
      const nk = tokenKey(v.provider, v.host, v.organization);
      if (!out[nk]) out[nk] = v;
    }
  }
  return out;
}

export class FileTokenStore implements TokenStore {
  constructor(private readonly file: string) {}

  private read(): Record<string, StoredToken> {
    try {
      return migrate(JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, StoredToken>);
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

  get(provider: ConnectableForge, host: string, organization?: string) {
    return this.read()[tokenKey(provider, host, organization)];
  }

  set(t: Omit<StoredToken, 'savedAt'>) {
    const data = this.read();
    data[tokenKey(t.provider, t.host, t.organization)] = { ...t, savedAt: new Date().toISOString() };
    this.write(data);
  }

  remove(provider: ConnectableForge, host: string, organization?: string) {
    const data = this.read();
    const k = tokenKey(provider, host, organization);
    if (!data[k]) return false;
    delete data[k];
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
  get(provider: ConnectableForge, host: string, organization?: string) {
    return this.m.get(tokenKey(provider, host, organization));
  }
  set(t: Omit<StoredToken, 'savedAt'>) {
    this.m.set(tokenKey(t.provider, t.host, t.organization), { ...t, savedAt: new Date().toISOString() });
  }
  remove(provider: ConnectableForge, host: string, organization?: string) {
    return this.m.delete(tokenKey(provider, host, organization));
  }
  list() {
    return [...this.m.values()].map(({ token: _t, ...rest }) => rest);
  }
}
