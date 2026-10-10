import {
  CONNECTABLE_FORGES,
  type ConnectableForge,
  defaultHost,
  type ForgeKind,
  type GitConnection,
  parseRemote,
} from '@aom/shared';
import type { PrCreator } from '../git/gh.ts';
import { git } from '../git/git.ts';
import { AzureDevOpsForge } from './azure.ts';
import { BitbucketCloudForge } from './bitbucket.ts';
import { GitHubForge } from './github.ts';
import { GitLabForge } from './gitlab.ts';
import { ForgeUnavailableError } from './http.ts';
import { PlainGitForge } from './plain.ts';
import type { BranchRules, Forge, ForgeEnv, RemoteRepo } from './types.ts';

export { defaultHost } from '@aom/shared';
export { AzureDevOpsForge } from './azure.ts';
export { BitbucketCloudForge } from './bitbucket.ts';
export { GitHubForge } from './github.ts';
export { GitLabForge } from './gitlab.ts';
export { ForgeHttpError, ForgeUnavailableError } from './http.ts';
export { PlainGitForge } from './plain.ts';
export { FileTokenStore, MemoryTokenStore, type StoredToken, type TokenStore } from './tokens.ts';
export type { BranchRules, Forge, ForgeEnv, GitAuth, RemoteRepo } from './types.ts';

/** The forge for a provider kind and host (the host matters for GitHub Enterprise and self-managed GitLab). */
export function forgeOfKind(env: ForgeEnv, kind: ForgeKind, host?: string, organization?: string): Forge {
  switch (kind) {
    case 'github':
      return new GitHubForge(env, host);
    case 'gitlab':
      return new GitLabForge(env, host);
    case 'azure-devops':
      return new AzureDevOpsForge(env, host, organization);
    case 'bitbucket-cloud':
      return new BitbucketCloudForge(env);
    case 'bitbucket-dc':
      return new PlainGitForge(env, host ?? '', 'bitbucket-dc');
    default:
      return new PlainGitForge(env, host ?? '');
  }
}

/** The adapter and the repository for a remote url; `override` is the provider chosen on the repository. */
export function forgeForUrl(
  env: ForgeEnv,
  url: string,
  override?: ForgeKind | null,
): { forge: Forge; repo: RemoteRepo } | null {
  const p = parseRemote(url, override);
  if (!p) return null;
  const org = p.kind === 'azure-devops' ? p.namespace[0] : undefined;
  const forge = forgeOfKind(env, p.kind, p.host, org);
  const fullName = p.kind === 'azure-devops' ? [...p.namespace, p.name].join('/') : [...p.namespace, p.name].join('/');
  return { forge, repo: { kind: p.kind, host: p.host, fullName, url } };
}

/** `git remote get-url origin` of a clone. */
export async function originUrl(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['remote', 'get-url', 'origin']);
  return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * The completion `PrCreator` backed by the forge of the clone's origin. A forge without pull requests (plain git),
 * a missing CLI or a missing login reports `unavailable`, so the branch is pushed and the manager opens the PR by hand.
 */
export function forgePrCreator(env: ForgeEnv): PrCreator {
  return {
    async create(input) {
      const url = await originUrl(input.cwd);
      const hit = url ? forgeForUrl(env, url, input.forge) : null;
      if (!hit) return { unavailable: 'this repository has no recognisable git host' };
      const { forge, repo } = hit;
      if (!forge.openChange)
        return { unavailable: `${forge.kind === 'git' ? 'plain git' : forge.kind} has no pull request support here` };
      try {
        const c = await forge.openChange(repo, {
          base: input.base,
          head: input.branch,
          title: input.title,
          body: input.body,
        });
        return { url: c.url };
      } catch (err) {
        if (err instanceof ForgeUnavailableError) return { unavailable: err.message };
        throw err;
      }
    },
  };
}

/** Branch protection of the card's repository, where the host is known and readable; null otherwise. */
export async function branchRulesFor(
  env: ForgeEnv,
  cwd: string,
  branch: string,
  override?: ForgeKind | null,
): Promise<BranchRules | null> {
  const url = await originUrl(cwd);
  const hit = url ? forgeForUrl(env, url, override) : null;
  if (!hit?.forge.branchRules) return null;
  try {
    return (await hit.forge.branchRules(hit.repo, branch)) ?? null;
  } catch {
    return null;
  }
}

/** The git auth (args + env) for talking to a remote with git: clone, ls-remote, push. */
export async function gitAuthFor(env: ForgeEnv, url: string, override?: ForgeKind | null) {
  const hit = forgeForUrl(env, url, override);
  return hit ? hit.forge.gitAuth(url) : { args: [] as string[], env: {} as Record<string, string> };
}

/** Status of every connectable provider on this workstation (what the Workstations page shows). */
export async function gitConnections(
  env: ForgeEnv,
  hosts: Partial<Record<ConnectableForge, string[]>> = {},
): Promise<GitConnection[]> {
  const out: GitConnection[] = [];
  const known = env.tokens.list();
  for (const provider of CONNECTABLE_FORGES) {
    const list = new Set<string>(hosts[provider] ?? []);
    list.add(defaultHost(provider));
    for (const t of known) if (t.provider === provider) list.add(t.host);
    for (const host of list) {
      const forge =
        provider === 'azure-devops'
          ? new AzureDevOpsForge(env, host)
          : forgeOfKind(env, provider, host);
      if (forge.status) out.push(await forge.status());
    }
  }
  return out;
}
