import type { AppErrorCode, AppIdentity, AppInstallation, AppProviderId } from '@aom/shared';

/**
 * The generic shape of an automated app (a bot identity the agents act as). Nothing here names a forge: each provider
 * is one implementation, registered in `providers.ts`.
 */

/** What a token is for: narrowed to some repositories and permissions where the provider allows it. */
export interface AppAccessScope {
  repositories?: string[];
  permissions?: Record<string, 'read' | 'write'>;
}

/** Runner-only: never serialized to the server, never logged, never written to disk. */
export interface AppAccessToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export type { AppIdentity };

/** A typed failure of an app call. The message is one sentence and never holds a value. */
export class AppTokenError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly opts: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'AppTokenError';
  }
}

/** What the runner keeps sealed for one installation of one app (`store.ts`). */
export interface StoredApp {
  provider: AppProviderId;
  host: string;
  /** What the user entered as the app reference (App ID or client ID). */
  appRef: string;
  appId: string;
  installationId: string;
  /** The PEM: the only secret. */
  privateKey: string;
  identity: AppIdentity;
  /** The organization registrations that use this copy. */
  refs: Array<{ orgId: string; integrationId: string }>;
  /** Connected from the terminal on this workstation. */
  local: boolean;
  savedAt: string;
}

/** What a connect starts from, before anything is stored. */
export interface AppConnectInput {
  host: string;
  appRef: string;
  installationId?: string;
  privateKey: string;
}

export interface AppProviderDeps {
  fetch: typeof fetch;
  now: () => number;
}

/** One installation of one automated app. */
export interface AutomatedAppProvider {
  readonly provider: AppProviderId;
  /** The identity from the last verify (stored with the key); no network. */
  describe(): AppIdentity;
  /** Light health check: reads the installation (no token minted). Throws AppTokenError. */
  status(): Promise<{ suspended: boolean }>;
  /** Full check used on save and Test: app, installation, one least-privilege token, bot user. */
  verify(): Promise<AppIdentity>;
  /** Mints a new token for the scope. No caching here: the broker caches. Throws AppTokenError. */
  mint(scope: AppAccessScope): Promise<AppAccessToken>;
}

export interface AppProviderFactory {
  readonly provider: AppProviderId;
  /** A provider for an input that is not stored yet (connect) or a stored app. */
  create(cfg: AppConnectInput & { identity?: AppIdentity }, deps: AppProviderDeps): AutomatedAppProvider;
  /** Before anything is stored: the installations of the app, to pick one when none was given. */
  installations(input: AppConnectInput, deps: AppProviderDeps): Promise<AppInstallation[]>;
}
