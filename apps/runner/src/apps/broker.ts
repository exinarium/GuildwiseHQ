import type { AppErrorCode, AppIdentity, AppProviderId } from '@aom/shared';
import { registerSecret, unregisterSecret } from '../secrets/redact.ts';
import { APP_PROVIDERS } from './providers.ts';
import type { AppKeyStore } from './store.ts';
import {
  type AppAccessScope,
  type AppAccessToken,
  type AppProviderFactory,
  AppTokenError,
  type AutomatedAppProvider,
} from './types.ts';

/** A cached token is handed out while more than this is left of its life; otherwise a new one is minted. */
export const REFRESH_MARGIN_MS = 10 * 60_000;
/** How long a replaced token stays registered for redaction (a log line written just after a refresh is still masked). */
export const UNREGISTER_DELAY_MS = 5 * 60_000;

export interface AppHealth {
  refreshedAt?: number;
  error?: { code: AppErrorCode; message: string; at: number };
}

/** The same scope always gives the same key: repositories and permission names sorted. */
export function scopeKey(instance: string, scope: AppAccessScope = {}): string {
  const repos = [...(scope.repositories ?? [])].sort();
  const perms = Object.entries(scope.permissions ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return `${instance}|${JSON.stringify([repos, perms])}`;
}

const isRejected = (err: unknown): boolean => err instanceof AppTokenError && err.code === 'token_rejected';

/**
 * Mints short-lived app access tokens on demand and keeps them in memory only (nothing here touches the disk). Callers
 * ask for every operation, so a shift of any length always gets a token with at least 10 minutes left; concurrent
 * callers share one mint; a 401 is retried once with a new token.
 */
export class AppTokenBroker {
  private readonly cache = new Map<string, AppAccessToken>();
  private readonly inflight = new Map<string, Promise<AppAccessToken>>();
  private readonly providers = new Map<string, AutomatedAppProvider>();
  private readonly healthOf = new Map<string, AppHealth>();
  private readonly holdUntil = new Map<string, { until: number; error: AppTokenError }>();

  constructor(
    private readonly deps: {
      store: AppKeyStore;
      fetch: typeof fetch;
      now: () => number;
      providers?: Record<AppProviderId, AppProviderFactory>;
      onChange?: (instance: string) => void;
      unregisterDelayMs?: number;
    },
  ) {}

  /** The sealed key store this broker mints from. */
  get store(): AppKeyStore {
    return this.deps.store;
  }

  private provider(instance: string): AutomatedAppProvider {
    const have = this.providers.get(instance);
    if (have) return have;
    const app = this.deps.store.get(instance);
    if (!app) throw new AppTokenError('installation_not_found', 'This app is not connected on this workstation.');
    const factory = (this.deps.providers ?? APP_PROVIDERS)[app.provider];
    const p = factory.create(
      {
        host: app.host,
        appRef: app.appRef,
        installationId: app.installationId,
        privateKey: app.privateKey,
        identity: app.identity,
      },
      { fetch: this.deps.fetch, now: this.deps.now },
    );
    this.providers.set(instance, p);
    return p;
  }

  identity(instance: string): AppIdentity | undefined {
    return this.deps.store.get(instance)?.identity;
  }

  health(instance: string): AppHealth {
    return { ...(this.healthOf.get(instance) ?? {}) };
  }

  private setHealth(instance: string, h: AppHealth): void {
    this.healthOf.set(instance, h);
    this.deps.onChange?.(instance);
  }

  private fail(instance: string, err: AppTokenError): void {
    const cur = this.healthOf.get(instance) ?? {};
    this.setHealth(instance, { ...cur, error: { code: err.code, message: err.message, at: this.deps.now() } });
  }

  private retire(token: string): void {
    const delay = this.deps.unregisterDelayMs ?? UNREGISTER_DELAY_MS;
    if (delay <= 0) {
      unregisterSecret(token);
      return;
    }
    setTimeout(() => unregisterSecret(token), delay).unref?.();
  }

  /** A token with more than 10 minutes left, from memory or freshly minted. Single-flight per cache key. */
  async getAccessToken(instance: string, scope: AppAccessScope = {}): Promise<AppAccessToken> {
    const key = scopeKey(instance, scope);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - this.deps.now() > REFRESH_MARGIN_MS) return cached;
    const held = this.holdUntil.get(key);
    if (held && held.until > this.deps.now()) throw held.error;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.mint(instance, key, scope).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async mint(instance: string, key: string, scope: AppAccessScope): Promise<AppAccessToken> {
    try {
      const t = await this.provider(instance).mint(scope);
      registerSecret(t.token);
      const old = this.cache.get(key);
      this.cache.set(key, t);
      if (old && old.token !== t.token) this.retire(old.token);
      this.holdUntil.delete(key);
      this.setHealth(instance, { refreshedAt: this.deps.now() });
      return t;
    } catch (err) {
      const e =
        err instanceof AppTokenError ? err : new AppTokenError('unexpected', 'The app token could not be minted.');
      if (e.code === 'rate_limited')
        this.holdUntil.set(key, { until: this.deps.now() + (e.opts.retryAfterMs ?? 60_000), error: e });
      this.fail(instance, e);
      throw e;
    }
  }

  private drop(key: string): void {
    const old = this.cache.get(key);
    this.cache.delete(key);
    if (old) this.retire(old.token);
  }

  /**
   * Runs `fn` with a token. On a 401 (fn returns `{ status: 401 }` or throws `token_rejected`) the token is dropped, a new
   * one minted and `fn` retried once; a second refusal throws `AppTokenError('token_rejected')` and marks the app in error.
   */
  async withToken<T>(
    instance: string,
    scope: AppAccessScope | undefined,
    fn: (token: string) => Promise<T & { status?: number }>,
  ): Promise<T> {
    const key = scopeKey(instance, scope);
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await this.getAccessToken(instance, scope);
      let refused = false;
      let out: (T & { status?: number }) | undefined;
      try {
        out = await fn(t.token);
        refused = out?.status === 401;
      } catch (err) {
        if (!isRejected(err)) throw err;
        refused = true;
      }
      if (!refused) return out as T;
      if (this.cache.get(key)?.token === t.token) this.drop(key);
    }
    const err = new AppTokenError('token_rejected', 'GitHub refused the access token of this app twice in a row.', {
      status: 401,
    });
    this.fail(instance, err);
    throw err;
  }

  /** Light health check (no token minted); failures are recorded like a failed mint. */
  async check(instance: string): Promise<{ suspended: boolean }> {
    try {
      return await this.provider(instance).status();
    } catch (err) {
      if (err instanceof AppTokenError) this.fail(instance, err);
      throw err;
    }
  }

  /** The key was removed or replaced: drop the provider, the cached tokens and their redaction entries (later). */
  invalidate(instance: string): void {
    this.providers.delete(instance);
    this.healthOf.delete(instance);
    for (const key of [...this.cache.keys()]) if (key.startsWith(`${instance}|`)) this.drop(key);
    for (const key of [...this.holdUntil.keys()]) if (key.startsWith(`${instance}|`)) this.holdUntil.delete(key);
  }
}
