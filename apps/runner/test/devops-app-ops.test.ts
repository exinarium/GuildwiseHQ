import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HygieneRepoSpec, PostAsPlan } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  APP_PUSH_REFUSED_URL,
  devopsPushPlan,
  devopsRequestIdentity,
  withAppPushRefusal,
} from '../src/devops/devops-git.ts';
import { classifyCommand, type GuardConfig } from '../src/devops/guard.ts';
import { type HygieneNetAuth, hygieneRepo } from '../src/devops/hygiene.ts';
import { migrateSavedWorkBranches } from '../src/devops/saved-work.ts';
import { commandCarriesPlan } from '../src/forge/app-actor.ts';
import { git } from '../src/git/git.ts';
import { AppIdentityError, commitEnv } from '../src/git/identity.ts';
import { cleanupTmp, makeRepo, sh, type TestRepo, tmp } from './helpers.ts';

cleanupTmp();

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
const BOT = { name: APP.botName, email: APP.botEmail };
const APP_TOKEN_MARK = 'app-token-used';
const REMOTE = 'github.com/acme/web';
const U = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';

const OWNER: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Owner',
  GIT_AUTHOR_EMAIL: 'owner@example.test',
  GIT_COMMITTER_NAME: 'Owner',
  GIT_COMMITTER_EMAIL: 'owner@example.test',
  GIT_CONFIG_NOSYSTEM: '1',
};
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(OWNER)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const plan = (source: 'app' | 'project' = 'app', remote = REMOTE): PostAsPlan => ({
  repos: [
    {
      repoId: '0b9f3c0e-1d2a-4c1b-9a51-6f0e2a7d8c12',
      remoteUrlNormalized: remote,
      source,
      projectKey: 'GWP',
      ...(source === 'app' ? { app: APP } : {}),
    },
  ],
});

const spec = (repo: TestRepo): HygieneRepoSpec => ({
  repoId: U,
  projectId: U,
  projectKey: 'GWP',
  projectName: 'Guild',
  name: 'web',
  localPath: repo.clone,
  remoteUrl: repo.origin,
  workingBranch: 'main',
  branchSource: 'repo',
  branchPrefix: 'aom/',
  finishedBranches: [],
  mainBranch: null,
  finishedCards: [],
});

/**
 * The origin records, per receive, the token marker of the pushing process (a local push runs receive-pack with the
 * pusher's environment): the evidence that a push went out with the app's credentials and not the owner's.
 */
function recordPushes(repo: TestRepo): () => string[] {
  const log = join(repo.root, 'pushes.log');
  const hook = join(repo.origin, 'hooks', 'pre-receive');
  writeFileSync(hook, `#!/bin/sh\necho "\${APP_TOKEN_MARK:-owner}" >> '${log}'\ncat >/dev/null\n`);
  chmodSync(hook, 0o755);
  return () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
}

const appNet: HygieneNetAuth = {
  args: [],
  env: { APP_TOKEN_MARK, AOM_GIT_APP: INTEGRATION },
  identity: BOT,
};

/** Somebody else pushes a commit to main. */
function remoteCommit(repo: TestRepo, file: string) {
  const other = join(tmp(), 'other');
  sh(repo.root, 'git', ['clone', repo.origin, other]);
  sh(other, 'git', ['checkout', 'main']);
  writeFileSync(join(other, file), 'theirs');
  sh(other, 'git', ['add', '-A']);
  sh(other, 'git', ['commit', '-m', `remote ${file}`]);
  sh(other, 'git', ['push', 'origin', 'main']);
}

const tipIdentity = (repo: TestRepo) =>
  sh(repo.origin, 'git', ['log', '-1', '--format=%an|%ae|%cn|%ce', 'main']).trim();

describe('DevOps hygiene on an app repository (AC2)', () => {
  it('fetches, rebases and pushes with the app auth; the pushed commit is authored and committed by the app', async () => {
    const repo = makeRepo();
    remoteCommit(repo, 'theirs.txt');
    const pushes = recordPushes(repo);
    // A local commit made as the app (a card request or the runner), not yet on origin.
    writeFileSync(join(repo.clone, 'mine.txt'), 'mine');
    sh(repo.clone, 'git', ['add', '-A']);
    await git(repo.clone, ['commit', '-m', 'mine'], { env: commitEnv(BOT) });
    const appAuth = vi.fn(async () => appNet);

    const { result, commands } = await hygieneRepo(spec(repo), [], { appAuth });

    expect(result.problem).toBeNull();
    expect(result.pushed).toBe(true);
    expect(appAuth).toHaveBeenCalledWith(repo.origin);
    expect(pushes()).toEqual([APP_TOKEN_MARK]);
    expect(tipIdentity(repo)).toBe(`${BOT.name}|${BOT.email}|${BOT.name}|${BOT.email}`);
    // The audit trail never holds the token environment.
    expect(commands.join('\n')).not.toContain(APP_TOKEN_MARK);
  });

  it('an app that cannot be used fails closed: named problem, nothing fetched or pushed, no owner credentials', async () => {
    const repo = makeRepo();
    const pushes = recordPushes(repo);
    writeFileSync(join(repo.clone, 'mine.txt'), 'mine');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'mine']);
    const before = sh(repo.origin, 'git', ['rev-parse', 'main']);
    const appAuth = vi.fn(async (): Promise<HygieneNetAuth | null> => {
      throw new AppIdentityError(APP, 'The app is not installed on this repository.');
    });

    const { result, commands } = await hygieneRepo(spec(repo), [], { appAuth });

    expect(result.problem?.kind).toBe('app_identity_failed');
    expect(result.problem?.detail).toMatch(
      /^The app Guild Bot could not be used: .+\(project GWP, hygiene\) Nothing was committed or pushed/,
    );
    expect(result.pushed).toBe(false);
    expect(commands.some((c) => / (fetch|pull|push) /.test(c))).toBe(false);
    expect(pushes()).toEqual([]);
    expect(sh(repo.origin, 'git', ['rev-parse', 'main'])).toBe(before);
  });

  it('a repository not on an app runs exactly the same git as without app support (AC6 regression)', async () => {
    const run = async (withDeps: boolean) => {
      const repo = makeRepo();
      remoteCommit(repo, 'theirs.txt');
      const pushes = recordPushes(repo);
      writeFileSync(join(repo.clone, 'mine.txt'), 'mine');
      sh(repo.clone, 'git', ['add', '-A']);
      sh(repo.clone, 'git', ['commit', '-m', 'mine']);
      const r = await hygieneRepo(spec(repo), [], withDeps ? { appAuth: async () => null } : {});
      return {
        // gate-fixes-2 Rules A and B: hygiene rebases onto origin's sha and sends the tip by sha (new commits per run)
        commands: r.commands.map((c) => c.replace(repo.clone, '<clone>').replace(/[0-9a-f]{40}/g, '<sha>')),
        pushes: pushes(),
        identity: tipIdentity(repo),
      };
    };
    const without = await run(false);
    const withNull = await run(true);
    expect(withNull).toEqual(without);
    expect(withNull.pushes).toEqual(['owner']);
    // The rebase commits as the workstation's own identity, never the app.
    expect(withNull.identity).toMatch(/\|Owner\|owner@example\.test$/);
    expect(withNull.identity).not.toContain(BOT.email);
  });
});

describe('remote branch deletes of hygiene use the app auth (AC4)', () => {
  it('old saved-work branches on origin are deleted with the app auth', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['push', 'origin', 'main:guildwise/saved-work/2026-01-01']);
    sh(repo.clone, 'git', ['fetch', 'origin']);
    const pushes = recordPushes(repo);

    const r = await migrateSavedWorkBranches(repo.clone, { remote: true, auth: appNet });

    expect(r.errors).toEqual([]);
    expect(pushes()).toEqual([APP_TOKEN_MARK]);
    expect(sh(repo.origin, 'git', ['branch', '--list', 'guildwise/*']).trim()).toBe('');
  });

  it('without app auth the delete runs as before', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['push', 'origin', 'main:guildwise/saved-work/2026-01-01']);
    sh(repo.clone, 'git', ['fetch', 'origin']);
    const pushes = recordPushes(repo);
    await migrateSavedWorkBranches(repo.clone, { remote: true });
    expect(pushes()).toEqual(['owner']);
  });
});

describe('DevOps card request on an app repository: conflict resolution as the app (AC3)', () => {
  const probe = (fail = false) => ({
    ensure: vi.fn(async () => {
      if (fail) throw Object.assign(new Error('x'), { code: 'installation_not_found' });
    }),
  });

  it('the request runs with the bot identity; the resolved commit and its push are the app', async () => {
    const id = await devopsRequestIdentity(plan('app'), REMOTE, tmp(), probe());
    expect(id).toMatchObject({ name: BOT.name, email: BOT.email, source: 'app' });
    const ident = id as { name: string; email: string };

    // A conflict between the card branch and origin/main, resolved in the engineer's environment (bot identity).
    const repo = makeRepo();
    const pushes = recordPushes(repo);
    sh(repo.clone, 'git', ['checkout', '-b', 'feature/gwp-1']);
    writeFileSync(join(repo.clone, 'README.md'), '# card\n');
    sh(repo.clone, 'git', ['commit', '-am', 'card']);
    sh(repo.clone, 'git', ['checkout', 'main']);
    writeFileSync(join(repo.clone, 'README.md'), '# main\n');
    sh(repo.clone, 'git', ['commit', '-am', 'main']);
    sh(repo.clone, 'git', ['checkout', 'feature/gwp-1']);
    const env = commitEnv(ident);
    const merge = await git(repo.clone, ['merge', 'main'], { env });
    expect(merge.exitCode).not.toBe(0);
    writeFileSync(join(repo.clone, 'README.md'), '# resolved\n');
    sh(repo.clone, 'git', ['add', 'README.md']);
    expect((await git(repo.clone, ['commit', '--no-edit'], { env })).exitCode).toBe(0);

    // `aom git push --repo`: the runner pushes with the app auth.
    // gate-fixes-2 B4: not a card branch (those go out only through the card's finalize)
    const p = devopsPushPlan('push', ['feature/gwp-1'], false, false);
    if ('error' in p) throw new Error(p.error);
    const pushed = await git(repo.clone, [...appNet.args, ...p.args], { env: appNet.env });
    expect(pushed.exitCode).toBe(0);
    expect(pushes()).toEqual([APP_TOKEN_MARK]);
    expect(sh(repo.origin, 'git', ['log', '-1', '--format=%an|%ae|%cn|%ce', 'feature/gwp-1']).trim()).toBe(
      `${BOT.name}|${BOT.email}|${BOT.name}|${BOT.email}`,
    );
  });

  it('an app that cannot mint refuses the request, naming project, app and operation', async () => {
    const id = await devopsRequestIdentity(plan('app'), REMOTE, tmp(), probe(true));
    expect(id).toMatch(
      /^app_identity_failed: The app Guild Bot could not be used: .+\(project GWP, DevOps request on acme\/web\)/,
    );
  });

  it("a card repository not on an app keeps today's identity (null), and so does a request without a card", async () => {
    const p = probe();
    expect(await devopsRequestIdentity(plan('project'), REMOTE, tmp(), p)).toBeNull();
    expect(await devopsRequestIdentity({ repos: [] }, REMOTE, tmp(), p)).toBeNull();
    expect(await devopsRequestIdentity(plan('app'), undefined, tmp(), p)).toBeNull();
    expect(p.ensure).not.toHaveBeenCalled();
  });
});

describe('aom git push|fetch --repo (runner side plan)', () => {
  it('builds plain push, tag push and delete argv and names the operation', () => {
    expect(devopsPushPlan('push', ['feature'], false, false)).toEqual({
      args: ['push', 'origin', '--', 'feature'],
      operation: 'push',
    });
    expect(devopsPushPlan('push', ['refs/tags/v1.2.0'], false, false)).toMatchObject({
      operation: 'push tag',
    });
    // gate-fixes-2 B4: never all tags at once
    expect(devopsPushPlan('push', [], false, true)).toHaveProperty('error');
    expect(devopsPushPlan('push', ['aom/gwp-1'], true, false)).toEqual({
      args: ['push', '--delete', 'origin', '--', 'aom/gwp-1'],
      operation: 'delete branch',
    });
    expect(devopsPushPlan('fetch', [], false, false)).toEqual({
      args: ['fetch', '--prune', 'origin'],
      operation: 'fetch',
    });
  });

  it('refuses force, options and deleting a main branch', () => {
    expect(devopsPushPlan('push', ['+main'], false, false)).toHaveProperty('error');
    expect(devopsPushPlan('push', ['--force'], false, false)).toHaveProperty('error');
    expect(devopsPushPlan('push', ['main'], true, false)).toHaveProperty('error');
    expect(devopsPushPlan('push', [':main'], false, false)).toHaveProperty('error');
    // a delete names plain branches only, and never a protected one (the guard's set plus the shift's own)
    expect(devopsPushPlan('push', ['main:refs/heads/main'], true, false)).toHaveProperty('error');
    expect(devopsPushPlan('push', ['refs/heads/master'], true, false)).toHaveProperty('error');
    expect(devopsPushPlan('push', ['HEAD'], true, false)).toHaveProperty('error');
    expect(devopsPushPlan('push', ['development'], true, false, ['development'])).toHaveProperty('error');
    expect(devopsPushPlan('push', ['development'], true, false)).not.toHaveProperty('error');
    expect(devopsPushPlan('push', [], false, false)).toHaveProperty('error');
    expect(devopsPushPlan('fetch', ['main'], false, false)).toHaveProperty('error');
  });
});

describe('push backstop in the DevOps environment', () => {
  it('sends raw pushes to app repositories nowhere, keeping existing config entries', () => {
    const env = withAppPushRefusal(
      { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.x', GIT_CONFIG_VALUE_0: 'y' },
      plan('app'),
    );
    expect(env.GIT_CONFIG_KEY_0).toBe('core.x');
    const values = Object.entries(env)
      .filter(([k]) => k.startsWith('GIT_CONFIG_VALUE_') && k !== 'GIT_CONFIG_VALUE_0')
      .map(([, v]) => v);
    expect(values).toEqual(
      expect.arrayContaining([
        'https://github.com/acme/web',
        'https://github.com/acme/web.git',
        'git@github.com:acme/web.git',
      ]),
    );
    expect(env.GIT_CONFIG_KEY_1).toBe(`url.${APP_PUSH_REFUSED_URL}.pushInsteadOf`);
    expect(Number(env.GIT_CONFIG_COUNT)).toBe(1 + values.length);
  });

  it('changes nothing without app repositories (no-app projects)', () => {
    const base = { A: '1' };
    expect(withAppPushRefusal(base, plan('project'))).toBe(base);
    expect(withAppPushRefusal(base, { repos: [] })).toBe(base);
    expect(withAppPushRefusal(base, null)).toBe(base);
  });

  it('a raw push in a shell with the backstop never reaches origin', async () => {
    const repo = makeRepo();
    const pushes = recordPushes(repo);
    const env = withAppPushRefusal({}, plan('app', repo.remoteNormalized));
    const p = await git(repo.clone, ['push', 'origin', 'main:other'], { env, timeoutMs: 20_000 });
    // A local-path origin is not rewritten by an https/ssh form: this checks the env is valid git config.
    expect(p.exitCode).toBe(0);
    expect(pushes()).toEqual(['owner']);
  });
});

describe('DevOps guard app_repo rule (AC4/AC6)', () => {
  const cfg = (over: Partial<GuardConfig> = {}): GuardConfig => ({
    sessionRef: 's1',
    kind: 'shift',
    deleteRoots: [],
    home: '/home/u',
    protectedBranches: [],
    approvedCommands: [],
    appRepos: [{ remote: REMOTE, label: APP.label, botEmail: APP.botEmail }],
    ...over,
  });
  const deps = { originUrl: (dir: string) => (dir.startsWith('/w/web') ? REMOTE : 'github.com/acme/other') };
  const judge = (cmd: string, c = cfg(), cwd = '/w/web') => classifyCommand(cmd, c, cwd, deps);

  it.each([
    'git push origin main',
    'git push --delete origin aom/gwp-1',
    'git push origin v1.2.0',
    'git fetch origin',
    'git pull --rebase origin main',
    'git ls-remote origin',
    'git -C /w/web push origin main',
    'git push https://github.com/acme/web.git main',
    'git clone https://github.com/acme/web.git /tmp/x',
  ])('refuses raw network git to an app repository: %s', (cmd) => {
    const v = judge(cmd, cfg(), cmd.includes('-C') ? '/elsewhere' : '/w/web');
    expect(v.decision).toBe('refused');
    expect(v.rule).toBe('app_repo');
    expect(v.reason).toContain("posts as the app 'Guild Bot'");
  });

  it('names the aom command to use instead', () => {
    expect(judge('git push origin main').reason).toContain('aom git push --repo /w/web');
    expect(judge('git fetch origin').reason).toContain('aom git fetch --repo /w/web');
  });

  it.each([
    'gh pr create --fill',
    'gh pr merge 12 --squash',
    'gh pr comment 12 --body hi',
    'gh issue comment 3 --body hi',
    'gh release create v1.2.0',
    'gh api -X POST repos/acme/web/statuses/abc',
    'gh pr create -R acme/web --fill',
  ])('refuses gh writes to an app repository: %s', (cmd) => {
    const v = judge(cmd, cfg(), cmd.includes('-R') ? '/elsewhere' : '/w/web');
    expect(v.rule).toBe('app_repo');
  });

  it('refuses commits not made as the bot, allows them with the bot identity', () => {
    expect(judge('git commit -m x').rule).toBe('app_repo');
    expect(judge('git merge main').rule).toBe('app_repo');
    expect(judge('git commit -m x', cfg({ identityEmail: APP.botEmail })).decision).toBe('allowed');
    expect(judge('git rebase main', cfg({ identityEmail: APP.botEmail })).decision).toBe('allowed');
  });

  it('leaves reads and other repositories alone', () => {
    expect(judge('git status').decision).toBe('allowed');
    expect(judge('gh pr view 12').decision).toBe('allowed');
    expect(judge('git push origin main', cfg(), '/w/other').decision).toBe('allowed');
    expect(judge('gh pr create -R acme/other --fill').decision).not.toBe('refused');
  });

  it('without app repositories (no-app projects) nothing new is refused', () => {
    const none = cfg({ appRepos: undefined });
    for (const cmd of ['git push origin main', 'git fetch origin', 'git commit -m x', 'gh pr create --fill'])
      expect(judge(cmd, none).rule).not.toBe('app_repo');
  });
});

describe('every runner command that writes to a repository or its forge carries the plan (AC7)', () => {
  it.each([
    'finalize.execute',
    'repo.create',
    'branch.check_merged',
    'repo.open_pr',
    'repo.commit_status',
    'pr_review.post',
    'pr_review.notice',
    'release.ship',
    'release.docs_prep',
    'release.publish',
    'repo.bump_submodule',
  ])('%s has a postAs field', (command) => {
    expect(commandCarriesPlan(command)).toBe(true);
  });
});
