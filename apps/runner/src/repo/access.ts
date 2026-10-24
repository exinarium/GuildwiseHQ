import { normalizeRemoteUrl, parseRemote, type RepoAccessPayload, remoteUrlForMethod } from '@aom/shared';
import { forgeForUrl, gitAuthFor, originUrl } from '../forge/index.ts';
import { defaultMethodFor, sshGitAuth } from '../forge/ssh.ts';
import type { ForgeEnv } from '../forge/types.ts';
import { GIT_HARDEN_ENV, hardenedGitArgs } from '../git/harden.ts';
import type { Executor } from '../toolchain/exec.ts';

export interface RepoAccessResult {
  ok: boolean;
  state: 'updated' | 'unchanged' | 'no_clone' | 'failed';
  detail: string;
  /** The `origin` url afterwards (no credentials are ever in it). */
  originUrl?: string;
  /** The reachability check after a change: `git ls-remote` with the new method. */
  reachable?: boolean;
}

/**
 * `repo.access`: the access method of a repository changed (or the owner cleared it, so the workstation default of the
 * git host applies). The clone's `origin` follows: the https url becomes the ssh url and `core.sshCommand` is set to the
 * workstation's key, or the way back (the ssh settings are removed again, gh's credential helper is set up for https).
 * Idempotent; a workstation without a clone answers `no_clone`.
 */
export class RepoAccessUpdater {
  constructor(
    private readonly deps: {
      exec: Executor;
      forge: () => ForgeEnv;
      findExisting: (normalized: string) => Promise<{ localPath: string } | undefined>;
      ghBin?: string;
    },
  ) {}

  private git(cwd: string, args: string[], env: Record<string, string> = {}) {
    return this.deps.exec.run('git', hardenedGitArgs(args), {
      cwd,
      timeoutMs: 60_000,
      env: { ...GIT_HARDEN_ENV, ...env },
    });
  }

  async run(p: RepoAccessPayload): Promise<RepoAccessResult> {
    const clone = await this.deps.findExisting(normalizeRemoteUrl(p.remoteUrl));
    if (!clone)
      return { ok: true, state: 'no_clone', detail: 'No clone of this repository on this workstation.' };
    const cwd = clone.localPath;
    const env = this.deps.forge();
    const current = await originUrl(cwd);
    if (!current) return { ok: false, state: 'failed', detail: 'The clone has no origin remote.' };

    const host = parseRemote(p.remoteUrl, p.forge)?.host;
    const method = p.accessMethod ?? (host ? defaultMethodFor(env.ssh, host) : 'https');
    const target = remoteUrlForMethod(current, method);
    if (!target)
      return {
        ok: false,
        state: 'failed',
        detail:
          method === 'ssh'
            ? `The ssh address of ${current} cannot be derived. Set the origin by hand: git remote set-url origin git@host:path.git`
            : `The https address of ${current} cannot be derived.`,
      };

    let changed = false;
    if (target !== current) {
      const r = await this.git(cwd, ['remote', 'set-url', 'origin', target]);
      if (r.exitCode !== 0)
        return {
          ok: false,
          state: 'failed',
          detail: `git remote set-url failed: ${(r.stderr || r.stdout).trim()}`,
        };
      changed = true;
    }

    if (method === 'ssh') {
      const a = sshGitAuth(env.ssh, target);
      const cmd = a?.env.GIT_SSH_COMMAND;
      if (cmd) {
        const had = await this.git(cwd, ['config', '--get', 'core.sshCommand']);
        if (had.stdout.trim() !== cmd) {
          await this.git(cwd, ['config', 'core.sshCommand', cmd]);
          changed = true;
        }
      }
    } else {
      // Back to https: forget the key setting, and let gh's login serve git as it does for a fresh https clone.
      const had = await this.git(cwd, ['config', '--get', 'core.sshCommand']);
      if (had.exitCode === 0) {
        await this.git(cwd, ['config', '--unset', 'core.sshCommand']);
        changed = true;
      }
      if (/^https?:\/\//.test(target)) {
        const hit = forgeForUrl(env, target, p.forge);
        if (hit?.forge.kind === 'github') {
          const h = new URL(target).host;
          await this.git(cwd, [
            'config',
            `credential.https://${h}.helper`,
            `!${this.deps.ghBin ?? 'gh'} auth git-credential`,
          ]);
        }
      }
    }

    // Does the repository answer with the new method? A failure is reported, the change stays (the owner fixes the key).
    const auth = await gitAuthFor(env, target, p.forge);
    const probe = await this.git(
      cwd,
      [...auth.args, 'ls-remote', '--exit-code', '--', 'origin', 'HEAD'],
      auth.env,
    );
    const reachable = probe.exitCode === 0;
    const how = method === 'ssh' ? 'SSH' : 'https';
    return {
      ok: true,
      state: changed ? 'updated' : 'unchanged',
      originUrl: target,
      reachable,
      detail: changed
        ? `origin now uses ${how}: ${target}${reachable ? '' : ` (the check failed: ${(probe.stderr || probe.stdout).trim().slice(0, 200)})`}`
        : `origin already uses ${how}`,
    };
  }
}
