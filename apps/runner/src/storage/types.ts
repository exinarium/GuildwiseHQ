import type { StorageErrorCode, StorageKind } from '@aom/shared';

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
}

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
