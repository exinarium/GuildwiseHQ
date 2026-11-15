import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { normalizeRemoteUrl, parseRemote, type ReviewerTokenFact } from '@aom/shared';
import { type ZodType, z } from 'zod';
import { SealedFile, unreadableMessage } from '../secrets/sealed-file.ts';

/** A comment-only token for one repository's pull requests. Held on this workstation only. */
export interface StoredReviewerToken {
  token: string;
  host: string;
  savedAt: string;
}

export const REVIEWER_TOKENS_UNREADABLE = unreadableMessage(
  'reviewer tokens',
  'Set the reviewer token again with `guildwise-runner reviewer-token set <remote url>`.',
);

/**
 * Reviewer tokens, keyed by the repository's normalized remote url. A separate store from the git host logins
 * (`git-tokens.json`): those can push, these must never be able to. Nothing here ever reaches the server.
 */
export interface ReviewerTokenStore {
  get(remoteUrl: string): StoredReviewerToken | undefined;
  has(remoteUrl: string): boolean;
  set(remoteUrl: string, token: string): void;
  remove(remoteUrl: string): boolean;
  /** Repositories with a token; never a value. */
  list(): Array<{ remote: string; host: string; savedAt: string }>;
  /** Set when the saved tokens cannot be read (never holds a secret). */
  problem(): string | undefined;
}

const keyOf = (remoteUrl: string): string => normalizeRemoteUrl(remoteUrl);
const hostOf = (remoteUrl: string): string => parseRemote(remoteUrl)?.host ?? '';

/**
 * What the workstation reports to the server for one repository: present or not, with the reason a token cannot be
 * used. Only GitHub is supported for posting in the first release.
 */
export function reviewerTokenFact(store: ReviewerTokenStore, remoteUrl: string): ReviewerTokenFact {
  if (store.problem()) return { present: false, problem: 'unreadable' };
  if (!store.has(remoteUrl)) return { present: false };
  if (parseRemote(remoteUrl)?.kind !== 'github') return { present: false, problem: 'unsupported_host' };
  return { present: true };
}

const StoredSchema = z.record(
  z.string(),
  z.object({ token: z.string().min(1), host: z.string(), savedAt: z.string() }),
) as unknown as ZodType<Record<string, StoredReviewerToken>>;

export class FileReviewerTokenStore implements ReviewerTokenStore {
  private readonly sealed: SealedFile<Record<string, StoredReviewerToken>>;
  private unreadable = false;

  constructor(
    private readonly file: string,
    fileKey: (fileName: string) => Buffer,
    private readonly opts: { warn?: (message: string) => void } = {},
  ) {
    this.sealed = new SealedFile(file, fileKey, StoredSchema, (v) => Object.values(v).map((t) => t.token));
  }

  private read(): Record<string, StoredReviewerToken> {
    const r = this.sealed.open();
    if (r.state === 'unreadable') {
      if (!this.unreadable) this.opts.warn?.(REVIEWER_TOKENS_UNREADABLE);
      this.unreadable = true;
      return {};
    }
    this.unreadable = false;
    return r.state === 'ok' ? r.value : {};
  }

  private write(data: Record<string, StoredReviewerToken>): void {
    // never overwrite a file that cannot be read: it may hold other tokens, sealed with an older key
    if (this.sealed.open().state === 'unreadable') {
      const moved = this.sealed.quarantine();
      this.opts.warn?.(
        `${REVIEWER_TOKENS_UNREADABLE} The unreadable file was kept as ${moved ? basename(moved) : 'it was'}.`,
      );
    }
    this.sealed.save(data);
  }

  problem(): string | undefined {
    this.read();
    return this.unreadable ? REVIEWER_TOKENS_UNREADABLE : undefined;
  }

  get(remoteUrl: string) {
    return this.read()[keyOf(remoteUrl)];
  }

  has(remoteUrl: string) {
    return this.get(remoteUrl) !== undefined;
  }

  set(remoteUrl: string, token: string) {
    const data = this.read();
    data[keyOf(remoteUrl)] = { token, host: hostOf(remoteUrl), savedAt: new Date().toISOString() };
    this.write(data);
  }

  remove(remoteUrl: string) {
    const data = this.read();
    const k = keyOf(remoteUrl);
    if (!data[k]) return false;
    delete data[k];
    this.write(data);
    return true;
  }

  list() {
    if (!existsSync(this.file)) return [];
    return Object.entries(this.read()).map(([remote, v]) => ({ remote, host: v.host, savedAt: v.savedAt }));
  }
}

/** In-memory store for tests. */
export class MemoryReviewerTokenStore implements ReviewerTokenStore {
  private readonly m = new Map<string, StoredReviewerToken>();
  problemText: string | undefined;
  get(remoteUrl: string) {
    return this.m.get(keyOf(remoteUrl));
  }
  has(remoteUrl: string) {
    return this.m.has(keyOf(remoteUrl));
  }
  set(remoteUrl: string, token: string) {
    this.m.set(keyOf(remoteUrl), { token, host: hostOf(remoteUrl), savedAt: new Date().toISOString() });
  }
  remove(remoteUrl: string) {
    return this.m.delete(keyOf(remoteUrl));
  }
  list() {
    return [...this.m.entries()].map(([remote, v]) => ({ remote, host: v.host, savedAt: v.savedAt }));
  }
  problem() {
    return this.problemText;
  }
}
