import type { IntegrationScope, IntegrationStatus } from '@aom/shared';
import { JiraAdapter } from '../external/jira.ts';
import { JiraCredentialStore, jiraFile, normalizeJiraBaseUrl, resolveJira } from '../external/jira-store.ts';
import { registerSecret, unregisterSecret } from '../secrets/redact.ts';
import { type AdapterEnv, baseStatus, type IntegrationAdapter, type Outcome } from './types.ts';

/** Jira on this workstation (`secrets/jira.json`). `aom-runner jira-connect` and the Integrations page share `connect()`. */
export class JiraIntegration implements IntegrationAdapter {
  readonly kind = 'jira' as const;
  private readonly fetchImpl: ((url: string, init: RequestInit) => Promise<Response>) | undefined;

  constructor(
    private readonly env: AdapterEnv,
    opts: { fetch?: (url: string, init: RequestInit) => Promise<Response> } = {},
  ) {
    this.fetchImpl = opts.fetch;
  }

  scopeOf(): IntegrationScope {
    return 'workstation';
  }

  private store(): JiraCredentialStore {
    return new JiraCredentialStore(jiraFile(this.env.paths.secrets));
  }

  async instances(): Promise<string[]> {
    return [''];
  }

  async status(): Promise<IntegrationStatus> {
    const now = this.env.now();
    const cfg = resolveJira(this.env.paths.secrets, this.env.config().jira);
    if (!cfg)
      return baseStatus('jira', '', 'workstation', now, 'not_connected', {
        detail: 'No Jira credentials are saved on this workstation.',
      });
    const st = await new JiraAdapter({
      config: cfg,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    }).checkStatus();
    const method = cfg.email ? 'token' : 'pat';
    if (st.state === 'connected')
      return baseStatus('jira', '', 'workstation', now, 'connected', {
        method,
        ...(st.account ? { account: st.account } : {}),
        ...(st.baseUrl ? { site: st.baseUrl } : {}),
      });
    return baseStatus('jira', '', 'workstation', now, st.state === 'refused' ? 'refused' : 'not_connected', {
      method,
      ...(st.baseUrl ? { site: st.baseUrl } : {}),
      ...(st.detail ? { detail: st.detail.slice(0, 400) } : {}),
    });
  }

  test(): Promise<IntegrationStatus> {
    return this.status();
  }

  async connect(_instance: string, method: string, fields: Record<string, string>): Promise<Outcome> {
    if (method !== 'token')
      return { error: 'This method cannot be connected from here.', code: 'unsupported' };
    const baseUrl = normalizeJiraBaseUrl(fields.baseUrl ?? '');
    if (!baseUrl)
      return { error: 'Enter a Jira base URL such as https://yourcompany.atlassian.net.', code: 'failed' };
    const token = fields.token?.trim();
    if (!token) return { error: 'Enter the API token.', code: 'failed' };
    const email = fields.email?.trim();
    registerSecret(token);
    try {
      const cfg = { baseUrl, ...(email ? { email } : {}), apiToken: token };
      const st = await new JiraAdapter({
        config: cfg,
        ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      }).checkStatus();
      if (st.state !== 'connected')
        return {
          error: `Jira did not accept these credentials: ${st.detail ?? st.state}. Nothing was saved.`,
          code: 'refused',
        };
      this.store().save(cfg);
      this.env.touchRecheck();
      return await this.status();
    } finally {
      unregisterSecret(token);
    }
  }

  async remove(): Promise<Outcome> {
    this.store().remove();
    this.env.touchRecheck();
    const s = await this.status();
    if (s.state !== 'not_connected')
      return {
        error:
          'The saved credentials were removed, but a "jira" block in config.json still applies. Remove it there too.',
        code: 'unsupported',
        status: s,
      };
    return s;
  }
}
