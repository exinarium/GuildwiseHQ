import type { GitConnection, RepoRef } from '@aom/shared';
import { errText, ForgeHttpError, ForgeUnavailableError, hostOf, isHttps, jsonCall, tokenHelperEnv } from './http.ts';
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

interface GlProject {
  path_with_namespace: string;
  http_url_to_repo: string;
  ssh_url_to_repo?: string;
  default_branch?: string | null;
  visibility?: string;
}

/**
 * GitLab.com and self-managed GitLab over REST (`/api/v4`). The token is a personal access token the user saved with
 * `aom-runner git-connect gitlab`, or the one `glab auth login` stored (read with `glab config get token`). It stays on
 * this workstation: git sees it only through the environment of its own process.
 */
export class GitLabForge implements Forge {
  readonly kind = 'gitlab' as const;
  readonly caps = { listRepos: true, createRepo: true, openChange: true, branchRules: true };

  constructor(
    private readonly env: ForgeEnv,
    readonly host = 'gitlab.com',
  ) {}

  private async token(): Promise<{ token: string; user: string } | null> {
    const t = this.env.tokens.get('gitlab', this.host);
    if (t) return { token: t.token, user: t.user ?? 'oauth2' };
    const r = await this.env.exec.run(this.env.glabBin ?? 'glab', ['config', 'get', 'token', '--host', this.host], {
      timeoutMs: 15_000,
    });
    const tok = r.stdout.trim();
    return r.exitCode === 0 && tok ? { token: tok, user: 'oauth2' } : null;
  }

  private api<T>(path: string, tok: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    return jsonCall<T>(this.env.fetch, `https://${this.host}/api/v4${path}`, {
      ...init,
      headers: { 'PRIVATE-TOKEN': tok },
    });
  }

  private async authed<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const t = await this.token();
    if (!t) throw new ForgeUnavailableError(`not connected to ${this.host}: run \`aom-runner git-connect gitlab\``);
    return this.api<T>(path, t.token, init);
  }

  async status(): Promise<GitConnection> {
    const checkedAt = (this.env.now?.() ?? new Date()).toISOString();
    const base = { provider: 'gitlab' as const, host: this.host, checkedAt };
    const t = await this.token();
    if (!t)
      return {
        ...base,
        state: 'not_connected',
        detail: 'Run `aom-runner git-connect gitlab` (it runs `glab auth login` or saves a personal access token).',
      };
    try {
      const u = await this.api<{ username?: string }>('/user', t.token);
      return { ...base, state: 'connected', method: 'token', ...(u.username ? { account: u.username } : {}) };
    } catch (err) {
      return { ...base, state: 'not_connected', detail: `The saved token was refused (${errText(err)}).` };
    }
  }

  async gitAuth(url: string): Promise<GitAuth> {
    if (!isHttps(url)) return { args: [], env: {} };
    const t = await this.token();
    return t ? { args: [], env: tokenHelperEnv(hostOf(url) ?? this.host, t.user, t.token) } : { args: [], env: {} };
  }

  private toRef(p: GlProject): RepoRef {
    return {
      provider: 'gitlab',
      fullName: p.path_with_namespace,
      cloneUrl: p.http_url_to_repo,
      ...(p.ssh_url_to_repo ? { sshUrl: p.ssh_url_to_repo } : {}),
      ...(p.default_branch ? { defaultBranch: p.default_branch } : {}),
      ...(p.visibility ? { private: p.visibility !== 'public' } : {}),
    };
  }

  async listRepos(q: { search?: string }): Promise<RepoRef[]> {
    const qs = new URLSearchParams({
      membership: 'true',
      simple: 'true',
      per_page: '100',
      order_by: 'last_activity_at',
      ...(q.search?.trim() ? { search: q.search.trim() } : {}),
    });
    // `simple=true` omits visibility and default_branch on some versions: fine for a picker.
    return (await this.authed<GlProject[]>(`/projects?${qs}`)).map((p) => this.toRef(p));
  }

  async createRepo(r: CreateRepoInput): Promise<RepoRef> {
    const parts = r.fullName.split('/');
    const name = parts.pop() as string;
    const ns = parts.join('/');
    const nsInfo = await this.authed<{ id: number }>(`/namespaces/${encodeURIComponent(ns)}`);
    const p = await this.authed<GlProject>('/projects', {
      body: {
        name,
        path: name,
        namespace_id: nsInfo.id,
        visibility: r.private ? 'private' : 'public',
        ...(r.description ? { description: r.description } : {}),
      },
    });
    return this.toRef(p);
  }

  async defaultBranch(repo: RemoteRepo): Promise<string | null> {
    try {
      const p = await this.authed<GlProject>(`/projects/${encodeURIComponent(repo.fullName)}`);
      return p.default_branch ?? null;
    } catch {
      return null;
    }
  }

  async openChange(repo: RemoteRepo, c: OpenChangeInput) {
    const mr = await this.authed<{ iid: number; web_url: string }>(
      `/projects/${encodeURIComponent(repo.fullName)}/merge_requests`,
      { body: { source_branch: c.head, target_branch: c.base, title: c.title, description: c.body } },
    );
    return { id: String(mr.iid), url: mr.web_url };
  }

  async changeState(repo: RemoteRepo, id: string): Promise<ChangeState> {
    const mr = await this.authed<{ state: string }>(
      `/projects/${encodeURIComponent(repo.fullName)}/merge_requests/${encodeURIComponent(id)}`,
    );
    return mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open';
  }

  async branchRules(repo: RemoteRepo, branch: string): Promise<BranchRules | null> {
    try {
      const pb = await this.authed<{ push_access_levels?: Array<{ access_level: number }> }>(
        `/projects/${encodeURIComponent(repo.fullName)}/protected_branches/${encodeURIComponent(branch)}`,
      );
      // access level 0 = "No one": changes go through merge requests
      const allowed = (pb.push_access_levels ?? []).some((l) => l.access_level > 0);
      return { directPushAllowed: allowed, requiresChange: !allowed };
    } catch (err) {
      if (err instanceof ForgeHttpError && err.status === 404) return { directPushAllowed: true, requiresChange: false };
      return null;
    }
  }
}
