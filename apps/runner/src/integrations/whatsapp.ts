import type { IntegrationScope, IntegrationStatus } from '@aom/shared';
import { checkWhatsapp } from '../outbound-delivery/whatsapp.ts';
import { whatsappStore } from '../outbound-delivery/send.ts';
import { type AdapterEnv, baseStatus, type IntegrationAdapter, type Outcome } from './types.ts';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * WhatsApp (Meta Cloud API) on this workstation, for an automation's output. The access token is saved in
 * `secrets/whatsapp.json`, encrypted with this runner's key, only after Meta accepted it. The instance is the phone number ID.
 */
export class WhatsappIntegration implements IntegrationAdapter {
  readonly kind = 'whatsapp' as const;
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
    return whatsappStore(this.env.paths.secrets, this.env.sealKey);
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
    const acct = this.store().load()?.accounts[instance];
    if (!acct)
      return baseStatus('whatsapp', instance, 'workstation', now, 'not_connected', {
        detail: 'No WhatsApp access token is saved for this phone number on this workstation.',
      });
    const r = await checkWhatsapp({ phoneNumberId: instance, accessToken: acct.accessToken }, this.fetchImpl);
    if (r.ok) return baseStatus('whatsapp', instance, 'workstation', now, 'connected', { method: 'token', account: r.account });
    return baseStatus('whatsapp', instance, 'workstation', now, r.refused ? 'refused' : 'unreachable', {
      method: 'token',
      detail: r.error.slice(0, 400),
    });
  }

  test(instance: string): Promise<IntegrationStatus> {
    return this.status(instance);
  }

  async connect(instance: string, method: string, fields: Record<string, string>): Promise<Outcome> {
    if (method !== 'token') return { error: 'This method cannot be connected from here.', code: 'unsupported' };
    const token = fields.token?.trim();
    if (!/^\d{5,30}$/.test(instance))
      return { error: 'Enter the Phone number ID (digits only) as the instance.', code: 'failed' };
    if (!token) return { error: 'Enter the access token.', code: 'failed' };
    const r = await checkWhatsapp({ phoneNumberId: instance, accessToken: token }, this.fetchImpl);
    if (!r.ok) return { error: `WhatsApp did not accept this token: ${r.error}. Nothing was saved.`, code: 'refused' };
    const store = this.store();
    const cur = store.load() ?? { accounts: {} };
    store.save({ accounts: { ...cur.accounts, [instance]: { ...(cur.accounts[instance] ?? {}), accessToken: token } } });
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
