import type { DirectUnavailableReason, StorageErrorCode, StorageKind } from '@aom/shared';

/** A typed storage failure. The message is one sentence and never holds a token, key, path or file name. */
export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/** A received file spooled on this workstation's disk. */
export interface Spooled {
  file: string;
  size: number;
  sha256: string;
  contentType: string;
}

/** Where a file goes: sanitised folder segments below the connection's base, and the file name. */
export interface StorageTarget {
  folder: string[];
  name: string;
}

export interface StorageConnector {
  /** Writes and deletes a small probe file in the base folder. */
  probe(signal: AbortSignal): Promise<void>;
  /** Writes the spooled file without overwriting; a name clash is resolved by the connector (`-2`, `-3`...). */
  put(
    target: StorageTarget,
    file: Spooled,
    signal: AbortSignal,
  ): Promise<{ path: string; providerId?: string }>;
  /** Best-effort delete of a path returned by `put`. */
  delete(path: string, signal: AbortSignal): Promise<void>;
  /**
   * Strict delete of one file a `put` returned, confined to the destination's base before any I/O. Never a folder.
   * 'not_found' when the file is not there. Throws StorageError('invalid') for a path outside the base, and a typed
   * error for anything else.
   */
  deleteFile(
    ref: { path: string; providerId?: string },
    signal: AbortSignal,
  ): Promise<'deleted' | 'not_found'>;
}

/** A short-lived upload grant for the public browser (GWP-147). `url` and `cancelUrl` are secrets. */
export interface DirectGrant {
  provider: 'onedrive' | 'google_drive' | 's3';
  url: string;
  headers: Record<string, string>;
  chunkBytes: number | null;
  expiresAt: number;
  /** Runner only: where the provider will hold the staged object. */
  stagingRef: string;
  cancelUrl?: string;
}
export interface StagedInfo {
  size: number;
  /** The provider's own sha256 of the stored bytes (hex), when it exposes one. */
  sha256?: string;
  providerId?: string;
}
/** Staging folder below the connection's base folder or prefix. */
export const STAGING_FOLDER = '.guildwise-incoming';

/** Optional capability of the cloud connectors. Local and vault connectors do not have it (they relay). */
export interface DirectCapable {
  uploadOrigin(
    signal: AbortSignal,
    pageOrigin?: string,
  ): Promise<{ origin: string | null; reason: DirectUnavailableReason | null }>;
  grant(
    stagingName: string,
    file: { size: number; contentType: string; sha256: string },
    ttlMs: number,
    pageOrigin: string,
    signal: AbortSignal,
  ): Promise<DirectGrant>;
  /** Next byte the provider expects, or null when the upload cannot resume. */
  offset(g: DirectGrant, signal: AbortSignal, size: number): Promise<number | null>;
  stat(g: DirectGrant, signal: AbortSignal): Promise<StagedInfo | null>;
  read(
    g: DirectGrant,
    range: { start: number; end: number } | null,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
  promote(
    g: DirectGrant,
    info: StagedInfo,
    target: StorageTarget,
    signal: AbortSignal,
  ): Promise<{ path: string; providerId?: string }>;
  /** Cancels the session and deletes the staged object, best effort. */
  cancel(g: DirectGrant, signal: AbortSignal): Promise<void>;
  /** Deletes staging entries `keep` does not want. Returns how many went. */
  sweep(keep: (stagingName: string, modifiedAt: number) => boolean, signal: AbortSignal): Promise<number>;
}
export const isDirectCapable = (c: StorageConnector): c is StorageConnector & DirectCapable =>
  typeof (c as Partial<DirectCapable>).grant === 'function';

export type StorageConfig =
  | { kind: 'onedrive'; siteUrl?: string; driveId: string; baseFolder: string; baseItemId?: string }
  | { kind: 'google_drive'; baseFolder: string; baseFolderId?: string }
  | { kind: 's3'; endpoint: string; region: string; bucket: string; prefix: string; pathStyle: boolean }
  | { kind: 'local'; root: string }
  | { kind: 'vault'; vaultId: string; folder: string };

export type StorageAuth =
  | {
      type: 'oauth';
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      scope: string;
      account?: string;
    }
  | { type: 'keys'; accessKeyId: string; secretAccessKey: string; sessionToken?: string };

export interface StoredConnection {
  kind: StorageKind;
  savedAt: string;
  config: StorageConfig;
  auth?: StorageAuth;
  needsReauth?: boolean;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const PROBE_NAME = () => `.guildwise-probe-${Math.random().toString(16).slice(2, 10)}.txt`;
export const PROBE_BODY = 'guildwise storage probe\n';
