import type { ForgeKind } from '@aom/shared';
import { GIT_HARDEN_ENV, hardenedGitArgs } from '../git/harden.ts';
import type { Forge, ForgeEnv, GitAuth, RemoteRepo } from './types.ts';

/**
 * Plain git (and hosts we have no API adapter for, such as Bitbucket Data Center): push a branch, no pull request.
 * Credentials are whatever the user's git has (SSH keys, a credential helper). The `merge` completion keeps working
 * (local merge + push); a refused push to a protected branch is the only signal.
 */
export class PlainGitForge implements Forge {
  readonly caps = {
    listRepos: false,
    createRepo: false,
    openChange: false,
    branchRules: false,
    releases: false,
  };

  constructor(
    private readonly env: ForgeEnv,
    readonly host: string,
    readonly kind: ForgeKind = 'git',
  ) {}

  async gitAuth(): Promise<GitAuth> {
    return { args: [], env: {} };
  }

  async defaultBranch(repo: RemoteRepo): Promise<string | null> {
    const r = await this.env.exec.run(
      'git',
      hardenedGitArgs(['ls-remote', '--symref', '--', repo.url, 'HEAD']),
      {
        timeoutMs: 60_000,
        env: { ...GIT_HARDEN_ENV },
      },
    );
    const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(r.stdout);
    return r.exitCode === 0 && m ? (m[1] as string) : null;
  }
}
