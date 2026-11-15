import type { GitConnection, MergedChange, OpenChange, RepoRef } from '@aom/shared';
import { normalizeRemoteUrl } from '@aom/shared';
import { AppIdentityError, appIdentityWire, inContext } from '../git/identity.ts';
import { githubApiBase } from '../review/review-poster.ts';
import { APP_GIT_MARKER } from './app-repos.ts';
import { errText, ForgeUnavailableError, isHttps, tokenHelperEnv } from './http.ts';
import type {
  BranchRules,
  ChangeState,
  CommitStatusInput,
  CommitStatusOutcome,
  CreateReleaseInput,
  CreateRepoInput,
  Forge,
  ForgeEnv,
  ForgeRelease,
  GitAuth,
  OpenChangeInput,
  RemoteRepo,
} from './types.ts';

/** One row of `gh pr list --json number,url,title,author,headRefName,baseRefName,createdAt`. */
interface GhPr {
  number: number;
  url: string;
  title?: string;
  author?: { login?: string } | null;
  headRefName: string;
  baseRefName: string;
  createdAt: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  isCrossRepository?: boolean;
  headRefOid?: string;
}

interface GhMergedPr extends GhPr {
  headRefOid?: string;
  mergeCommit?: { oid?: string } | null;
  mergedAt?: string;
  additions?: number;
  deletions?: number;
}

interface GhRepo {
  nameWithOwner: string;
  url: string;
  sshUrl?: string;
  isPrivate?: boolean;
  defaultBranchRef?: { name?: string } | null;
}

const FIELDS = 'nameWithOwner,url,sshUrl,isPrivate,defaultBranchRef';

/** `owner/name` of a remote url. */
const fullNameOf = (url: string): string => normalizeRemoteUrl(url).split('/').slice(-2).join('/');

/**
 * GitHub.com and GitHub Enterprise Server through the `gh` CLI, which holds the login (workstation-held credentials:
 * `gh auth login --web`). For https, git borrows gh's login via `gh auth git-credential`; ssh uses the user's keys.
 */
export class GitHubForge implements Forge {
  readonly kind = 'github' as const;
  readonly caps = { listRepos: true, createRepo: true, openChange: true, branchRules: true, releases: true };

  constructor(
    private readonly env: ForgeEnv,
    readonly host = 'github.com',
  ) {}

  private get bin(): string {
    return this.env.ghBin ?? 'gh';
  }

  /** The app this repository posts as, if the payload's scope selected one. */
  private actor(fullName: string | undefined) {
    return fullName ? (this.env.app?.(this.host.toLowerCase(), fullName.toLowerCase()) ?? null) : null;
  }

  /**
   * One `gh` process. For a repository that posts as an app, a fresh installation token is fetched for this call only
   * (GH_TOKEN, GH_ENTERPRISE_TOKEN on GitHub Enterprise); when it cannot be had, `AppIdentityError` and gh is not run.
   */
  private async gh(args: string[], input?: string, repo?: string) {
    const actor = this.actor(repo);
    let tokenEnv: Record<string, string> = {};
    if (actor) {
      const t = await actor.token();
      tokenEnv = this.host === 'github.com' ? { GH_TOKEN: t } : { GH_ENTERPRISE_TOKEN: t };
    }
    return this.env.exec.run(this.bin, args, {
      timeoutMs: 120_000,
      ...(input === undefined ? {} : { input }),
      env: {
        GH_PROMPT_DISABLED: '1',
        NO_COLOR: '1',
        ...(this.host !== 'github.com' ? { GH_HOST: this.host } : {}),
        ...tokenEnv,
      },
    });
  }

  async status(): Promise<GitConnection> {
    const checkedAt = (this.env.now?.() ?? new Date()).toISOString();
    const base = { provider: 'github' as const, host: this.host, checkedAt };
    const who = await this.gh(['api', 'user', '--jq', '.login']);
    if (who.exitCode === 127)
      return {
        ...base,
        state: 'unavailable',
        detail:
          'The GitHub CLI (gh) is not installed. Install it from https://cli.github.com, then run `guildwise-runner git-connect github`.',
      };
    if (who.exitCode !== 0)
      return {
        ...base,
        state: 'not_connected',
        detail: `Run \`gh auth login --web${this.host !== 'github.com' ? ` --hostname ${this.host}` : ''}\` (or \`guildwise-runner git-connect github\`) on this workstation.`,
      };
    return { ...base, state: 'connected', method: 'cli', account: who.stdout.trim().slice(0, 200) };
  }

  async gitAuth(url: string): Promise<GitAuth> {
    if (!isHttps(url)) return { args: [], env: {} };
    const actor = this.actor(fullNameOf(url));
    if (actor) {
      // AppIdentityError propagates: fail closed, never the owner's gh login for this host.
      const token = await actor.token();
      return {
        args: [],
        env: {
          ...tokenHelperEnv(this.host, 'x-access-token', token),
          [APP_GIT_MARKER]: actor.app.integrationId,
        },
      };
    }
    return {
      args: [
        '-c',
        `credential.https://${this.host}.helper=`,
        '-c',
        `credential.https://${this.host}.helper=!${this.bin} auth git-credential`,
      ],
      env: {},
    };
  }

  private toRef(r: GhRepo): RepoRef {
    return {
      provider: 'github',
      fullName: r.nameWithOwner,
      cloneUrl: r.url.endsWith('.git') ? r.url : `${r.url}.git`,
      ...(r.sshUrl ? { sshUrl: r.sshUrl } : {}),
      ...(r.defaultBranchRef?.name ? { defaultBranch: r.defaultBranchRef.name } : {}),
      ...(r.isPrivate === undefined ? {} : { private: r.isPrivate }),
    };
  }

  async listRepos(q: { search?: string }): Promise<RepoRef[]> {
    const r = await this.gh(['repo', 'list', '--limit', '200', '--json', FIELDS]);
    if (r.exitCode !== 0)
      throw new Error(`gh repo list failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    const all = (JSON.parse(r.stdout || '[]') as GhRepo[]).map((x) => this.toRef(x));
    const s = q.search?.trim().toLowerCase();
    return (s ? all.filter((x) => x.fullName.toLowerCase().includes(s)) : all).slice(0, 100);
  }

  async createRepo(r: CreateRepoInput): Promise<RepoRef> {
    const args = ['repo', 'create', r.fullName, r.private ? '--private' : '--public'];
    if (r.description) args.push('--description', r.description);
    const made = await this.gh(args);
    if (made.exitCode !== 0)
      throw new Error(`gh repo create failed: ${(made.stderr || made.stdout).trim().slice(0, 300)}`);
    const v = await this.gh(['repo', 'view', r.fullName, '--json', FIELDS]);
    if (v.exitCode !== 0)
      throw new Error(
        `${r.fullName} was created but could not be read back: ${v.stderr.trim().slice(0, 200)}`,
      );
    return this.toRef(JSON.parse(v.stdout) as GhRepo);
  }

  async defaultBranch(repo: RemoteRepo): Promise<string | null> {
    const v = await this.gh(
      ['repo', 'view', repo.fullName, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
      undefined,
      repo.fullName,
    );
    return v.exitCode === 0 && v.stdout.trim() ? v.stdout.trim() : null;
  }

  /** The open pull requests of the repository (`gh pr list`), at most `limit`; one more is asked for to tell completeness. */
  async listOpenChanges(
    repo: RemoteRepo,
    limit: number,
  ): Promise<{ changes: OpenChange[]; complete: boolean }> {
    const r = await this.gh(
      [
        'pr',
        'list',
        '--repo',
        repo.fullName,
        '--state',
        'open',
        '--json',
        'number,url,title,author,headRefName,baseRefName,createdAt,additions,deletions,changedFiles,isCrossRepository,headRefOid',
        '--limit',
        String(limit + 1),
      ],
      undefined,
      repo.fullName,
    );
    if (r.exitCode === 127) throw new ForgeUnavailableError('gh is not available');
    if (r.exitCode !== 0)
      throw new Error(`gh pr list failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    const list = JSON.parse(r.stdout || '[]') as GhPr[];
    const changes = list.slice(0, limit).map((p) => ({
      id: String(p.number),
      url: p.url,
      title: (p.title ?? '').slice(0, 300),
      author: p.author?.login ? p.author.login.slice(0, 100) : null,
      head: p.headRefName,
      base: p.baseRefName,
      createdAt: p.createdAt,
      ...(Number.isInteger(p.additions) && Number.isInteger(p.deletions)
        ? { changedLines: (p.additions as number) + (p.deletions as number) }
        : {}),
      ...(Number.isInteger(p.changedFiles) && (p.changedFiles as number) >= 0
        ? { changedFiles: p.changedFiles as number }
        : {}),
      ...(typeof p.isCrossRepository === 'boolean' ? { crossRepo: p.isCrossRepository } : {}),
      ...(typeof p.headRefOid === 'string' && /^[0-9a-f]{40}$/.test(p.headRefOid)
        ? { headSha: p.headRefOid }
        : {}),
    }));
    return { changes, complete: list.length <= limit };
  }

  /** The merged pull requests (`gh pr list --state merged`), newest first; those without a merge commit are dropped. */
  async listMergedChanges(repo: RemoteRepo, limit: number): Promise<MergedChange[]> {
    const r = await this.gh(
      [
        'pr',
        'list',
        '--repo',
        repo.fullName,
        '--state',
        'merged',
        '--json',
        'number,url,title,author,headRefName,baseRefName,headRefOid,mergeCommit,mergedAt,additions,deletions',
        '--limit',
        String(limit),
      ],
      undefined,
      repo.fullName,
    );
    if (r.exitCode === 127) throw new ForgeUnavailableError('gh is not available');
    if (r.exitCode !== 0)
      throw new Error(`gh pr list failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    const list = JSON.parse(r.stdout || '[]') as GhMergedPr[];
    return list
      .filter((p) => p.mergeCommit?.oid && p.headRefOid && p.mergedAt)
      .map((p) => ({
        id: String(p.number),
        url: p.url,
        title: (p.title ?? '').slice(0, 300),
        author: p.author?.login ? p.author.login.slice(0, 100) : null,
        head: p.headRefName,
        base: p.baseRefName,
        headSha: p.headRefOid as string,
        mergeCommitSha: p.mergeCommit?.oid as string,
        mergedAt: p.mergedAt as string,
        additions: p.additions ?? 0,
        deletions: p.deletions ?? 0,
      }))
      .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  }

  /** The open pull request from `head` into `base`, if any (a reopened card's branch already has one). */
  private async existingChange(repo: RemoteRepo, c: OpenChangeInput) {
    const found = await this.gh(
      [
        'pr',
        'list',
        '--repo',
        repo.fullName,
        '--head',
        c.head,
        '--base',
        c.base,
        '--state',
        'open',
        '--json',
        'number,url',
        '--limit',
        '1',
      ],
      undefined,
      repo.fullName,
    );
    if (found.exitCode !== 0) return null;
    try {
      const hit = (JSON.parse(found.stdout) as Array<{ number: number; url: string }>)[0];
      return hit?.url ? { id: String(hit.number), url: hit.url } : null;
    } catch {
      return null;
    }
  }

  async openChange(repo: RemoteRepo, c: OpenChangeInput) {
    const existing = await this.existingChange(repo, c);
    if (existing) return existing;
    const r = await this.gh(
      [
        'pr',
        'create',
        '--repo',
        repo.fullName,
        '--base',
        c.base,
        '--head',
        c.head,
        '--title',
        c.title,
        '--body',
        c.body,
      ],
      undefined,
      repo.fullName,
    );
    if (r.exitCode === 127) throw new ForgeUnavailableError('gh is not available');
    if (r.exitCode !== 0) throw new Error(`gh pr create failed: ${(r.stderr || r.stdout).trim()}`);
    const url = r.stdout
      .split('\n')
      .reverse()
      .map((l) => l.trim())
      .find((l) => /^https?:\/\//.test(l));
    if (!url) throw new Error('gh pr create printed no pull request URL');
    return { id: /\/pull\/(\d+)/.exec(url)?.[1] ?? url, url };
  }

  async changeState(repo: RemoteRepo, id: string): Promise<ChangeState> {
    const r = await this.gh(
      ['pr', 'view', id, '--repo', repo.fullName, '--json', 'state', '--jq', '.state'],
      undefined,
      repo.fullName,
    );
    if (r.exitCode !== 0)
      throw new Error(`gh pr view failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    const s = r.stdout.trim().toUpperCase();
    return s === 'MERGED' ? 'merged' : s === 'CLOSED' ? 'closed' : 'open';
  }

  async changeHeads(repo: RemoteRepo, id: string): Promise<{ headSha: string; baseSha: string }> {
    const r = await this.gh(
      ['pr', 'view', id, '--repo', repo.fullName, '--json', 'headRefOid,baseRefOid'],
      undefined,
      repo.fullName,
    );
    if (r.exitCode === 127) throw new ForgeUnavailableError('gh is not available');
    if (r.exitCode !== 0)
      throw new Error(`gh pr view failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    const j = JSON.parse(r.stdout || '{}') as { headRefOid?: string; baseRefOid?: string };
    if (!j.headRefOid || !j.baseRefOid) throw new Error('gh pr view printed no head and base commit');
    return { headSha: j.headRefOid, baseSha: j.baseRefOid };
  }

  /**
   * Sets a commit status over the REST API with the size check status token. The `gh` login is never used, and the
   * token only ever goes into the Authorization header: no message below contains it.
   */
  async setCommitStatus(repo: RemoteRepo, c: CommitStatusInput): Promise<CommitStatusOutcome> {
    // A repository that posts as an app sets its statuses with the app's token, never the status token (fail closed).
    const actor = this.actor(repo.fullName);
    let token: string | undefined;
    if (actor) {
      try {
        token = await actor.token();
      } catch (err) {
        if (!(err instanceof AppIdentityError)) throw err;
        const e = inContext(err, { operation: 'commit status', repo: repo.fullName });
        return { ok: false, code: 'app_identity_failed', error: appIdentityWire(e).slice(0, 400) };
      }
    } else {
      token = this.env.statusTokens?.get('github', this.host)?.token;
      if (!token) return { ok: false, code: 'no_token', error: 'no status token is saved for this host' };
    }
    const tokenName = actor ? 'app token' : 'status token';
    let res: Response;
    try {
      res = await this.env.fetch(`${githubApiBase(this.host)}/repos/${repo.fullName}/statuses/${c.sha}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          state: c.state,
          context: c.context,
          description: c.description,
          ...(c.targetUrl ? { target_url: c.targetUrl } : {}),
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return { ok: false, code: 'error', error: 'the git host could not be reached' };
    }
    if (res.status === 201 || res.status === 200) return { ok: true };
    if (res.status === 401)
      return { ok: false, code: 'no_token', error: `the host does not accept the ${tokenName} (401)` };
    if (res.status === 403)
      return { ok: false, code: 'forbidden', error: `the ${tokenName} may not set statuses here (403)` };
    if (res.status === 404)
      return { ok: false, code: 'not_found', error: 'repository or commit not found for this token (404)' };
    if (res.status === 422)
      return { ok: false, code: 'invalid_sha', error: 'the host refused the commit (422)' };
    return { ok: false, code: 'error', error: `the host answered ${res.status}` };
  }

  async findRelease(repo: RemoteRepo, tag: string): Promise<ForgeRelease | null> {
    const r = await this.gh(
      ['release', 'view', tag, '--repo', repo.fullName, '--json', 'url,isDraft'],
      undefined,
      repo.fullName,
    );
    if (r.exitCode === 127) throw new ForgeUnavailableError('gh is not available');
    if (r.exitCode !== 0) {
      const why = (r.stderr || r.stdout).trim();
      if (/release not found|not found/i.test(why)) return null;
      throw new Error(`gh release view failed: ${why.slice(0, 300)}`);
    }
    const j = JSON.parse(r.stdout || '{}') as { url?: string; isDraft?: boolean };
    if (!j.url) throw new Error('gh release view printed no release URL');
    return { url: j.url, ...(j.isDraft ? { draft: true } : {}) };
  }

  async createRelease(repo: RemoteRepo, c: CreateReleaseInput): Promise<ForgeRelease> {
    const r = await this.gh(
      [
        'release',
        'create',
        c.tag,
        '--repo',
        repo.fullName,
        '--verify-tag',
        '--title',
        c.title,
        '--notes-file',
        '-',
        c.latest ? '--latest' : '--latest=false',
        ...(c.prerelease ? ['--prerelease'] : []),
      ],
      c.notes,
      repo.fullName,
    );
    if (r.exitCode === 127) throw new ForgeUnavailableError('gh is not available');
    if (r.exitCode !== 0) {
      const why = (r.stderr || r.stdout).trim();
      if (/already exists/i.test(why)) {
        const again = await this.findRelease(repo, c.tag);
        if (again) return again;
      }
      throw new Error(`gh release create failed: ${why.slice(0, 500)}`);
    }
    const url = r.stdout
      .split('\n')
      .reverse()
      .map((l) => l.trim())
      .find((l) => /^https?:\/\//.test(l));
    if (!url) throw new Error('gh release create printed no release URL');
    return { url };
  }

  async changeMergeCommit(repo: RemoteRepo, id: string): Promise<string | null> {
    const r = await this.gh(
      ['pr', 'view', id, '--repo', repo.fullName, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid'],
      undefined,
      repo.fullName,
    );
    if (r.exitCode !== 0) return null;
    const sha = r.stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  async branchRules(repo: RemoteRepo, branch: string): Promise<BranchRules | null> {
    try {
      const enc = encodeURIComponent(branch);
      let requiresChange = false;
      const prot = await this.gh(
        ['api', `repos/${repo.fullName}/branches/${enc}/protection`],
        undefined,
        repo.fullName,
      );
      if (prot.exitCode === 0) {
        const p = JSON.parse(prot.stdout || '{}') as {
          required_pull_request_reviews?: unknown;
          required_status_checks?: { contexts?: unknown[]; checks?: unknown[] } | null;
        };
        const checks =
          (p.required_status_checks?.contexts?.length ?? 0) + (p.required_status_checks?.checks?.length ?? 0);
        requiresChange = !!p.required_pull_request_reviews || checks > 0;
      } else if (!/not protected|404/i.test(prot.stderr + prot.stdout)) {
        return null; // no permission to read protection (403) or gh missing: unknown
      }
      const rules = await this.gh(
        ['api', `repos/${repo.fullName}/rules/branches/${enc}`],
        undefined,
        repo.fullName,
      );
      if (rules.exitCode === 0) {
        const list = JSON.parse(rules.stdout || '[]') as Array<{ type?: string }>;
        if (list.some((x) => x.type === 'pull_request' || x.type === 'required_status_checks'))
          requiresChange = true;
      }
      return { directPushAllowed: !requiresChange, requiresChange };
    } catch (err) {
      void errText(err);
      return null;
    }
  }
}
