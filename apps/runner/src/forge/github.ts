import type { GitConnection, RepoRef } from '@aom/shared';
import { errText, ForgeUnavailableError, isHttps } from './http.ts';
import type {
  BranchRules,
  ChangeState,
  CreateReleaseInput,
  CreateRepoInput,
  Forge,
  ForgeRelease,
  ForgeEnv,
  GitAuth,
  OpenChangeInput,
  RemoteRepo,
} from './types.ts';

interface GhRepo {
  nameWithOwner: string;
  url: string;
  sshUrl?: string;
  isPrivate?: boolean;
  defaultBranchRef?: { name?: string } | null;
}

const FIELDS = 'nameWithOwner,url,sshUrl,isPrivate,defaultBranchRef';

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

  private gh(args: string[], input?: string) {
    return this.env.exec.run(this.bin, args, {
      timeoutMs: 120_000,
      ...(input === undefined ? {} : { input }),
      env: {
        GH_PROMPT_DISABLED: '1',
        NO_COLOR: '1',
        ...(this.host !== 'github.com' ? { GH_HOST: this.host } : {}),
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
    const v = await this.gh([
      'repo',
      'view',
      repo.fullName,
      '--json',
      'defaultBranchRef',
      '--jq',
      '.defaultBranchRef.name',
    ]);
    return v.exitCode === 0 && v.stdout.trim() ? v.stdout.trim() : null;
  }

  /** The open pull request from `head` into `base`, if any (a reopened card's branch already has one). */
  private async existingChange(repo: RemoteRepo, c: OpenChangeInput) {
    const found = await this.gh([
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
    ]);
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
    const r = await this.gh([
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
    ]);
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
    const r = await this.gh(['pr', 'view', id, '--repo', repo.fullName, '--json', 'state', '--jq', '.state']);
    if (r.exitCode !== 0)
      throw new Error(`gh pr view failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    const s = r.stdout.trim().toUpperCase();
    return s === 'MERGED' ? 'merged' : s === 'CLOSED' ? 'closed' : 'open';
  }

  async findRelease(repo: RemoteRepo, tag: string): Promise<ForgeRelease | null> {
    const r = await this.gh(['release', 'view', tag, '--repo', repo.fullName, '--json', 'url,isDraft']);
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
    const r = await this.gh([
      'pr',
      'view',
      id,
      '--repo',
      repo.fullName,
      '--json',
      'mergeCommit',
      '--jq',
      '.mergeCommit.oid',
    ]);
    if (r.exitCode !== 0) return null;
    const sha = r.stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  async branchRules(repo: RemoteRepo, branch: string): Promise<BranchRules | null> {
    try {
      const enc = encodeURIComponent(branch);
      let requiresChange = false;
      const prot = await this.gh(['api', `repos/${repo.fullName}/branches/${enc}/protection`]);
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
      const rules = await this.gh(['api', `repos/${repo.fullName}/rules/branches/${enc}`]);
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
