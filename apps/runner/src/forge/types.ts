import type { ForgeKind, GitConnection, RepoRef } from '@aom/shared';
import type { Executor } from '../toolchain/exec.ts';
import type { SshEnv } from './ssh.ts';
import type { TokenStore } from './tokens.ts';

/** Everything an adapter needs from the machine. Tests inject fakes: nothing talks to a real forge from tests. */
export interface ForgeEnv {
  exec: Executor;
  fetch: typeof fetch;
  tokens: TokenStore;
  ghBin?: string;
  glabBin?: string;
  azBin?: string;
  /** The process environment (`AZURE_*` service principal settings); defaults to `process.env`. */
  processEnv?: Record<string, string | undefined>;
  /** SSH access (key choice, known_hosts). Absent: ssh remotes use the user's own ssh setup. */
  ssh?: SshEnv;
  now?: () => Date;
}

/** Where a repository is on its forge. */
export interface RemoteRepo {
  kind: ForgeKind;
  host: string;
  /** `owner/repo`, `group/sub/repo`, `org/project/repo`. */
  fullName: string;
  url: string;
}

/** Credential use for git itself (clone, ls-remote, push). Secrets only ever sit in `env` of the git process. */
export interface GitAuth {
  /** Extra `git -c key=value` pairs that hold no secret. */
  args: string[];
  /** Environment for the git process (may hold a token; never logged, never exported to agents). */
  env: Record<string, string>;
}

export interface BranchRules {
  /** A direct push to the branch is allowed for this user. */
  directPushAllowed: boolean;
  /** Changes must come in through a pull request / merge request. */
  requiresChange: boolean;
}

export interface OpenChangeInput {
  base: string;
  head: string;
  title: string;
  body: string;
}

export interface ForgeRelease {
  url: string;
  draft?: boolean;
}

export interface CreateReleaseInput {
  tag: string;
  title: string;
  notes: string;
  /** Marked as the latest release. */
  latest: boolean;
  prerelease: boolean;
}

export type ChangeState = 'open' | 'merged' | 'closed';

export interface CreateRepoInput {
  /** The full name made by `createNameFor`. */
  fullName: string;
  private: boolean;
  description?: string;
}

/**
 * One git host (docs/design/cloud-workstations-and-forges.md section 2.3), bound to the host of a repository.
 * Optional members are the capabilities the plain-git fallback lacks (`caps`).
 */
export interface Forge {
  readonly kind: ForgeKind;
  readonly host: string;
  readonly caps: {
    listRepos: boolean;
    createRepo: boolean;
    openChange: boolean;
    branchRules: boolean;
    /** Release pages (GitHub, GitLab). Without them the tag is the release. */
    releases: boolean;
  };
  /** Connected or not, from this workstation's login. Never returns a secret. */
  status?(): Promise<GitConnection>;
  gitAuth(url: string): Promise<GitAuth>;
  listRepos?(q: { search?: string }): Promise<RepoRef[]>;
  /** Creates the repository; returns the clone urls. */
  createRepo?(r: CreateRepoInput): Promise<RepoRef>;
  /** The repository's default branch, or null when it cannot be told. */
  defaultBranch(repo: RemoteRepo): Promise<string | null>;
  openChange?(repo: RemoteRepo, c: OpenChangeInput): Promise<{ id: string; url: string }>;
  changeState?(repo: RemoteRepo, id: string): Promise<ChangeState>;
  /** Null when the rules cannot be read (not connected, no permission): callers then assume a direct push may work. */
  branchRules?(repo: RemoteRepo, branch: string): Promise<BranchRules | null>;
  /** The release page of a tag; null when there is none. Never creates anything. */
  findRelease?(repo: RemoteRepo, tag: string): Promise<ForgeRelease | null>;
  /** Creates the release page for an existing, pushed tag. An existing release is returned, never edited. */
  createRelease?(repo: RemoteRepo, r: CreateReleaseInput): Promise<ForgeRelease>;
  /** The commit a merged change landed as on its base branch (squash and rebase merges); null when unknown. */
  changeMergeCommit?(repo: RemoteRepo, id: string): Promise<string | null>;
}
