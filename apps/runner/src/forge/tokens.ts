import { existsSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import type { ConnectableForge } from '@aom/shared';
import { type ZodType, z } from 'zod';
import { SealedFile, unreadableMessage } from '../secrets/sealed-file.ts';

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
 * `<data dir>/secrets/git-tokens.json`, encrypted with this runner's key (mode 0600 in a 0700 directory), on this
 * workstation only. Status reported to
 * the server says connected or not, never the token.
 */
export interface TokenStore {
  /** `organization` is required to find an Azure DevOps token (PATs are organization-scoped); other providers ignore it. */
  get(provider: ConnectableForge, host: string, organization?: string): StoredToken | undefined;
  set(t: Omit<StoredToken, 'savedAt'>): void;
  /** Removes only that organization's token for Azure DevOps. */
  remove(provider: ConnectableForge, host: string, organization?: string): boolean;
  list(): Array<Omit<StoredToken, 'token'>>;
  /** Why the saved tokens are not available (the file cannot be read), if so. Never holds a secret. */
  problem?(): string | undefined;
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

const StoredTokenSchema = z
  .object({
    provider: z.string(),
    host: z.string(),
    token: z.string().min(1),
    user: z.string().optional(),
    organization: z.string().optional(),
    savedAt: z.string(),
  })
  .passthrough();
const StoredTokensSchema = z.record(z.string(), StoredTokenSchema) as unknown as ZodType<
  Record<string, StoredToken>
>;

/** The old plaintext file: keep every entry that has the token shape, drop the rest (one bad entry never fails it). */
function legacyTokens(raw: unknown): Record<string, StoredToken> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, StoredToken> = {};
  for (const [k, v] of Object.entries(raw)) {
    const p = StoredTokenSchema.safeParse(v);
    if (p.success) out[k] = p.data as StoredToken;
  }
  return out;
}

export const TOKENS_UNREADABLE = unreadableMessage(
  'git host tokens',
  'Connect GitLab, Bitbucket or Azure DevOps again (Integrations page or `guildwise-runner git-connect <provider>`).',
);

export class FileTokenStore implements TokenStore {
  private readonly sealed: SealedFile<Record<string, StoredToken>>;
  private unreadable = false;

  constructor(
    private readonly file: string,
    keyOf: (fileName: string) => Buffer,
    private readonly opts: { warn?: (message: string) => void } = {},
  ) {
    this.sealed = new SealedFile(file, keyOf, StoredTokensSchema, (v) =>
      Object.values(v).map((t) => t.token),
    );
  }

  private read(): Record<string, StoredToken> {
    const r = this.sealed.open({ legacy: legacyTokens });
    if (r.state === 'unreadable') {
      if (!this.unreadable) this.opts.warn?.(TOKENS_UNREADABLE);
      this.unreadable = true;
      return {};
    }
    this.unreadable = false;
    if (r.state === 'missing') return {};
    // the temp name the plaintext store used: after a crash it may still hold tokens in plaintext
    if (r.migrated) rmSync(`${this.file}.tmp`, { force: true });
    return migrate(r.value);
  }

  private write(data: Record<string, StoredToken>): void {
    // never overwrite a file that cannot be read: it may hold every other token, sealed with an older key
    if (this.sealed.open({ legacy: legacyTokens }).state === 'unreadable') {
      const moved = this.sealed.quarantine();
      this.opts.warn?.(
        `${TOKENS_UNREADABLE} The unreadable file was kept as ${moved ? basename(moved) : 'it was'}.`,
      );
    }
    this.sealed.save(data);
  }

  problem(): string | undefined {
    this.read();
    return this.unreadable ? TOKENS_UNREADABLE : undefined;
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
