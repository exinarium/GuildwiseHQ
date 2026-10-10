import type { GitConnection, RepoRef } from '@aom/shared';
import { errText, ForgeUnavailableError, isHttps, jsonCall, tokenHelperEnv } from './http.ts';
import type {
  BranchRules,
  ChangeState,
  CreateRepoInput,
  Forge,
  ForgeEnv,
  GitAuth,
  OpenChangeInput,
  RemoteRepo,
} from './types.ts';

const API = 'https://api.bitbucket.org/2.0';
/** The git username Bitbucket Cloud expects with an API token as the password. */
const GIT_USER = 'x-bitbucket-api-token-auth';

interface BbRepo {
  full_name: string;
  is_private?: boolean;
  mainbranch?: { name?: string } | null;
  links?: { clone?: Array<{ name: string; href: string }> };
}

/**
 * Bitbucket Cloud over REST with an Atlassian API token (app passwords were switched off on 2026-06-09). REST calls use
 * basic auth `<atlassian e-mail>:<api token>`; git over https uses the username `x-bitbucket-api-token-auth` with the
 * token. SSH keys work too. The token stays in this workstation's secrets file.
 */
export class BitbucketCloudForge implements Forge {
  readonly kind = 'bitbucket-cloud' as const;
  readonly host = 'bitbucket.org';
  readonly caps = { listRepos: true, createRepo: true, openChange: true, branchRules: true };

  constructor(private readonly env: ForgeEnv) {}

  private cred() {
    return this.env.tokens.get('bitbucket-cloud', this.host);
  }

  private async call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const t = this.cred();
    if (!t?.user) throw new ForgeUnavailableError('not connected to Bitbucket: run `aom-runner git-connect bitbucket-cloud`');
    return jsonCall<T>(this.env.fetch, `${API}${path}`, {
      ...init,
      headers: { authorization: `Basic ${Buffer.from(`${t.user}:${t.token}`).toString('base64')}` },
    });
  }

  async status(): Promise<GitConnection> {
    const checkedAt = (this.env.now?.() ?? new Date()).toISOString();
    const base = { provider: 'bitbucket-cloud' as const, host: this.host, checkedAt };
    if (!this.cred())
      return {
        ...base,
        state: 'not_connected',
        detail:
          'Run `aom-runner git-connect bitbucket-cloud` and paste an Atlassian API token (scopes: repository read/write, pull request read/write).',
      };
    try {
      const u = await this.call<{ display_name?: string; nickname?: string }>('/user');
      return { ...base, state: 'connected', method: 'token', ...(u.nickname || u.display_name ? { account: u.nickname ?? u.display_name } : {}) };
    } catch (err) {
      return { ...base, state: 'not_connected', detail: `Bitbucket refused the saved token (${errText(err)}).` };
    }
  }

  async gitAuth(url: string): Promise<GitAuth> {
    const t = this.cred();
    if (!t || !isHttps(url)) return { args: [], env: {} };
    return { args: [], env: tokenHelperEnv(this.host, GIT_USER, t.token) };
  }

  private toRef(r: BbRepo): RepoRef {
    const clone = r.links?.clone ?? [];
    const https = clone.find((c) => c.name === 'https')?.href.replace(/^(https:\/\/)[^@/]+@/, '$1');
    const ssh = clone.find((c) => c.name === 'ssh')?.href;
    return {
      provider: 'bitbucket-cloud',
      fullName: r.full_name,
      cloneUrl: https ?? `https://bitbucket.org/${r.full_name}.git`,
      ...(ssh ? { sshUrl: ssh } : {}),
      ...(r.mainbranch?.name ? { defaultBranch: r.mainbranch.name } : {}),
      ...(r.is_private === undefined ? {} : { private: r.is_private }),
    };
  }

  async listRepos(q: { search?: string }): Promise<RepoRef[]> {
    const qs = new URLSearchParams({ role: 'member', pagelen: '100', sort: '-updated_on' });
    const s = q.search?.trim().replace(/["\\]/g, '');
    if (s) qs.set('q', `name ~ "${s}"`);
    const res = await this.call<{ values: BbRepo[] }>(`/repositories?${qs}`);
    return res.values.map((r) => this.toRef(r));
  }

  async createRepo(r: CreateRepoInput): Promise<RepoRef> {
    const [ws, slug] = r.fullName.split('/') as [string, string];
    const made = await this.call<BbRepo>(`/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(slug.toLowerCase())}`, {
      method: 'POST',
      body: { scm: 'git', is_private: r.private, ...(r.description ? { description: r.description } : {}) },
    });
    return this.toRef(made);
  }

  async defaultBranch(repo: RemoteRepo): Promise<string | null> {
    try {
      return (await this.call<BbRepo>(`/repositories/${repo.fullName}`)).mainbranch?.name ?? null;
    } catch {
      return null;
    }
  }

  async openChange(repo: RemoteRepo, c: OpenChangeInput) {
    const pr = await this.call<{ id: number; links?: { html?: { href?: string } } }>(
      `/repositories/${repo.fullName}/pullrequests`,
      {
        body: {
          title: c.title,
          description: c.body,
          source: { branch: { name: c.head } },
          destination: { branch: { name: c.base } },
        },
      },
    );
    return { id: String(pr.id), url: pr.links?.html?.href ?? `https://bitbucket.org/${repo.fullName}/pull-requests/${pr.id}` };
  }

  async changeState(repo: RemoteRepo, id: string): Promise<ChangeState> {
    const pr = await this.call<{ state: string }>(`/repositories/${repo.fullName}/pullrequests/${encodeURIComponent(id)}`);
    return pr.state === 'MERGED' ? 'merged' : pr.state === 'OPEN' ? 'open' : 'closed';
  }

  async branchRules(repo: RemoteRepo, branch: string): Promise<BranchRules | null> {
    try {
      const res = await this.call<{ values: Array<{ kind: string; pattern?: string; branch_match_kind?: string }> }>(
        `/repositories/${repo.fullName}/branch-restrictions?pagelen=100`,
      );
      const hit = res.values.some(
        (v) =>
          ['push', 'restrict_merges', 'require_approvals_to_merge', 'require_passing_builds_to_merge'].includes(v.kind) &&
          (v.branch_match_kind === 'glob' ? globMatch(v.pattern ?? '', branch) : v.pattern === branch),
      );
      return { directPushAllowed: !hit, requiresChange: hit };
    } catch {
      return null;
    }
  }
}

function globMatch(pattern: string, s: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(s);
}
