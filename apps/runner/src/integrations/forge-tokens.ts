import { defaultHost, type IntegrationScope, type IntegrationStatus } from '@aom/shared';
import { AzureDevOpsForge } from '../forge/azure.ts';
import { BitbucketCloudForge } from '../forge/bitbucket.ts';
import { saveAndVerify } from '../forge/connect.ts';
import { GitLabForge } from '../forge/gitlab.ts';
import { registerSecret, unregisterSecret } from '../secrets/redact.ts';
import {
  type AdapterEnv,
  errText,
  fromGitConnection,
  type IntegrationAdapter,
  type Outcome,
} from './types.ts';

/** The adapters that keep a token in `secrets/git-tokens.json`: GitLab, Bitbucket Cloud and Azure DevOps. */

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,198}$/;
const ORG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,98}$/;

async function saveToken(
  env: AdapterEnv,
  t: {
    provider: 'gitlab' | 'bitbucket-cloud' | 'azure-devops';
    host: string;
    token: string;
    user?: string;
    organization?: string;
  },
): Promise<{ ok: true } | { ok: false; detail: string | undefined }> {
  registerSecret(t.token);
  try {
    const st = await saveAndVerify(env.forge, t);
    env.touchRecheck();
    return st.state === 'connected' ? { ok: true } : { ok: false, detail: st.detail };
  } finally {
    unregisterSecret(t.token);
  }
}

// -------------------------------------------------------------------------------------------- GitLab

interface GlTokenSelf {
  scopes?: string[];
  expires_at?: string | null;
}

export class GitLabIntegration implements IntegrationAdapter {
  readonly kind = 'gitlab' as const;
  private readonly extra = new Map<string, { scopes?: string[]; expiresAt?: string; at: number }>();

  constructor(private readonly env: AdapterEnv) {}

  scopeOf(method?: string): IntegrationScope {
    return method === 'cli_web' ? 'machine' : 'workstation';
  }

  async instances(): Promise<string[]> {
    const hosts = new Set<string>([defaultHost('gitlab'), ...(this.env.repoHosts().gitlab ?? [])]);
    for (const t of this.env.forge.tokens.list()) if (t.provider === 'gitlab') hosts.add(t.host);
    return [...hosts];
  }

  async status(host: string): Promise<IntegrationStatus> {
    const c = await new GitLabForge(this.env.forge, host).status();
    const s = fromGitConnection('gitlab', host, 'workstation', c);
    if (s.state !== 'connected') return s;
    const e = await this.enrich(host);
    return {
      ...s,
      ...(e.scopes ? { scopes: e.scopes } : {}),
      ...(e.expiresAt ? { expiresAt: e.expiresAt } : {}),
    };
  }

  /** Scopes and expiry from `personal_access_tokens/self` (cached for a few minutes; a token without it is fine). */
  private async enrich(host: string): Promise<{ scopes?: string[]; expiresAt?: string }> {
    const hit = this.extra.get(host);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit;
    const token = this.env.forge.tokens.get('gitlab', host)?.token;
    let out: { scopes?: string[]; expiresAt?: string } = {};
    if (token) {
      try {
        const res = await this.env.fetch(`https://${host}/api/v4/personal_access_tokens/self`, {
          headers: { 'PRIVATE-TOKEN': token, accept: 'application/json' },
        });
        if (res.ok) {
          const j = (await res.json()) as GlTokenSelf;
          out = {
            ...(Array.isArray(j.scopes) ? { scopes: j.scopes.map(String).slice(0, 50) } : {}),
            ...(j.expires_at ? { expiresAt: new Date(`${j.expires_at}T23:59:59Z`).toISOString() } : {}),
          };
        }
      } catch {
        // no extra facts
      }
    }
    this.extra.set(host, { ...out, at: Date.now() });
    return out;
  }

  async test(host: string): Promise<IntegrationStatus> {
    this.extra.delete(host);
    return this.status(host);
  }

  async connect(host: string, method: string, fields: Record<string, string>): Promise<Outcome> {
    if (method !== 'token')
      return { error: 'This method cannot be connected from here.', code: 'unsupported' };
    if (!HOST_RE.test(host)) return { error: 'That is not a host name.', code: 'failed' };
    const token = fields.token?.trim();
    if (!token) return { error: 'Nothing was entered.', code: 'failed' };
    const r = await saveToken(this.env, { provider: 'gitlab', host, token });
    if (!r.ok)
      return { error: `GitLab did not accept this token${r.detail ? `: ${r.detail}` : ''}`, code: 'refused' };
    this.extra.delete(host);
    return this.status(host);
  }

  async remove(host: string): Promise<Outcome> {
    this.env.forge.tokens.remove('gitlab', host);
    this.extra.delete(host);
    this.env.touchRecheck();
    return this.status(host);
  }
}

// -------------------------------------------------------------------------------------------- Bitbucket Cloud

export class BitbucketIntegration implements IntegrationAdapter {
  readonly kind = 'bitbucket-cloud' as const;

  constructor(private readonly env: AdapterEnv) {}

  scopeOf(): IntegrationScope {
    return 'workstation';
  }

  async instances(): Promise<string[]> {
    return [''];
  }

  async status(): Promise<IntegrationStatus> {
    const c = await new BitbucketCloudForge(this.env.forge).status();
    const s = fromGitConnection('bitbucket-cloud', '', 'workstation', c);
    const saved = this.env.forge.tokens.list().find((t) => t.provider === 'bitbucket-cloud');
    return { ...s, ...(saved?.savedAt ? { savedAt: saved.savedAt } : {}) };
  }

  test(): Promise<IntegrationStatus> {
    return this.status();
  }

  async connect(_instance: string, method: string, fields: Record<string, string>): Promise<Outcome> {
    if (method !== 'token')
      return { error: 'This method cannot be connected from here.', code: 'unsupported' };
    const token = fields.token?.trim();
    const email = fields.email?.trim();
    if (!token || !email)
      return { error: 'Enter your Atlassian e-mail address and the token.', code: 'failed' };
    const r = await saveToken(this.env, {
      provider: 'bitbucket-cloud',
      host: defaultHost('bitbucket-cloud'),
      token,
      user: email,
    });
    if (!r.ok)
      return { error: `Bitbucket refused the token${r.detail ? `: ${r.detail}` : ''}`, code: 'refused' };
    return this.status();
  }

  async remove(): Promise<Outcome> {
    this.env.forge.tokens.remove('bitbucket-cloud', defaultHost('bitbucket-cloud'));
    this.env.touchRecheck();
    return this.status();
  }
}

// -------------------------------------------------------------------------------------------- Azure DevOps

export class AzureDevOpsIntegration implements IntegrationAdapter {
  readonly kind = 'azure-devops' as const;

  constructor(private readonly env: AdapterEnv) {}

  scopeOf(method?: string): IntegrationScope {
    return method === 'device' ? 'machine' : 'workstation';
  }

  /** An instance is an organization with a saved token; `''` stands for a service principal or the Azure CLI login. */
  async instances(): Promise<string[]> {
    const orgs = new Set<string>();
    for (const t of this.env.forge.tokens.list())
      if (t.provider === 'azure-devops' && t.organization) orgs.add(t.organization);
    return [...orgs];
  }

  async status(org: string): Promise<IntegrationStatus> {
    const host = defaultHost('azure-devops');
    try {
      const c = await new AzureDevOpsForge(
        { ...this.env.forge, processEnv: process.env },
        host,
        org || undefined,
      ).status();
      const s = fromGitConnection('azure-devops', org, 'workstation', c);
      const saved = this.env.forge.tokens
        .list()
        .find((t) => t.provider === 'azure-devops' && t.organization?.toLowerCase() === org.toLowerCase());
      return { ...s, site: org || s.site || host, ...(saved?.savedAt ? { savedAt: saved.savedAt } : {}) };
    } catch (err) {
      return {
        kind: 'azure-devops',
        instance: org,
        scope: 'workstation',
        state: 'unreachable',
        checkedAt: this.env.now().toISOString(),
        detail: errText(err),
      };
    }
  }

  test(org: string): Promise<IntegrationStatus> {
    return this.status(org);
  }

  async connect(org: string, method: string, fields: Record<string, string>): Promise<Outcome> {
    if (method !== 'token')
      return { error: 'This method cannot be connected from here.', code: 'unsupported' };
    if (!ORG_RE.test(org)) return { error: 'Enter the Azure DevOps organization name.', code: 'failed' };
    const token = fields.token?.trim();
    if (!token) return { error: 'Nothing was entered.', code: 'failed' };
    const r = await saveToken(this.env, {
      provider: 'azure-devops',
      host: defaultHost('azure-devops'),
      token,
      organization: org,
    });
    if (!r.ok)
      return { error: `Azure DevOps refused the token${r.detail ? `: ${r.detail}` : ''}`, code: 'refused' };
    return this.status(org);
  }

  async remove(org: string): Promise<Outcome> {
    this.env.forge.tokens.remove('azure-devops', defaultHost('azure-devops'), org);
    this.env.touchRecheck();
    return this.status(org);
  }
}
