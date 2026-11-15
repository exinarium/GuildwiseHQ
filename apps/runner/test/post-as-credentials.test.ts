import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PostAsPlan } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { AppTokenBroker } from '../src/apps/broker.ts';
import { type AppProviderFactory, AppTokenError } from '../src/apps/types.ts';
import { actorScope, appOriginRefusal } from '../src/forge/app-actor.ts';
import { appRepos } from '../src/forge/app-repos.ts';
import { forgePrCreator, GitHubForge, MemoryTokenStore } from '../src/forge/index.ts';
import type { ForgeEnv } from '../src/forge/types.ts';
import { describePushRejection } from '../src/git/gh.ts';
import { git } from '../src/git/git.ts';
import { AppIdentityError } from '../src/git/identity.ts';
import type { ExecOptions, ExecResult, Executor } from '../src/toolchain/exec.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';

cleanupTmp();
afterEach(() => appRepos.clear());

const MIN = 60_000;
const T0 = Date.parse('2026-11-15T08:00:00Z');
const INTEGRATION = '0b9f3c0e-1d2a-4c1b-9a51-6f0e2a7d8c11';
const APP = {
  integrationId: INTEGRATION,
  provider: 'github-app' as const,
  label: 'Guild Bot',
  botName: 'guild-bot[bot]',
  botEmail: '99+guild-bot[bot]@users.noreply.github.com',
  instance: '4242:777',
  host: 'github.com',
};
const plan = (source: 'app' | 'project' = 'app', remote = 'github.com/acme/web'): PostAsPlan => ({
  repos: [
    {
      repoId: '0b9f3c0e-1d2a-4c1b-9a51-6f0e2a7d8c12',
      remoteUrlNormalized: remote,
      source,
      ...(source === 'app' ? { app: APP } : {}),
    },
  ],
});

class FakeExec implements Executor {
  calls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
  constructor(private readonly out: (args: string[]) => Partial<ExecResult> = () => ({})) {}
  async run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ cmd, args, env: { ...((opts?.env as Record<string, string>) ?? {}) } });
    return { stdout: '', stderr: '', exitCode: 0, ...this.out(args) } as ExecResult;
  }
}

const baseEnv = (exec: Executor): ForgeEnv => ({
  exec,
  fetch: (async () => new Response('{}')) as unknown as typeof fetch,
  tokens: new MemoryTokenStore(),
});

/** A real broker over a fake provider: 60-minute tokens numbered by mint, a fake clock, optional failure. */
function realBroker(clock: { t: number }, opts: { failFrom?: number; refs?: string[] } = {}) {
  let mints = 0;
  const factory: AppProviderFactory = {
    provider: 'github-app',
    create: () => ({
      provider: 'github-app',
      describe: () => ({}) as never,
      status: async () => ({ suspended: false }),
      verify: async () => ({}) as never,
      mint: async (scope) => {
        mints++;
        if (opts.failFrom && mints >= opts.failFrom)
          throw new AppTokenError('installation_not_found', 'gone');
        expect(scope.repositories).toEqual(['web']);
        return { token: `ghs_token${mints}_${'x'.repeat(30)}`, expiresAt: clock.t + 60 * MIN };
      },
    }),
    installations: async () => [],
  };
  const stored = {
    provider: 'github-app',
    host: 'github.com',
    appRef: '4242',
    appId: '4242',
    installationId: '777',
    privateKey: '',
    identity: {},
    refs: (opts.refs ?? [INTEGRATION]).map((integrationId) => ({ orgId: 'o', integrationId })),
  };
  const broker = new AppTokenBroker({
    store: { get: (i: string) => (i === APP.instance ? stored : undefined) } as never,
    fetch: globalThis.fetch,
    now: () => clock.t,
    providers: { 'github-app': factory },
    unregisterDelayMs: 0,
  });
  return { broker, mints: () => mints };
}

describe('actor scope without an app', () => {
  it('returns the base env and the gh helper exactly as today (no plan, or a project-source entry)', async () => {
    const exec = new FakeExec();
    const base = baseEnv(exec);
    for (const p of [undefined, plan('project')]) {
      const scope = actorScope(base, null, p);
      expect(scope.forgeEnv).toBe(base);
      expect(scope.actorFor('https://github.com/acme/web.git')).toBeNull();
      const a = await scope.auth('https://github.com/acme/web.git');
      expect(a.args).toEqual([
        '-c',
        'credential.https://github.com.helper=',
        '-c',
        'credential.https://github.com.helper=!gh auth git-credential',
      ]);
      expect(a.env).toEqual({});
      await new GitHubForge(scope.forgeEnv).defaultBranch({
        kind: 'github',
        host: 'github.com',
        fullName: 'acme/web',
        url: 'https://github.com/acme/web.git',
      });
    }
    for (const c of exec.calls) {
      expect(c.env.GH_TOKEN).toBeUndefined();
      expect(c.env.GH_ENTERPRISE_TOKEN).toBeUndefined();
    }
  });
});

describe('actor scope with an app', () => {
  const url = 'https://github.com/acme/web.git';
  const repo = { kind: 'github' as const, host: 'github.com', fullName: 'acme/web', url };

  it('git auth uses an env-only token helper with the app marker, never the gh login', async () => {
    const { broker } = realBroker({ t: T0 });
    const scope = actorScope(baseEnv(new FakeExec()), broker, plan());
    const a = await scope.auth(url);
    expect(a.args).toEqual([]);
    expect(a.env.AOM_GIT_USER).toBe('x-access-token');
    expect(a.env.AOM_GIT_TOKEN).toMatch(/^ghs_token1_/);
    expect(a.env.AOM_GIT_APP).toBe(INTEGRATION);
    expect(a.env.GIT_CONFIG_VALUE_0).toBe('');
    expect(JSON.stringify(a)).not.toContain('gh auth git-credential');
    // the token is in no argument (argv shows in process lists and logs)
    expect(a.args.join(' ')).not.toContain('ghs_');
  });

  it('every gh call gets the current token (GH_TOKEN), and a new one after the refresh margin (fake clock)', async () => {
    const clock = { t: T0 };
    const { broker, mints } = realBroker(clock);
    const exec = new FakeExec((args) =>
      args[0] === 'pr' && args[1] === 'create'
        ? { stdout: 'https://github.com/acme/web/pull/7\n' }
        : { stdout: '[]' },
    );
    const scope = actorScope(baseEnv(exec), broker, plan());
    const forge = new GitHubForge(scope.forgeEnv);
    await forge.openChange(repo, { base: 'main', head: 'b', title: 't', body: 'x' });
    const first = (await scope.auth(url)).env.AOM_GIT_TOKEN;
    expect(exec.calls.length).toBe(2);
    for (const c of exec.calls) expect(c.env.GH_TOKEN).toMatch(/^ghs_token1_/);
    expect(mints()).toBe(1);
    // 51 minutes later: fewer than 10 minutes left, so the next push and gh call get a fresh token
    clock.t = T0 + 51 * MIN;
    const second = (await scope.auth(url)).env.AOM_GIT_TOKEN;
    await forge.changeState(repo, '7');
    expect(second).not.toBe(first);
    expect(second).toMatch(/^ghs_token2_/);
    expect(exec.calls.at(-1)?.env.GH_TOKEN).toBe(second);
    // two hours in: still no manual step
    clock.t = T0 + 125 * MIN;
    expect((await scope.auth(url)).env.AOM_GIT_TOKEN).toMatch(/^ghs_token3_/);
  });

  it('GitHub Enterprise gets GH_ENTERPRISE_TOKEN with GH_HOST', async () => {
    const { broker } = realBroker({ t: T0 });
    const exec = new FakeExec(() => ({ stdout: 'main\n' }));
    const scope = actorScope(baseEnv(exec), broker, plan('app', 'ghe.acme.io/acme/web'));
    await new GitHubForge(scope.forgeEnv, 'ghe.acme.io').defaultBranch({ ...repo, host: 'ghe.acme.io' });
    expect(exec.calls[0]?.env.GH_ENTERPRISE_TOKEN).toMatch(/^ghs_/);
    expect(exec.calls[0]?.env.GH_TOKEN).toBeUndefined();
    expect(exec.calls[0]?.env.GH_HOST).toBe('ghe.acme.io');
  });

  it('an uninstalled app fails closed: AppIdentityError naming the app, gh not run, PR creator lets it through', async () => {
    const clock = { t: T0 };
    const { broker } = realBroker(clock, { failFrom: 2 });
    const exec = new FakeExec();
    const scope = actorScope(baseEnv(exec), broker, plan());
    await scope.auth(url); // first mint works
    clock.t = T0 + 55 * MIN; // refresh needed; the installation is gone now
    const err = await scope.auth(url).catch((e) => e);
    expect(err).toBeInstanceOf(AppIdentityError);
    expect(err.message).toContain('Guild Bot');
    expect(err.message).toContain('Nothing was committed or pushed under another identity');
    await expect(new GitHubForge(scope.forgeEnv).changeState(repo, '1')).rejects.toBeInstanceOf(
      AppIdentityError,
    );
    expect(exec.calls).toHaveLength(0);

    const r = makeRepoWithOrigin(url);
    await expect(
      forgePrCreator(scope.forgeEnv).create({ cwd: r, base: 'main', branch: 'b', title: 't', body: 'x' }),
    ).rejects.toBeInstanceOf(AppIdentityError);
  });

  it('a stored copy of another registration is refused (app_mismatch), never used', async () => {
    const { broker, mints } = realBroker({ t: T0 }, { refs: ['0b9f3c0e-1d2a-4c1b-9a51-6f0e2a7d8c99'] });
    const scope = actorScope(baseEnv(new FakeExec()), broker, plan());
    await expect(scope.auth(url)).rejects.toBeInstanceOf(AppIdentityError);
    expect(mints()).toBe(0);
  });

  it('an ssh origin on an app repository fails at the start with the https hint', () => {
    const { broker } = realBroker({ t: T0 });
    const scope = actorScope(baseEnv(new FakeExec()), broker, plan());
    const refusal = appOriginRefusal(scope, 'git@github.com:acme/web.git');
    expect(refusal).toMatch(/^app_identity_failed: /);
    expect(refusal).toContain('https://github.com/acme/web.git');
    expect(appOriginRefusal(scope, url)).toBeNull();
    expect(
      appOriginRefusal(actorScope(baseEnv(new FakeExec()), broker, undefined), 'git@github.com:acme/web.git'),
    ).toBeNull();
  });
});

function makeRepoWithOrigin(origin: string): string {
  const dir = tmp('post-as-cred-');
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['remote', 'add', 'origin', origin]);
  return dir;
}

describe('push tripwire', () => {
  it('refuses a push without the app credential to an app repository under the same root; others are untouched', async () => {
    const root = tmp('post-as-root-');
    const bare = join(root, 'remote.git');
    sh(root, 'git', ['init', '-q', '--bare', bare]);
    const clone = join(root, 'clone');
    sh(root, 'git', ['init', '-q', '-b', 'main', clone]);
    sh(clone, 'git', [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@e',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    ]);
    sh(clone, 'git', ['remote', 'add', 'origin', bare]);
    const { broker } = realBroker({ t: T0 });
    const { normalizeRemoteUrl } = await import('@aom/shared');
    actorScope(
      baseEnv(new FakeExec()),
      broker,
      plan('app', normalizeRemoteUrl(bare)),
      appRepos.forRoot(root),
    );

    const refused = await git(clone, ['push', 'origin', 'main']);
    expect(refused.exitCode).toBe(128);
    expect(refused.stderr).toContain("posts as the app 'Guild Bot'");
    expect(sh(bare, 'git', ['for-each-ref'])).toBe('');

    // with the app marker the push goes through (the credential path is the forge's)
    const ok = await git(clone, ['push', 'origin', 'main'], { env: { AOM_GIT_APP: INTEGRATION } });
    expect(ok.exitCode).toBe(0);

    // another runner root is not affected
    appRepos.clear();
    actorScope(
      baseEnv(new FakeExec()),
      broker,
      plan('app', normalizeRemoteUrl(bare)),
      appRepos.forRoot(tmp('other-root-')),
    );
    expect((await git(clone, ['push', 'origin', 'main'])).exitCode).toBe(0);

    // a later plan with another source removes the entry
    actorScope(
      baseEnv(new FakeExec()),
      broker,
      plan('app', normalizeRemoteUrl(bare)),
      appRepos.forRoot(root),
    );
    actorScope(
      baseEnv(new FakeExec()),
      broker,
      plan('project', normalizeRemoteUrl(bare)),
      appRepos.forRoot(root),
    );
    expect((await git(clone, ['push', 'origin', 'main'])).exitCode).toBe(0);
  });
});

describe('describePushRejection', () => {
  const app = { label: 'Guild Bot', botName: 'guild-bot[bot]' };
  it('GH006 names the branch, the reason and the bypass', () => {
    const out = [
      'remote: error: GH006: Protected branch update failed for refs/heads/main.',
      'remote: error: Changes must be made through a pull request.',
      ' ! [remote rejected] HEAD -> main (protected branch hook declined)',
    ].join('\n');
    const r = describePushRejection(out, app);
    expect(r).toContain('main');
    expect(r).toContain('Changes must be made through a pull request.');
    expect(r).toContain("the app 'Guild Bot' a bypass");
  });
  it('GH013 lists the ruleset rules and the bypass list', () => {
    const out = [
      'remote: error: GH013: Repository rule violations found for refs/heads/main.',
      'remote: Review all repository rules at http://github.com/acme/web/rules?ref=refs%2Fheads%2Fmain',
      'remote: - Changes must be made through a pull request.',
      'remote: - Required status check "ci" is expected.',
    ].join('\n');
    const r = describePushRejection(out, app) ?? '';
    expect(r).toContain('repository ruleset');
    expect(r).toContain('Required status check "ci" is expected.');
    expect(r).toContain('Bypass list');
  });
  it('403 and permission denied name Contents: write', () => {
    const r = describePushRejection(
      'remote: Permission to acme/web.git denied to guild-bot[bot].\nfatal: unable to access: The requested URL returned error: 403',
      app,
    );
    expect(r).toContain('acme/web');
    expect(r).toContain('Contents: Read and write');
  });
  it('workflow files name the Workflows permission', () => {
    const r = describePushRejection(
      '! [remote rejected] main (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)',
      app,
    );
    expect(r).toContain('.github/workflows/ci.yml');
    expect(r).toContain('Workflows: Read and write');
  });
  it('gh "Resource not accessible by integration" names the permissions', () => {
    expect(
      describePushRejection('GraphQL: Resource not accessible by integration (createPullRequest)', app),
    ).toContain('Pull requests: Read and write');
  });
  it('nothing without an app or for an unknown output', () => {
    expect(
      describePushRejection('GH006: Protected branch update failed for refs/heads/main.', null),
    ).toBeNull();
    expect(describePushRejection('fatal: something else', app)).toBeNull();
  });
});

describe('agents stay credential-free', () => {
  it('the sandbox env has no forge token or credential helper', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'sandbox', 'sandbox.ts'), 'utf8');
    expect(src).not.toMatch(/AOM_GIT_TOKEN|GH_ENTERPRISE_TOKEN|credential\.helper/);
  });
});
