import {
  APP_ERROR_TEXT,
  type AppCommandResult,
  type AppErrorCode,
  type AppProviderId,
  appInstance,
  type IntegrationScope,
  type IntegrationStatus,
} from '@aom/shared';
import { AppTokenBroker } from '../apps/broker.ts';
import { APP_PROVIDERS } from '../apps/providers.ts';
import { AppKeyStore, pemSecrets } from '../apps/store.ts';
import { type AppConnectInput, type AppProviderFactory, AppTokenError } from '../apps/types.ts';
import { redact, registerSecret, unregisterSecret } from '../secrets/redact.ts';
import { type AdapterEnv, baseStatus, type IntegrationAdapter, type Outcome } from './types.ts';

const STATUS_TTL_MS = 5 * 60_000;
const UNREACHABLE: ReadonlySet<AppErrorCode> = new Set(['unreachable', 'rate_limited']);

const errOf = (err: unknown): AppTokenError =>
  err instanceof AppTokenError ? err : new AppTokenError('unexpected', APP_ERROR_TEXT.unexpected);

/**
 * An automated app (one installation of one app) on this workstation, generic over the provider. The key is stored
 * sealed only after the provider verified it; tokens come from the broker and stay in memory. Connecting from the web goes
 * through the organization's Settings > Automated apps (an Owner action), not the workstation's own Integrations page.
 */
export class AutomatedAppIntegration implements IntegrationAdapter {
  private ownBroker: AppTokenBroker | undefined;
  private readonly checked = new Map<string, { at: number; error?: AppTokenError }>();

  constructor(
    readonly kind: AppProviderId,
    private readonly env: AdapterEnv,
    private readonly opts: { providers?: Record<AppProviderId, AppProviderFactory> } = {},
  ) {}

  scopeOf(): IntegrationScope {
    return 'workstation';
  }

  private factory(): AppProviderFactory {
    return (this.opts.providers ?? APP_PROVIDERS)[this.kind];
  }

  /** The runner's broker, or one of this adapter's own (CLI, tests). */
  broker(): AppTokenBroker {
    if (this.env.apps) return this.env.apps;
    if (!this.ownBroker) {
      if (!this.env.sealKey) throw new Error('this runner cannot encrypt local secrets');
      this.ownBroker = new AppTokenBroker({
        store: new AppKeyStore(this.env.paths.secrets, this.env.sealKey),
        fetch: this.env.fetch,
        now: () => this.env.now().getTime(),
        ...(this.opts.providers ? { providers: this.opts.providers } : {}),
      });
    }
    return this.ownBroker;
  }

  async instances(): Promise<string[]> {
    try {
      return this.broker()
        .store.list()
        .filter((a) => a.provider === this.kind)
        .map((a) => a.instance);
    } catch {
      return [];
    }
  }

  async status(instance: string): Promise<IntegrationStatus> {
    const now = this.env.now();
    let broker: AppTokenBroker;
    try {
      broker = this.broker();
    } catch (err) {
      return baseStatus(this.kind, instance, 'workstation', now, 'unavailable', {
        detail: errOf(err).message,
      });
    }
    const app = broker.store.get(instance);
    if (!app || app.provider !== this.kind)
      return baseStatus(this.kind, instance, 'workstation', now, 'not_connected', {
        detail: 'This app is not connected on this workstation.',
      });
    const last = this.checked.get(instance);
    let error: AppTokenError | undefined = last?.error;
    if (!last || now.getTime() - last.at > STATUS_TTL_MS) {
      try {
        const s = await broker.check(instance);
        error = s.suspended
          ? new AppTokenError('installation_suspended', APP_ERROR_TEXT.installation_suspended)
          : undefined;
      } catch (err) {
        error = errOf(err);
      }
      this.checked.set(instance, { at: now.getTime(), ...(error ? { error } : {}) });
    }
    const health = broker.health(instance);
    // A failed mint or a twice-refused token after the last check wins over an older healthy check.
    if (!error && health.error && health.error.at >= (health.refreshedAt ?? 0))
      error = new AppTokenError(health.error.code, health.error.message);
    const id = app.identity;
    const common: Partial<IntegrationStatus> = {
      method: 'app_key',
      account: id.botLogin,
      site: id.account,
      savedAt: app.savedAt,
      ...(health.refreshedAt ? { refreshedAt: new Date(health.refreshedAt).toISOString() } : {}),
    };
    if (!error)
      return baseStatus(this.kind, instance, 'workstation', now, 'connected', {
        ...common,
        ...(id.missingPermissions.length ? { missingScopes: id.missingPermissions } : {}),
      });
    return baseStatus(
      this.kind,
      instance,
      'workstation',
      now,
      UNREACHABLE.has(error.code) ? 'unreachable' : 'refused',
      {
        ...common,
        errorCode: error.code,
        detail: redact(error.message || APP_ERROR_TEXT[error.code]).slice(0, 400),
      },
    );
  }

  async test(instance: string): Promise<IntegrationStatus> {
    const r = await this.verifyStored(instance);
    this.checked.set(instance, {
      at: this.env.now().getTime(),
      ...(r.ok ? {} : { error: new AppTokenError(r.code ?? 'unexpected', r.message ?? '') }),
    });
    return this.status(instance);
  }

  /** Re-verifies a stored app; a changed identity is written back and the cached tokens are dropped. */
  async verifyStored(instance: string): Promise<AppCommandResult> {
    const broker = this.broker();
    const app = broker.store.get(instance);
    if (!app)
      return {
        ok: false,
        instance,
        code: 'installation_not_found',
        message: 'This app is not connected on this workstation.',
      };
    try {
      const identity = await this.factory()
        .create(
          { ...app, identity: app.identity },
          { fetch: this.env.fetch, now: () => this.env.now().getTime() },
        )
        .verify();
      if (JSON.stringify(identity) !== JSON.stringify(app.identity)) {
        broker.store.put(instance, { ...app, identity });
        broker.invalidate(instance);
      }
      return { ok: true, instance, identity };
    } catch (err) {
      const e = errOf(err);
      return { ok: false, instance, code: e.code, message: redact(e.message).slice(0, 300) };
    }
  }

  /**
   * Verifies the input with the provider and stores the key only then. Without an installation, one installation is
   * used; several give `choose_installation` with the list. A key for another app than the stored one is refused.
   */
  async connectApp(
    input: AppConnectInput,
    opts: {
      local?: boolean;
      ref?: { orgId: string; integrationId: string };
      /** The instance this key must belong to (replacing a key): another app or installation is `app_mismatch`. */
      expect?: string;
    } = {},
  ): Promise<AppCommandResult> {
    const secrets = pemSecrets(input.privateKey);
    for (const s of secrets) registerSecret(s);
    let stored = false;
    try {
      const deps = { fetch: this.env.fetch, now: () => this.env.now().getTime() };
      const factory = this.factory();
      let installationId = input.installationId;
      if (!installationId) {
        const list = await factory.installations(input, deps);
        if (list.length === 0)
          return {
            ok: false,
            code: 'installation_not_found',
            message: 'The app is not installed on any account yet.',
          };
        if (list.length > 1)
          return {
            ok: false,
            code: 'choose_installation',
            message: APP_ERROR_TEXT.choose_installation,
            installations: list,
          };
        installationId = (list[0] as { id: string }).id;
      }
      const identity = await factory.create({ ...input, installationId }, deps).verify();
      const instance = appInstance(identity.appId, identity.installationId);
      const broker = this.broker();
      if (opts.expect && opts.expect !== instance)
        return { ok: false, instance, code: 'app_mismatch', message: APP_ERROR_TEXT.app_mismatch };
      const cur = broker.store.get(instance);
      if (cur && cur.provider !== this.kind)
        return { ok: false, instance, code: 'app_mismatch', message: APP_ERROR_TEXT.app_mismatch };
      const refs = [...(cur?.refs ?? [])];
      if (
        opts.ref &&
        !refs.some((r) => r.orgId === opts.ref?.orgId && r.integrationId === opts.ref?.integrationId)
      )
        refs.push(opts.ref);
      broker.store.put(instance, {
        provider: this.kind,
        host: input.host || 'github.com',
        appRef: input.appRef,
        appId: identity.appId,
        installationId: identity.installationId,
        privateKey: input.privateKey,
        identity,
        refs,
        local: (cur?.local ?? false) || !!opts.local,
        savedAt: this.env.now().toISOString(),
      });
      stored = true;
      broker.invalidate(instance);
      this.checked.delete(instance);
      this.env.touchRecheck();
      return { ok: true, instance, identity };
    } catch (err) {
      const e = errOf(err);
      return { ok: false, code: e.code, message: redact(e.message).slice(0, 300) };
    } finally {
      // Stored: the store keeps the key registered. Not stored: nothing should stay in the registry.
      if (!stored) for (const s of secrets) unregisterSecret(s);
    }
  }

  async connect(instance: string, method: string, fields: Record<string, string>): Promise<Outcome> {
    if (method !== 'app_key')
      return { error: 'This method cannot be connected from here.', code: 'unsupported' };
    const [appRef = '', inst] = (
      fields.appRef ? `${fields.appRef}:${fields.installationId ?? ''}` : instance
    ).split(':');
    const r = await this.connectApp({
      host: fields.host || 'github.com',
      appRef,
      ...(inst ? { installationId: inst } : {}),
      privateKey: fields.privateKey ?? '',
    });
    if (!r.ok || !r.instance)
      return {
        error: `${r.message ?? APP_ERROR_TEXT[r.code ?? 'unexpected']} Nothing was saved.`,
        code: r.code === 'unreachable' || r.code === 'rate_limited' ? 'failed' : 'refused',
      };
    return this.status(r.instance);
  }

  async remove(instance: string): Promise<Outcome> {
    const broker = this.broker();
    broker.store.remove(instance);
    broker.invalidate(instance);
    this.checked.delete(instance);
    this.env.touchRecheck();
    return this.status(instance);
  }
}
