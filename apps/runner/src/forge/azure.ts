import type { GitConnection, RepoRef } from '@aom/shared';
import { errText, ForgeHttpError, ForgeUnavailableError, isHttps, jsonCall, tokenHelperEnv } from './http.ts';
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

const API = 'api-version=7.1';
/** Azure DevOps resource id for Entra access tokens (`az account get-access-token --resource`). */
const AZDO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
/** Policy types that stop direct pushes into a branch: minimum reviewers, build validation, required reviewers. */
const BLOCKING_POLICIES = new Set([
  'fa4e907d-c16b-4a4c-9dfa-4906e5d171dd',
  '0609b952-1397-4640-95ec-e00a01b2c241',
  'fd2167ab-b0be-447a-8ec8-39368250530e',
]);

interface AzRepo {
  name: string;
  id?: string;
  remoteUrl: string;
  sshUrl?: string;
  defaultBranch?: string;
  project?: { name: string };
  isDisabled?: boolean;
}

/**
 * Azure DevOps Repos over REST. Authentication on this workstation: a personal access token saved by
 * `aom-runner git-connect azure-devops` (organization-scoped; global PATs stop working on 2026-12-01) or, without one,
 * the signed-in Azure CLI (`az login`, Entra ID). Git uses the same credential through the environment of its own
 * process (PAT) or an Authorization header (Entra); Git Credential Manager keeps working for plain git use.
 */
export class AzureDevOpsForge implements Forge {
  readonly kind = 'azure-devops' as const;
  readonly caps = { listRepos: true, createRepo: true, openChange: true, branchRules: true };

  constructor(
    private readonly env: ForgeEnv,
    readonly host = 'dev.azure.com',
    /** The organization the picker and `status` talk to (from the saved token or the repository). */
    private readonly organization?: string,
  ) {}

  private async auth(): Promise<{ header: string; pat?: string; organization?: string } | null> {
    const t = this.env.tokens.get('azure-devops', this.host);
    if (t)
      return {
        header: `Basic ${Buffer.from(`:${t.token}`).toString('base64')}`,
        pat: t.token,
        ...(t.organization ? { organization: t.organization } : {}),
      };
    const r = await this.env.exec.run(
      this.env.azBin ?? 'az',
      ['account', 'get-access-token', '--resource', AZDO_RESOURCE, '--query', 'accessToken', '-o', 'tsv'],
      { timeoutMs: 30_000 },
    );
    const tok = r.stdout.trim();
    return r.exitCode === 0 && tok ? { header: `Bearer ${tok}` } : null;
  }

  private org(a: { organization?: string } | null): string | undefined {
    return this.organization ?? a?.organization;
  }

  private async call<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const a = await this.auth();
    if (!a)
      throw new ForgeUnavailableError(
        'not connected to Azure DevOps: run `aom-runner git-connect azure-devops`',
      );
    return jsonCall<T>(this.env.fetch, url, { ...init, headers: { authorization: a.header } });
  }

  async status(): Promise<GitConnection> {
    const checkedAt = (this.env.now?.() ?? new Date()).toISOString();
    const base = { provider: 'azure-devops' as const, host: this.host, checkedAt };
    const a = await this.auth();
    if (!a)
      return {
        ...base,
        state: 'not_connected',
        detail:
          'Run `aom-runner git-connect azure-devops --organization <name>` and paste a personal access token (Code: read and write), or sign in with `az login`.',
      };
    const org = this.org(a);
    if (!org)
      return {
        ...base,
        state: 'connected',
        method: a.pat ? 'token' : 'cli',
        detail: 'Signed in; no organization chosen yet.',
      };
    try {
      await jsonCall(
        this.env.fetch,
        `https://${this.host}/${encodeURIComponent(org)}/_apis/projects?$top=1&${API}`,
        {
          headers: { authorization: a.header },
        },
      );
      return { ...base, state: 'connected', method: a.pat ? 'token' : 'cli', account: org };
    } catch (err) {
      return {
        ...base,
        state: 'not_connected',
        detail: `Azure DevOps refused the credential for ${org} (${errText(err)}).`,
      };
    }
  }

  async gitAuth(url: string): Promise<GitAuth> {
    if (!isHttps(url)) return { args: [], env: {} };
    const a = await this.auth();
    if (!a) return { args: [], env: {} };
    if (a.pat) return { args: [], env: tokenHelperEnv(new URL(url).host, 'pat', a.pat) };
    // Entra token: an Authorization header for this host, held in the git process environment only.
    return {
      args: [],
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `http.https://${new URL(url).host}/.extraheader`,
        GIT_CONFIG_VALUE_0: `Authorization: ${a.header}`,
      },
    };
  }

  private toRef(org: string, r: AzRepo): RepoRef {
    const project = r.project?.name ?? '';
    return {
      provider: 'azure-devops',
      fullName: `${org}/${project}/${r.name}`,
      cloneUrl: r.remoteUrl.replace(/^(https:\/\/)[^@/]+@/, '$1'),
      ...(r.sshUrl ? { sshUrl: r.sshUrl } : {}),
      ...(r.defaultBranch ? { defaultBranch: r.defaultBranch.replace(/^refs\/heads\//, '') } : {}),
      private: true,
    };
  }

  async listRepos(q: { search?: string }): Promise<RepoRef[]> {
    const a = await this.auth();
    const org = this.org(a);
    if (!org)
      throw new Error(
        'choose an Azure DevOps organization: `aom-runner git-connect azure-devops --organization <name>`',
      );
    const res = await this.call<{ value: AzRepo[] }>(
      `https://${this.host}/${encodeURIComponent(org)}/_apis/git/repositories?${API}`,
    );
    const s = q.search?.trim().toLowerCase();
    return res.value
      .filter((r) => !r.isDisabled)
      .map((r) => this.toRef(org, r))
      .filter((r) => !s || r.fullName.toLowerCase().includes(s))
      .slice(0, 100);
  }

  async createRepo(r: CreateRepoInput): Promise<RepoRef> {
    const [org, project, name] = r.fullName.split('/') as [string, string, string];
    const made = await this.call<AzRepo>(
      `https://${this.host}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories?${API}`,
      { body: { name } },
    );
    return this.toRef(org, { ...made, project: made.project ?? { name: project } });
  }

  private base(repo: RemoteRepo): {
    root: string;
    repoPath: string;
    org: string;
    project: string;
    name: string;
  } {
    const [org, project, name] = repo.fullName.split('/') as [string, string, string];
    const root = `https://${repo.host}/${encodeURIComponent(org)}/${encodeURIComponent(project)}`;
    return {
      root,
      repoPath: `${root}/_apis/git/repositories/${encodeURIComponent(name)}`,
      org,
      project,
      name,
    };
  }

  async defaultBranch(repo: RemoteRepo): Promise<string | null> {
    try {
      const r = await this.call<AzRepo>(`${this.base(repo).repoPath}?${API}`);
      return r.defaultBranch?.replace(/^refs\/heads\//, '') ?? null;
    } catch {
      return null;
    }
  }

  async openChange(repo: RemoteRepo, c: OpenChangeInput) {
    const b = this.base(repo);
    const pr = await this.call<{ pullRequestId: number }>(`${b.repoPath}/pullrequests?${API}`, {
      body: {
        sourceRefName: `refs/heads/${c.head}`,
        targetRefName: `refs/heads/${c.base}`,
        title: c.title,
        description: c.body,
      },
    });
    return {
      id: String(pr.pullRequestId),
      url: `${b.root}/_git/${encodeURIComponent(b.name)}/pullrequest/${pr.pullRequestId}`,
    };
  }

  async changeState(repo: RemoteRepo, id: string): Promise<ChangeState> {
    const pr = await this.call<{ status: string }>(
      `${this.base(repo).repoPath}/pullrequests/${encodeURIComponent(id)}?${API}`,
    );
    return pr.status === 'completed' ? 'merged' : pr.status === 'abandoned' ? 'closed' : 'open';
  }

  async branchRules(repo: RemoteRepo, branch: string): Promise<BranchRules | null> {
    try {
      const b = this.base(repo);
      const r = await this.call<{ id: string }>(`${b.repoPath}?${API}`);
      const pol = await this.call<{
        value: Array<{ isEnabled: boolean; isBlocking?: boolean; type: { id: string } }>;
      }>(
        `${b.root}/_apis/policy/configurations?repositoryId=${encodeURIComponent(r.id)}&refName=${encodeURIComponent(`refs/heads/${branch}`)}&${API}`,
      );
      const requires = pol.value.some(
        (p) => p.isEnabled && p.isBlocking !== false && BLOCKING_POLICIES.has(p.type.id),
      );
      return { directPushAllowed: !requires, requiresChange: requires };
    } catch (err) {
      return err instanceof ForgeHttpError && err.status === 404
        ? { directPushAllowed: true, requiresChange: false }
        : null;
    }
  }
}
