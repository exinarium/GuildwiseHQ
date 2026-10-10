import type { ForgeKind, GitConnection, RepoRef } from '@aom/shared';
import type { Executor } from '../toolchain/exec.ts';
import type { TokenStore } from './tokens.ts';

/** Everything an adapter needs from the machine. Tests inject fakes: nothing talks to a real forge from tests. */
export interface ForgeEnv {
  exec: Executor;
  fetch: typeof fetch;
  tokens: TokenStore;
  ghBin?: string;
  glabBin?: string;
  azBin?: string;
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
}
