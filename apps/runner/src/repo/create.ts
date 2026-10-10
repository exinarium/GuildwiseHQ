import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { cloneUrlFor, type RepoCreatePayload, type RepoCreateResult, repoNameError } from '@aom/shared';
import { execa } from 'execa';
import { forgeOfKind } from '../forge/index.ts';
import type { ForgeEnv } from '../forge/types.ts';

/**
 * Executes the `repo.create` command (approved repository setup). The server sends it only to the project owner's own
 * workstation after the owner approved it on the desk, so the `gh` login used here is the owner's. Plain code, no
 * shell, no agent involved:
 *
 * 1. validate the name again and pick the clone target inside the first configured repo root (realpath confinement);
 * 2. an existing repository is refused unless it is empty and owned by the logged-in user (then it is reused);
 * 3. `gh repo create <name> --private|--public [--description ...]`;
 * 4. clone it, make the first commit (README.md) on the working branch and push it;
 * 5. report the remote URL and the local path.
 *
 * Providers other than GitHub (GitLab, Azure DevOps, Bitbucket Cloud) go through their forge adapter (`createViaForge`):
 * the same steps, with the repository made over the provider's API and git using the workstation's saved credential.
 *
 * Idempotent: one record per request (`repo-<requestId>.json`). A request already done answers with its recorded result;
 * a retry after a partial run reuses the empty repository and the clone that already exist, so there is never a second
 * repository.
 */
export class RepoCreator {
  private readonly inFlight = new Map<string, Promise<RepoCreateResult>>();

  constructor(
    private readonly deps: {
      /** Where records live (the runner's private `outbound` dir). */
      dir: string;
      repoRoots: () => string[];
      ghBin?: string;
      /** The machine seam of the forge adapters (GitLab, Azure DevOps, Bitbucket). GitHub keeps using `gh` directly. */
      forge?: () => ForgeEnv;
    },
  ) {}

  private file(id: string): string {
    return join(this.deps.dir, `repo-${id}.json`);
  }

  private recorded(id: string): RepoCreateResult | null {
    try {
      return JSON.parse(readFileSync(this.file(id), 'utf8')) as RepoCreateResult;
    } catch {
      return null;
    }
  }

  run(payload: RepoCreatePayload): Promise<RepoCreateResult> {
    const running = this.inFlight.get(payload.requestId);
    if (running) return running;
    const p = this.create(payload)
      .catch(
        (err): RepoCreateResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => this.inFlight.delete(payload.requestId));
    this.inFlight.set(payload.requestId, p);
    return p;
  }

  private async gh(args: string[]) {
    const r = await execa(this.deps.ghBin ?? 'gh', args, {
      reject: false,
      stdin: 'ignore',
      timeout: 120_000,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    });
    if (r.failed && (r as { code?: string }).code === 'ENOENT')
      throw new Error('gh is not installed on this workstation');
    return r;
  }

  private git(cwd: string, args: string[], env: Record<string, string> = {}) {
    return execa('git', args, {
      cwd,
      reject: false,
      stdin: 'ignore',
      timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    });
  }

  private async create(p: RepoCreatePayload): Promise<RepoCreateResult> {
    const done = this.recorded(p.requestId);
    if (done?.ok) return done;
    if (p.provider && p.provider !== 'github') return this.createViaForge(p);
    const bad = repoNameError(p.name);
    if (bad) return { ok: false, error: bad };
    const repo = p.name.split('/')[1] as string;

    const root = this.deps.repoRoots()[0];
    if (!root)
      return {
        ok: false,
        error: 'this workstation has no repository root: run `aom-runner repos add <path>` first',
      };
    if (!existsSync(root)) return { ok: false, error: `the repository root ${root} does not exist` };
    const realRoot = realpathSync(root);
    const target = resolve(realRoot, repo);
    const rel = relative(realRoot, target);
    if (!rel || rel.startsWith('..') || rel.includes(sep))
      return { ok: false, error: 'the clone path is outside the repository root' };
    if (existsSync(target) && !realpathSync(target).startsWith(realRoot + sep))
      return { ok: false, error: 'the clone path is outside the repository root' };

    const who = await this.gh(['api', 'user', '--jq', '.login']);
    if (who.exitCode !== 0)
      return {
        ok: false,
        error: `gh is not logged in on this workstation (run \`gh auth login\`): ${String(who.stderr || who.stdout).trim()}`,
      };
    const login = String(who.stdout).trim();

    // Does it exist already?
    const view = await this.gh(['repo', 'view', p.name, '--json', 'url,sshUrl,isEmpty,owner']);
    let url: string | undefined;
    let sshUrl: string | undefined;
    let existing = false;
    if (view.exitCode === 0) {
      const v = JSON.parse(String(view.stdout)) as {
        url: string;
        sshUrl?: string;
        isEmpty?: boolean;
        owner?: { login?: string };
      };
      const mine = v.owner?.login?.toLowerCase() === login.toLowerCase();
      if (!(mine && (v.isEmpty || (await this.isOurClone(target, [v.url, v.sshUrl])))))
        return {
          ok: false,
          error: `${p.name} already exists on GitHub and is not an empty repository of ${login}, so it was not touched`,
        };
      url = v.url;
      sshUrl = v.sshUrl;
      existing = true;
    } else if (!/could not resolve|not found|404/i.test(String(view.stderr))) {
      return { ok: false, error: `could not check ${p.name}: ${String(view.stderr || view.stdout).trim()}` };
    } else {
      const args = ['repo', 'create', p.name, p.visibility === 'public' ? '--public' : '--private'];
      if (p.description) args.push('--description', p.description);
      const made = await this.gh(args);
      if (made.exitCode !== 0)
        return { ok: false, error: `gh repo create failed: ${String(made.stderr || made.stdout).trim()}` };
      const again = await this.gh(['repo', 'view', p.name, '--json', 'url,sshUrl']);
      if (again.exitCode !== 0)
        return {
          ok: false,
          error: `${p.name} was created but its URL could not be read: ${String(again.stderr).trim()}`,
        };
      ({ url, sshUrl } = JSON.parse(String(again.stdout)) as { url: string; sshUrl?: string });
    }
    // Clone with the protocol the owner's gh uses for this host (ssh here: the owner's other repos are git@github.com:
    // remotes). Over https, git borrows gh's login (`gh auth git-credential`) so no username prompt can block it.
    const host = /^https?:\/\//.test(url) ? new URL(url).host : undefined;
    const proto = host
      ? String((await this.gh(['config', 'get', 'git_protocol', '-h', host])).stdout).trim()
      : '';
    const useSsh = proto === 'ssh' && !!sshUrl;
    const remoteUrl = useSsh
      ? (sshUrl as string)
      : /^https?:\/\//.test(url) && !url.endsWith('.git')
        ? `${url}.git`
        : url;
    const auth =
      useSsh || !host
        ? []
        : [
            '-c',
            `credential.https://${host}.helper=`,
            '-c',
            `credential.https://${host}.helper=!${this.deps.ghBin ?? 'gh'} auth git-credential`,
          ];

    if (existsSync(target)) {
      const origin = await this.git(target, ['remote', 'get-url', 'origin']);
      if (
        origin.exitCode !== 0 ||
        ![remoteUrl, url, `${url}.git`, sshUrl].includes(String(origin.stdout).trim())
      )
        return { ok: false, error: `${target} already exists and is not a clone of ${p.name}` };
    } else {
      const clone = await this.git(realRoot, [...auth, 'clone', remoteUrl, target]);
      if (clone.exitCode !== 0)
        return { ok: false, error: `git clone failed: ${String(clone.stderr || clone.stdout).trim()}` };
      // Later pushes (the finalize step) run plain git in this clone: keep gh's login for https there too.
      if (!useSsh && host)
        await this.git(target, [
          'config',
          `credential.https://${host}.helper`,
          `!${this.deps.ghBin ?? 'gh'} auth git-credential`,
        ]);
    }

    const published = await this.git(target, [...auth, 'ls-remote', '--heads', 'origin', p.branch]);
    if (!String(published.stdout).trim()) {
      const head = await this.git(target, ['symbolic-ref', 'HEAD', `refs/heads/${p.branch}`]);
      if (head.exitCode !== 0)
        return { ok: false, error: `git could not switch to ${p.branch}: ${String(head.stderr).trim()}` };
      const readme = join(target, 'README.md');
      if (!existsSync(readme)) writeFileSync(readme, `# ${p.projectName}\n`);
      await this.git(target, ['add', 'README.md']);
      const hasId = (await this.git(target, ['config', 'user.email'])).exitCode === 0;
      const commit = await this.git(target, [
        ...(hasId ? [] : ['-c', 'user.name=Guildwise HQ', '-c', 'user.email=aom@localhost']),
        'commit',
        '-m',
        'Initial commit',
        '--allow-empty',
      ]);
      if (commit.exitCode !== 0)
        return { ok: false, error: `git commit failed: ${String(commit.stderr || commit.stdout).trim()}` };
      const push = await this.git(target, [...auth, 'push', '-u', 'origin', p.branch]);
      if (push.exitCode !== 0)
        return { ok: false, error: `git push failed: ${String(push.stderr || push.stdout).trim()}` };
    }

    const result: RepoCreateResult = {
      ok: true,
      remoteUrl,
      localPath: realpathSync(target),
      ...(existing ? { existing: true } : {}),
    };
    mkdirSync(this.deps.dir, { recursive: true });
    writeFileSync(this.file(p.requestId), `${JSON.stringify(result)}\n`);
    return result;
  }

  /** The clone folder inside the first repository root, confined to it. */
  private targetFor(repo: string): { ok: true; realRoot: string; target: string } | { ok: false; error: string } {
    const root = this.deps.repoRoots()[0];
    if (!root)
      return {
        ok: false,
        error: 'this workstation has no repository root: run `aom-runner repos add <path>` first',
      };
    if (!existsSync(root)) return { ok: false, error: `the repository root ${root} does not exist` };
    const realRoot = realpathSync(root);
    const target = resolve(realRoot, repo);
    const rel = relative(realRoot, target);
    if (!rel || rel.startsWith('..') || rel.includes(sep))
      return { ok: false, error: 'the clone path is outside the repository root' };
    if (existsSync(target) && !realpathSync(target).startsWith(realRoot + sep))
      return { ok: false, error: 'the clone path is outside the repository root' };
    return { ok: true, realRoot, target };
  }

  /** `repo.create` for a provider with an adapter: create over its API, clone, first commit, push. */
  private async createViaForge(p: RepoCreatePayload): Promise<RepoCreateResult> {
    const kind = p.provider as NonNullable<RepoCreatePayload['provider']>;
    const env = this.deps.forge?.();
    if (!env) return { ok: false, error: 'this runner has no git-host support configured' };
    const forge = forgeOfKind(env, kind, p.host);
    if (!forge.createRepo)
      return { ok: false, error: `repositories cannot be created on ${kind}: create it there and add its URL` };
    const status = forge.status ? await forge.status() : undefined;
    if (status && status.state !== 'connected')
      return {
        ok: false,
        error: `this workstation is not connected to ${kind} (${status.detail ?? 'run `aom-runner git-connect`'})`,
      };
    const repo = p.name.split('/').pop() as string;
    const t = this.targetFor(repo);
    if (!t.ok) return { ok: false, error: t.error };
    const { realRoot, target } = t;

    // Does it exist already? An empty repository (a retry after a partial run) is reused; anything else is not touched.
    const expected = cloneUrlFor(kind, p.name, p.host);
    const auth = await forge.gitAuth(expected);
    const probe = await this.git(realRoot, [...auth.args, 'ls-remote', '--heads', '--', expected], auth.env);
    let ref: { cloneUrl: string; sshUrl?: string | undefined };
    let existing = false;
    if (probe.exitCode === 0) {
      if (String(probe.stdout).trim() && !(await this.isOurClone(target, [expected])))
        return { ok: false, error: `${p.name} already exists on ${kind} and is not empty, so it was not touched` };
      ref = { cloneUrl: expected };
      existing = true;
    } else {
      ref = await forge.createRepo({
        fullName: p.name,
        private: p.visibility !== 'public',
        ...(p.description ? { description: p.description } : {}),
      });
    }
    const remoteUrl = ref.cloneUrl;
    const gitAuth = await forge.gitAuth(remoteUrl);

    if (existsSync(target)) {
      const origin = await this.git(target, ['remote', 'get-url', 'origin']);
      if (origin.exitCode !== 0 || ![remoteUrl, expected, ref.sshUrl].includes(String(origin.stdout).trim()))
        return { ok: false, error: `${target} already exists and is not a clone of ${p.name}` };
    } else {
      const clone = await this.git(realRoot, [...gitAuth.args, 'clone', remoteUrl, target], gitAuth.env);
      if (clone.exitCode !== 0)
        return { ok: false, error: `git clone failed: ${String(clone.stderr || clone.stdout).trim()}` };
    }
    const published = await this.git(target, [...gitAuth.args, 'ls-remote', '--heads', 'origin', p.branch], gitAuth.env);
    if (!String(published.stdout).trim()) {
      const head = await this.git(target, ['symbolic-ref', 'HEAD', `refs/heads/${p.branch}`]);
      if (head.exitCode !== 0)
        return { ok: false, error: `git could not switch to ${p.branch}: ${String(head.stderr).trim()}` };
      const readme = join(target, 'README.md');
      if (!existsSync(readme)) writeFileSync(readme, `# ${p.projectName}\n`);
      await this.git(target, ['add', 'README.md']);
      const hasId = (await this.git(target, ['config', 'user.email'])).exitCode === 0;
      const commit = await this.git(target, [
        ...(hasId ? [] : ['-c', 'user.name=Guildwise HQ', '-c', 'user.email=aom@localhost']),
        'commit',
        '-m',
        'Initial commit',
        '--allow-empty',
      ]);
      if (commit.exitCode !== 0)
        return { ok: false, error: `git commit failed: ${String(commit.stderr || commit.stdout).trim()}` };
      const push = await this.git(target, [...gitAuth.args, 'push', '-u', 'origin', p.branch], gitAuth.env);
      if (push.exitCode !== 0)
        return { ok: false, error: `git push failed: ${String(push.stderr || push.stdout).trim()}` };
    }
    const result: RepoCreateResult = {
      ok: true,
      remoteUrl,
      localPath: realpathSync(target),
      ...(existing ? { existing: true } : {}),
    };
    mkdirSync(this.deps.dir, { recursive: true });
    writeFileSync(this.file(p.requestId), `${JSON.stringify(result)}\n`);
    return result;
  }

  /** A repository that is not empty but whose clone here is the one a previous run of this request made (same origin). */
  private async isOurClone(target: string, urls: Array<string | undefined>): Promise<boolean> {
    if (!existsSync(join(target, '.git'))) return false;
    const origin = await this.git(target, ['remote', 'get-url', 'origin']);
    const o = String(origin.stdout).trim();
    const ok = urls.filter((u): u is string => !!u).flatMap((u) => [u, `${u}.git`]);
    return origin.exitCode === 0 && ok.includes(o);
  }
}
