import { readFileSync } from 'node:fs';
import { type GitConnection, parseRemote, type RepoRef } from '@aom/shared';
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

const methodOf = (a: { pat?: string; servicePrincipal?: boolean }): 'token' | 'service-principal' | 'cli' =>
  a.pat ? 'token' : a.servicePrincipal ? 'service-principal' : 'cli';

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
 * Azure DevOps Repos over REST. Authentication on this workstation, first match wins:
 *
 * 1. a personal access token saved by `aom-runner git-connect azure-devops` (organization-scoped; global PATs stop
 *    working on 2026-12-01);
 * 2. a Microsoft Entra service principal in the environment (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and either
 *    `AZURE_CLIENT_SECRET` or, for workload identity, `AZURE_FEDERATED_TOKEN_FILE`): the main path, the runner asks
 *    Entra for a token itself;
 * 3. the signed-in Azure CLI (`az login`, which also covers `az login --service-principal`).
 *
 * Git uses the same credential through the environment of its own process (PAT) or an Authorization header (Entra);
 * Git Credential Manager keeps working for plain git use.
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

  private sp: { header: string; until: number } | undefined;

  /** The service principal named by the environment, if complete. The secret is never logged or returned. */
  private servicePrincipal(): {
    tenant: string;
    client: string;
    secret?: string;
    assertionFile?: string;
  } | null {
    const e = this.env.processEnv ?? process.env;
    const tenant = e.AZURE_TENANT_ID?.trim();
    const client = e.AZURE_CLIENT_ID?.trim();
    if (!tenant || !client) return null;
    const secret = e.AZURE_CLIENT_SECRET?.trim();
    const assertionFile = e.AZURE_FEDERATED_TOKEN_FILE?.trim();
    if (!secret && !assertionFile) return null;
    return { tenant, client, ...(secret ? { secret } : {}), ...(assertionFile ? { assertionFile } : {}) };
  }

  /** An Entra access token for Azure DevOps from the service principal (client secret or workload identity). */
  private async spToken(): Promise<string | null> {
    const sp = this.servicePrincipal();
    if (!sp) return null;
    const now = (this.env.now?.() ?? new Date()).getTime();
    if (this.sp && this.sp.until > now) return this.sp.header;
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: sp.client,
      scope: `${AZDO_RESOURCE}/.default`,
    });
    if (sp.secret) form.set('client_secret', sp.secret);
    else if (sp.assertionFile) {
      form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      form.set('client_assertion', readFileSync(sp.assertionFile, 'utf8').trim());
    }
    try {
      const res = await this.env.fetch(
        `https://login.microsoftonline.com/${encodeURIComponent(sp.tenant)}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: form.toString(),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!res.ok) return null;
      const j = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!j.access_token) return null;
      const header = `Bearer ${j.access_token}`;
      this.sp = { header, until: now + Math.max(60, (j.expires_in ?? 600) - 120) * 1000 };
      return header;
    } catch {
      return null;
    }
  }

  private async auth(organization?: string): Promise<{
    header: string;
    pat?: string;
    organization?: string;
    servicePrincipal?: boolean;
  } | null> {
    const e = this.env.processEnv ?? process.env;
    const want = organization ?? this.organization ?? (e.AZURE_DEVOPS_ORGANIZATION?.trim() || undefined);
    const t = this.env.tokens.get('azure-devops', this.host, want);
    if (t)
      return {
        header: `Basic ${Buffer.from(`:${t.token}`).toString('base64')}`,
        pat: t.token,
        ...(t.organization ? { organization: t.organization } : {}),
      };
    const spHeader = await this.spToken();
    if (spHeader) return { header: spHeader, servicePrincipal: true };
    const r = await this.env.exec.run(
      this.env.azBin ?? 'az',
      ['account', 'get-access-token', '--resource', AZDO_RESOURCE, '--query', 'accessToken', '-o', 'tsv'],
      { timeoutMs: 30_000 },
    );
    const tok = r.stdout.trim();
    return r.exitCode === 0 && tok ? { header: `Bearer ${tok}` } : null;
  }

  private org(a: { organization?: string } | null): string | undefined {
    const e = this.env.processEnv ?? process.env;
    return this.organization ?? a?.organization ?? (e.AZURE_DEVOPS_ORGANIZATION?.trim() || undefined);
  }

  private async call<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
    // The organization is the first path segment of every API url: its own PAT is used.
    let urlOrg: string | undefined;
    try {
      urlOrg = decodeURIComponent(new URL(url).pathname.split('/')[1] ?? '') || undefined;
    } catch {
      urlOrg = undefined;
    }
    const a = await this.auth(urlOrg);
    if (!a)
      throw new ForgeUnavailableError(
        'not connected to Azure DevOps: run `guildwise-runner git-connect azure-devops`',
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
          'Use a Microsoft Entra service principal (set the AZURE_TENANT_ID, AZURE_CLIENT_ID and client credential variables, or `az login --service-principal`), or run `guildwise-runner git-connect azure-devops --organization <name>` and paste a personal access token (Code: read and write).',
      };
    const org = this.org(a);
    if (!org)
      return {
        ...base,
        state: 'connected',
        method: methodOf(a),
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
      return { ...base, state: 'connected', method: methodOf(a), account: org };
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
    const a = await this.auth(parseRemote(url)?.namespace[0]);
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
        'choose an Azure DevOps organization: `guildwise-runner git-connect azure-devops --organization <name>`',
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
    // A reopened card's branch may already have an active pull request: reuse it.
    try {
      const qs = new URLSearchParams({
        'searchCriteria.status': 'active',
        'searchCriteria.sourceRefName': `refs/heads/${c.head}`,
        'searchCriteria.targetRefName': `refs/heads/${c.base}`,
        $top: '1',
      });
      const open = await this.call<{ value?: Array<{ pullRequestId: number }> }>(
        `${b.repoPath}/pullrequests?${API}&${qs}`,
      );
      const hit = open.value?.[0];
      if (hit)
        return {
          id: String(hit.pullRequestId),
          url: `${b.root}/_git/${encodeURIComponent(b.name)}/pullrequest/${hit.pullRequestId}`,
        };
    } catch (err) {
      if (err instanceof ForgeUnavailableError) throw err;
    }
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
