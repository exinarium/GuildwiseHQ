import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { type ZodType, z } from 'zod';
import { SealedFile, unreadableMessage } from '../secrets/sealed-file.ts';

/** A "size check status token" (a fine-grained token with Commit statuses: write only). Held on this workstation only. */
export interface StoredStatusToken {
  provider: 'github';
  host: string;
  token: string;
  savedAt: string;
}

export const STATUS_TOKENS_UNREADABLE = unreadableMessage(
  'status tokens',
  'Set the status token again with `guildwise-runner status-token github`.',
);

/**
 * Tokens that post commit statuses (the hard size check). A store of its own: never the git host login, never the
 * reviewer's comment-only token (`reviewer-tokens.json`), never the git tokens. Nothing here reaches the server except
 * the keys (`provider@host`), never a value.
 */
export interface StatusTokenStore {
  get(provider: 'github', host: string): StoredStatusToken | undefined;
  set(provider: 'github', host: string, token: string): void;
  remove(provider: 'github', host: string): boolean;
  /** Keys (`github@github.com`) with a token; never a value. */
  list(): Array<{ key: string; provider: 'github'; host: string; savedAt: string }>;
  /** Set when the saved tokens cannot be read (never holds a secret). */
  problem(): string | undefined;
}

export const statusTokenKey = (provider: string, host: string): string => `${provider}@${host.toLowerCase()}`;

const StoredSchema = z.record(
  z.string(),
  z.object({
    provider: z.literal('github'),
    host: z.string(),
    token: z.string().min(1),
    savedAt: z.string(),
  }),
) as unknown as ZodType<Record<string, StoredStatusToken>>;

export class FileStatusTokenStore implements StatusTokenStore {
  private readonly sealed: SealedFile<Record<string, StoredStatusToken>>;
  private unreadable = false;

  constructor(
    private readonly file: string,
    fileKey: (fileName: string) => Buffer,
    private readonly opts: { warn?: (message: string) => void } = {},
  ) {
    this.sealed = new SealedFile(file, fileKey, StoredSchema, (v) => Object.values(v).map((t) => t.token));
  }

  private read(): Record<string, StoredStatusToken> {
    const r = this.sealed.open();
    if (r.state === 'unreadable') {
      if (!this.unreadable) this.opts.warn?.(STATUS_TOKENS_UNREADABLE);
      this.unreadable = true;
      return {};
    }
    this.unreadable = false;
    return r.state === 'ok' ? r.value : {};
  }

  private write(data: Record<string, StoredStatusToken>): void {
    // never overwrite a file that cannot be read: it may hold other tokens, sealed with an older key
    if (this.sealed.open().state === 'unreadable') {
      const moved = this.sealed.quarantine();
      this.opts.warn?.(
        `${STATUS_TOKENS_UNREADABLE} The unreadable file was kept as ${moved ? basename(moved) : 'it was'}.`,
      );
    }
    this.sealed.save(data);
  }

  problem(): string | undefined {
    this.read();
    return this.unreadable ? STATUS_TOKENS_UNREADABLE : undefined;
  }

  get(provider: 'github', host: string) {
    return this.read()[statusTokenKey(provider, host)];
  }

  set(provider: 'github', host: string, token: string) {
    const data = this.read();
    data[statusTokenKey(provider, host)] = {
      provider,
      host: host.toLowerCase(),
      token,
      savedAt: new Date().toISOString(),
    };
    this.write(data);
  }

  remove(provider: 'github', host: string) {
    const data = this.read();
    const k = statusTokenKey(provider, host);
    if (!data[k]) return false;
    delete data[k];
    this.write(data);
    return true;
  }

  list() {
    if (!existsSync(this.file)) return [];
    return Object.entries(this.read()).map(([key, v]) => ({
      key,
      provider: v.provider,
      host: v.host,
      savedAt: v.savedAt,
    }));
  }
}

/** In-memory store for tests. */
export class MemoryStatusTokenStore implements StatusTokenStore {
  private readonly m = new Map<string, StoredStatusToken>();
  problemText: string | undefined;
  get(provider: 'github', host: string) {
    return this.m.get(statusTokenKey(provider, host));
  }
  set(provider: 'github', host: string, token: string) {
    this.m.set(statusTokenKey(provider, host), {
      provider,
      host: host.toLowerCase(),
      token,
      savedAt: new Date().toISOString(),
    });
  }
  remove(provider: 'github', host: string) {
    return this.m.delete(statusTokenKey(provider, host));
  }
  list() {
    return [...this.m.entries()].map(([key, v]) => ({ key, provider: v.provider, host: v.host, savedAt: v.savedAt }));
  }
  problem() {
    return this.problemText;
  }
}
