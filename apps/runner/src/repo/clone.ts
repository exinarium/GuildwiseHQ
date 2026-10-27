import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  isSshRemote,
  normalizeRemoteUrl,
  parseRemote,
  type RepoClonePayload,
  type RepoCloneResult,
  type RepoCreatePayload,
  type RepoCreateResult,
  remoteUrlForMethod,
} from '@aom/shared';
import { forgeForUrl } from '../forge/index.ts';
import { defaultMethodFor, sshGitAuth } from '../forge/ssh.ts';
import type { ForgeEnv, GitAuth } from '../forge/types.ts';
import { GIT_HARDEN_ENV, hardenedGitArgs } from '../git/harden.ts';
import type { Executor } from '../toolchain/exec.ts';

/** `https://github.com/acme/My-App.git` -> `My-App`; null when nothing safe is left. */
export function dirNameFromUrl(url: string): string | null {
  const last = url
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .split(/[/:]/)
    .pop();
  const name = (last ?? '').replace(/\.git$/i, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && name !== '.' && name !== '..' ? name : null;
}

const AUTH =
  /could not read (username|password)|authentication failed|permission denied|publickey|access denied|403|401/i;
const NOT_FOUND = /repository not found|not found|does not appear to be a git repository|does not exist|404/i;

/**
 * `repo.clone`: puts a repository added to a project on this workstation. Plain code, no agent:
 *
 * 1. an existing clone of the repository (anywhere under the repository roots, or in the target folder) is reported,
 *    not touched; a non-empty folder that is not that clone is never overwritten;
 * 2. the remote is probed with `git ls-remote` (and again with gh's login for https hosts when the first probe is refused);
 * 3. it exists: `git clone` into the first repository root; it does not and the manager chose "create new":
 *    `RepoCreator` makes it (gh), pushes the first commit and clones it; otherwise a clear reason, and a question to the
 *    manager when the cause is access.
 *
 * Idempotent: running it again finds the clone and answers "already cloned".
 */
export class RepoCloner {
  constructor(
    private readonly deps: {
      repoRoots: () => string[];
      exec: Executor;
      /** A clone of this normalized remote that the runner already knows (its repo scan). */
      findExisting: (normalized: string) => Promise<{ localPath: string } | undefined>;
      creator: { run(p: RepoCreatePayload): Promise<RepoCreateResult> };
      ghBin?: string;
      /** The machine seam of the forge adapters: credentials for GitLab, Azure DevOps and Bitbucket. Without it only gh's login is tried. */
      forge?: () => ForgeEnv;
      /** Reread the repositories after a clone, so cards can be claimed at once. */
      afterClone?: () => Promise<void>;
    },
  ) {}

  private inFlight = new Map<string, Promise<RepoCloneResult>>();

  /** One run per repository at a time: a second request joins the first. */
  run(p: RepoClonePayload): Promise<RepoCloneResult> {
    const key = normalizeRemoteUrl(p.remoteUrl);
    const running = this.inFlight.get(key);
    if (running) return running;
    const job = this.clone(p)
      .catch(
        (err): RepoCloneResult => ({
          ok: false,
          state: 'failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  /** The credential for the repository's host: its forge adapter's (gh login, saved token), else gh's login for https. */
  private async authFor(url: string, forge?: RepoClonePayload['forge']): Promise<GitAuth | null> {
    const env = this.deps.forge?.();
    // An ssh remote uses this workstation's key (GIT_SSH_COMMAND), never a token.
    const viaSsh = sshGitAuth(env?.ssh, url);
    if (viaSsh) return viaSsh;
    if (isSshRemote(url)) return null;
    if (env) {
      const hit = forgeForUrl(env, url, forge);
      if (hit && hit.forge.kind !== 'git') {
        const a = await hit.forge.gitAuth(url);
        return a.args.length || Object.keys(a.env).length ? a : null;
      }
    }
    if (!/^https?:\/\//.test(url)) return null;
    const host = new URL(url).host;
    return {
      args: [
        '-c',
        `credential.https://${host}.helper=`,
        '-c',
        `credential.https://${host}.helper=!${this.deps.ghBin ?? 'gh'} auth git-credential`,
      ],
      env: {},
    };
  }

  private git(args: string[], cwd?: string, timeoutMs = 600_000, env: Record<string, string> = {}) {
    return this.deps.exec.run('git', hardenedGitArgs(args), {
      ...(cwd ? { cwd } : {}),
      timeoutMs,
      env: { ...GIT_HARDEN_ENV, ...env },
    });
  }

  /** `exists` plus the credential that was needed (null: none). */
  private async probe(
    url: string,
    forge?: RepoClonePayload['forge'],
  ): Promise<{ exists: boolean; auth: GitAuth | null; error: string }> {
    if (isSshRemote(url)) {
      // ssh would ask about an unknown host key on a terminal there is none of: always go through the pinned known_hosts.
      const a = await this.authFor(url, forge);
      const r = await this.git([...(a?.args ?? []), 'ls-remote', '--', url], undefined, 60_000, a?.env);
      return r.exitCode === 0
        ? { exists: true, auth: a, error: '' }
        : { exists: false, auth: null, error: (r.stderr || r.stdout).trim().slice(0, 400) };
    }
    const plain = await this.git(['ls-remote', '--', url], undefined, 60_000);
    if (plain.exitCode === 0) return { exists: true, auth: null, error: '' };
    const auth = await this.authFor(url, forge);
    if (auth) {
      const viaAuth = await this.git([...auth.args, 'ls-remote', '--', url], undefined, 60_000, auth.env);
      if (viaAuth.exitCode === 0) return { exists: true, auth, error: '' };
    }
    return { exists: false, auth: null, error: (plain.stderr || plain.stdout).trim().slice(0, 400) };
  }

  private async clone(p: RepoClonePayload): Promise<RepoCloneResult> {
    const normalized = normalizeRemoteUrl(p.remoteUrl);
    const known = await this.deps.findExisting(normalized);
    if (known)
      return {
        ok: true,
        state: 'cloned',
        existing: true,
        localPath: known.localPath,
        detail: `Already cloned at ${known.localPath}`,
      };

    const rootDir = this.deps.repoRoots()[0];
    if (!rootDir)
      return {
        ok: false,
        state: 'needs_manager',
        error:
          'this workstation has no repository folder: run `guildwise-runner repos add <path>` and try again',
      };
    mkdirSync(rootDir, { recursive: true });
    const root = realpathSync(rootDir);
    // How git reaches the repository: the owner's choice for it, else the workstation default of its host.
    const host = parseRemote(p.remoteUrl, p.forge)?.host;
    const method =
      p.accessMethod ??
      (isSshRemote(p.remoteUrl) ? 'ssh' : host ? defaultMethodFor(this.deps.forge?.().ssh, host) : 'https');
    const converted = p.create ? p.remoteUrl : remoteUrlForMethod(p.remoteUrl, method);
    const remoteUrl = converted ?? (method === 'https' ? p.remoteUrl : null);
    if (!remoteUrl)
      return {
        ok: false,
        state: 'needs_manager',
        error: `cannot derive the ssh address of ${p.remoteUrl}: add the repository with its ssh URL (for example git@host:path.git)`,
      };
    const dir = dirNameFromUrl(p.remoteUrl) ?? dirNameFromUrl(p.create?.name ?? '') ?? null;
    if (!dir) return { ok: false, state: 'failed', error: `cannot derive a folder name from ${p.remoteUrl}` };
    const target = resolve(root, dir);
    const rel = relative(root, target);
    if (!rel || rel.startsWith('..') || rel.includes(sep))
      return { ok: false, state: 'failed', error: 'the clone path is outside the repository folder' };

    if (existsSync(target)) {
      const entries = readdirSync(target);
      if (entries.length > 0)
        return {
          ok: false,
          state: 'failed',
          error: `${target} already exists and is not a clone of ${p.remoteUrl}, so it was not touched. Move it away or clone the repository by hand.`,
        };
      // an empty folder is fine to clone into
    }

    const probe = await this.probe(remoteUrl, p.forge);
    if (probe.exists) {
      const auth = probe.auth?.args ?? [];
      const r = await this.git([...auth, 'clone', '--', remoteUrl, target], root, 600_000, probe.auth?.env);
      if (r.exitCode !== 0)
        return {
          ok: false,
          state: 'failed',
          error: `git clone failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`,
        };
      if (probe.auth && !Object.keys(probe.auth.env).length && /^https?:\/\//.test(remoteUrl)) {
        const host = new URL(remoteUrl).host;
        // Later fetches and pushes in this clone keep using gh's login (token-based hosts pass theirs per command).
        await this.git(
          ['config', `credential.https://${host}.helper`, `!${this.deps.ghBin ?? 'gh'} auth git-credential`],
          target,
        );
      }
      if (isSshRemote(remoteUrl)) {
        const ssh = this.deps.forge?.().ssh;
        // Later fetches, rebases and pushes in this clone (and its worktrees) use the same key.
        if (ssh) {
          const a = sshGitAuth(ssh, remoteUrl);
          if (a?.env.GIT_SSH_COMMAND)
            await this.git(['config', 'core.sshCommand', a.env.GIT_SSH_COMMAND], target);
        }
      }
      await this.deps.afterClone?.();
      return { ok: true, state: 'cloned', localPath: realpathSync(target), detail: `Cloned to ${target}` };
    }

    if (p.create) {
      const made = await this.deps.creator.run({
        requestId: p.requestId,
        name: p.create.name,
        ...(p.create.provider ? { provider: p.create.provider } : {}),
        ...(p.create.host ? { host: p.create.host } : {}),
        visibility: p.create.visibility,
        ...(p.create.description ? { description: p.create.description } : {}),
        projectKey: p.projectKey,
        projectName: p.projectName,
        branch: p.workingBranch ?? 'main',
      });
      if (!made.ok)
        return { ok: false, state: 'needs_manager', error: made.error ?? 'creating the repository failed' };
      await this.deps.afterClone?.();
      return {
        ok: true,
        state: 'created',
        ...(made.localPath ? { localPath: made.localPath } : {}),
        detail: made.existing
          ? 'The repository existed and was reused'
          : `Created ${p.create.name} (${p.create.visibility}) and cloned it${made.localPath ? ` to ${made.localPath}` : ''}`,
      };
    }

    if (AUTH.test(probe.error) && !NOT_FOUND.test(probe.error.replace(/could not read/gi, '')))
      return {
        ok: false,
        state: 'needs_manager',
        error: `this workstation cannot reach ${p.remoteUrl}: ${probe.error}. Log in on the workstation (gh auth login, or an SSH key for the host), then retry.`,
      };
    return {
      ok: false,
      state: 'failed',
      error: `the repository ${p.remoteUrl} does not exist, or this workstation has no access to it (${probe.error || 'no answer'}). Check the URL, or remove it and add it again with "Create new".`,
    };
  }
}
