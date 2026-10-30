import type { IntegrationScope, IntegrationStatus } from '@aom/shared';
import { checkServiceAccount, parseServiceAccountKey } from '../outbound-delivery/google-sheets.ts';
import { sheetsStore } from '../outbound-delivery/send.ts';
import { type AdapterEnv, baseStatus, type IntegrationAdapter, type Outcome } from './types.ts';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Google Sheets on this workstation, for an automation's output. A service account key is saved in
 * `secrets/google-sheets.json`, encrypted with this runner's key, only after Google gave a token for it. The instance is
 * the service account's e-mail (not secret: the user shares the sheet with it).
 */
export class GoogleSheetsIntegration implements IntegrationAdapter {
  readonly kind = 'google-sheets' as const;
  private readonly fetchImpl: Fetch;

  constructor(
    private readonly env: AdapterEnv,
    opts: { fetch?: Fetch } = {},
  ) {
    this.fetchImpl = opts.fetch ?? ((url, init) => this.env.fetch(url, init));
  }

  scopeOf(): IntegrationScope {
    return 'workstation';
  }

  private store() {
    if (!this.env.sealKey) throw new Error('this runner cannot encrypt local secrets');
    return sheetsStore(this.env.paths.secrets, this.env.sealKey);
  }

  async instances(): Promise<string[]> {
    try {
      return Object.keys(this.store().load()?.accounts ?? {});
    } catch {
      return [];
    }
  }

  async status(instance: string): Promise<IntegrationStatus> {
    const now = this.env.now();
    const sa = this.store().load()?.accounts[instance];
    if (!sa)
      return baseStatus('google-sheets', instance, 'workstation', now, 'not_connected', {
        detail: 'No service account key is saved for this account on this workstation.',
      });
    const r = await checkServiceAccount(sa, this.fetchImpl, () => now.getTime());
    if (r.ok)
      return baseStatus('google-sheets', instance, 'workstation', now, 'connected', {
        method: 'service_account',
        account: sa.clientEmail,
      });
    return baseStatus('google-sheets', instance, 'workstation', now, r.refused ? 'refused' : 'unreachable', {
      method: 'service_account',
      account: sa.clientEmail,
      detail: r.error.slice(0, 400),
    });
  }

  test(instance: string): Promise<IntegrationStatus> {
    return this.status(instance);
  }

  async connect(instance: string, method: string, fields: Record<string, string>): Promise<Outcome> {
    if (method !== 'service_account')
      return { error: 'This method cannot be connected from here.', code: 'unsupported' };
    const sa = parseServiceAccountKey(fields.keyJson ?? '');
    if ('error' in sa) return { error: sa.error, code: 'failed' };
    if (sa.clientEmail !== instance)
      return {
        error: `The key belongs to ${sa.clientEmail}: use that e-mail address as the service account. Nothing was saved.`,
        code: 'failed',
      };
    const r = await checkServiceAccount(sa, this.fetchImpl, () => this.env.now().getTime());
    if (!r.ok) return { error: `Google did not accept this key: ${r.error}. Nothing was saved.`, code: 'refused' };
    const store = this.store();
    const cur = store.load() ?? { accounts: {} };
    store.save({ accounts: { ...cur.accounts, [instance]: sa } });
    this.env.touchRecheck();
    return this.status(instance);
  }

  async remove(instance: string): Promise<Outcome> {
    const store = this.store();
    const cur = store.load();
    if (cur?.accounts[instance]) {
      const { [instance]: _gone, ...rest } = cur.accounts;
      if (Object.keys(rest).length) store.save({ accounts: rest });
      else store.remove();
    }
    this.env.touchRecheck();
    return this.status(instance);
  }
}
