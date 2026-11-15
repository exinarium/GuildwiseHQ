import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PostAsPlan } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { AppTokenError } from '../src/apps/types.ts';
import { actorScope, missingPlanRefusal, releaseUncoveredRepos } from '../src/forge/app-actor.ts';
import { APP_REPOS_FILE, AppRepoRegistry, appRepos } from '../src/forge/app-repos.ts';
import { postCommitStatus } from '../src/forge/commit-status.ts';
import { MemoryTokenStore } from '../src/forge/index.ts';
import { MemoryStatusTokenStore } from '../src/forge/status-tokens.ts';
import type { ForgeEnv } from '../src/forge/types.ts';
import { AppIdentityError, inContext } from '../src/git/identity.ts';
import { postPrNotice } from '../src/review/notice.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();
afterEach(() => appRepos.clear());

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
const APP_TOKEN = `ghs_app_${'x'.repeat(30)}`;
const STATUS_TOKEN = 'github_pat_FAKE_status_0123456789';
const SHA = 'a'.repeat(40);
const REMOTE = 'github.com/acme/web';

const plan = (source: 'app' | 'project' = 'app', remote = REMOTE): PostAsPlan => ({
  repos: [
    {
      repoId: '0b9f3c0e-1d2a-4c1b-9a51-6f0e2a7d8c12',
      remoteUrlNormalized: remote,
      source,
      ...(source === 'app' ? { app: APP } : {}),
    },
  ],
});

/** A fake broker: mints `APP_TOKEN`, or throws the given app error; counts the mints. */
function broker(fail?: AppTokenError) {
  let mints = 0;
  return {
    mints: () => mints,
    b: {
      store: {
        get: (i: string) => (i === APP.instance ? { refs: [{ integrationId: INTEGRATION }] } : undefined),
      },
      getAccessToken: async () => {
        mints++;
        if (fail) throw fail;
        return { token: APP_TOKEN };
      },
      withToken: async () => {
        throw new Error('not used');
      },
    } as never,
  };
}

interface Call {
  url: string;
  auth: string;
}
function github(status = 201) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: String((init.headers as Record<string, string>).Authorization) });
    return new Response('{"id":1}', { status });
  }) as unknown as typeof fetch;
  return { calls, f };
}

/** A base env whose status token store records every read (the owner's credential for statuses). */
function baseEnv(f: typeof fetch) {
  const statusTokens = new MemoryStatusTokenStore();
  statusTokens.set('github', 'github.com', STATUS_TOKEN);
  let statusReads = 0;
  const counted = {
    ...statusTokens,
    get: (p: 'github', h: string) => {
      statusReads++;
      return statusTokens.get(p, h);
    },
    set: statusTokens.set.bind(statusTokens),
    remove: statusTokens.remove.bind(statusTokens),
    list: statusTokens.list.bind(statusTokens),
  };
  const env: ForgeEnv = {
    exec: {
      run: async () => ({ exitCode: 1, stdout: '', stderr: 'the gh login must not be used' }),
    } as never,
    fetch: f,
    tokens: new MemoryTokenStore(),
    statusTokens: counted as never,
  };
  return { env, statusReads: () => statusReads };
}

const statusPayload = (postAs?: PostAsPlan) =>
  ({
    statusId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
    repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d4',
    remoteUrlNormalized: REMOTE,
    sha: SHA,
    state: 'failure',
    context: 'size-budget',
    description: 'Over budget',
    ...(postAs ? { postAs } : {}),
  }) as never;

describe('app failure text names the project, the operation and the repository', () => {
  it('keeps the prefix the server parses and adds the context', () => {
    const e = new AppIdentityError(APP, 'The app is not installed there any more.');
    expect(e.message).toBe(
      'The app Guild Bot could not be used: The app is not installed there any more. Nothing was committed or pushed under another identity.',
    );
    const c = inContext(e, { projectKey: 'GWP', operation: 'push', repo: 'acme/web' });
    expect(c).toBeInstanceOf(AppIdentityError);
    expect(c.message).toBe(
      'The app Guild Bot could not be used: The app is not installed there any more. (project GWP, push on acme/web) Nothing was committed or pushed under another identity.',
    );
    // values already set win over a wider context
    expect(inContext(c, { projectKey: 'OTHER', operation: 'fetch' }).message).toContain(
      '(project GWP, push on acme/web)',
    );
  });
});

describe('push tripwire registry survives a restart', () => {
  it('a persisted root writes its entries (no credential, 0600) and a new process loads them', () => {
    const root = tmp('app-repos-root-');
    const reg = new AppRepoRegistry();
    reg.persist(root);
    reg.forRoot(root).set(REMOTE, { integrationId: INTEGRATION, label: 'Guild Bot' });
    const file = join(root, APP_REPOS_FILE);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(REMOTE);
    expect(text).not.toMatch(/ghs_|token/i);

    const restarted = new AppRepoRegistry();
    expect(restarted.find(join(root, 'clone'), REMOTE)).toBeNull();
    restarted.persist(root);
    expect(restarted.find(join(root, 'clone'), REMOTE)?.label).toBe('Guild Bot');
    // the restarted runner still refuses a command without a plan for it
    expect(missingPlanRefusal(restarted.forRoot(root), 'branch.check_merged', [REMOTE])).toMatch(
      /^app_identity_failed: The app Guild Bot could not be used: .+\(branch\.check_merged on acme\/web\)/,
    );

    // the empty plan releases it, on disk too
    releaseUncoveredRepos(restarted.forRoot(root), { repos: [] }, [REMOTE]);
    const again = new AppRepoRegistry();
    again.persist(root);
    expect(again.find(root, REMOTE)).toBeNull();
  });

  it('a root that is not persisted writes nothing; a damaged file loads nothing', () => {
    const root = tmp('app-repos-root-');
    const reg = new AppRepoRegistry();
    reg.forRoot(root).set(REMOTE, { integrationId: INTEGRATION, label: 'Guild Bot' });
    expect(existsSync(join(root, APP_REPOS_FILE))).toBe(false);

    const bad = tmp('app-repos-bad-');
    writeFileSync(join(bad, APP_REPOS_FILE), '{not json');
    const r2 = new AppRepoRegistry();
    r2.persist(bad);
    expect(r2.find(bad, REMOTE)).toBeNull();
  });

  it('an app deselected: the empty plan the server now sends releases the repository, so later commands run as before', () => {
    const root = tmp('app-repos-deselect-');
    const reg = new AppRepoRegistry();
    reg.persist(root);
    // a shift or command while the app was selected registered the repository
    reg.forRoot(root).set(REMOTE, { integrationId: INTEGRATION, label: 'Guild Bot' });
    expect(missingPlanRefusal(reg.forRoot(root), 'repo.bump_submodule', [REMOTE])).not.toBeNull();
    // after the owner deselects the app, the next command (a submodule pin, a docs prep step) carries the empty plan
    releaseUncoveredRepos(reg.forRoot(root), { repos: [] }, [REMOTE]);
    expect(missingPlanRefusal(reg.forRoot(root), 'repo.bump_submodule', [REMOTE])).toBeNull();
    expect(missingPlanRefusal(reg.forRoot(root), 'release.docs_prep', [REMOTE])).toBeNull();
    // a project source entry (no app) releases it as well
    reg.forRoot(root).set(REMOTE, { integrationId: INTEGRATION, label: 'Guild Bot' });
    releaseUncoveredRepos(reg.forRoot(root), plan('project'), [REMOTE]);
    expect(missingPlanRefusal(reg.forRoot(root), 'release.docs_prep', [REMOTE])).toBeNull();
  });

  it('nothing registered: a missing plan is not refused (a project without an app)', () => {
    expect(missingPlanRefusal(appRepos.forRoot(tmp('r-')), 'repo.open_pr', [REMOTE])).toBeNull();
  });
});

describe('repo.commit_status as the app', () => {
  it('with an app selected the status is posted with the app token, never the status token', async () => {
    const g = github();
    const { env, statusReads } = baseEnv(g.f);
    const { b, mints } = broker();
    const scope = actorScope(env, b, plan('app'));
    const r = await postCommitStatus({
      payload: statusPayload(plan('app')),
      remoteUrl: 'https://github.com/acme/web.git',
      forgeEnv: scope.forgeEnv,
    });
    expect(r).toEqual({ ok: true });
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]?.url).toBe(`https://api.github.com/repos/acme/web/statuses/${SHA}`);
    expect(g.calls[0]?.auth).toBe(`Bearer ${APP_TOKEN}`);
    expect(statusReads()).toBe(0);
    expect(mints()).toBe(1);
  });

  it('a mint failure fails closed: names the app, the operation and the repository; nothing is posted', async () => {
    const g = github();
    const { env, statusReads } = baseEnv(g.f);
    const { b } = broker(new AppTokenError('installation_not_found', 'gone'));
    const scope = actorScope(env, b, plan('app'));
    const r = await postCommitStatus({
      payload: statusPayload(plan('app')),
      remoteUrl: 'https://github.com/acme/web.git',
      forgeEnv: scope.forgeEnv,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('app_identity_failed');
    expect(r.error).toMatch(
      /^app_identity_failed: The app Guild Bot could not be used: The app is not installed there any more\. \(commit status on acme\/web\)/,
    );
    expect(r.error).not.toContain(STATUS_TOKEN);
    expect(g.calls).toHaveLength(0);
    expect(statusReads()).toBe(0);
  });

  it('with no app selected (absent or empty plan, or a project source) the status token is used as before', async () => {
    for (const p of [undefined, { repos: [] }, plan('project')] as Array<PostAsPlan | undefined>) {
      const g = github();
      const { env, statusReads } = baseEnv(g.f);
      const { b, mints } = broker();
      const r = await postCommitStatus({
        payload: statusPayload(p),
        remoteUrl: 'https://github.com/acme/web.git',
        forgeEnv: actorScope(env, b, p).forgeEnv,
      });
      expect(r).toEqual({ ok: true });
      expect(g.calls[0]?.auth).toBe(`Bearer ${STATUS_TOKEN}`);
      expect(statusReads()).toBe(1);
      expect(mints()).toBe(0);
    }
  });
});

describe('pr_review.notice as the app', () => {
  const notice = {
    noticeId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a2',
    projectRepoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d4',
    remoteUrlNormalized: REMOTE,
    prNumber: 7,
    body: 'please split',
  };

  it('a poster failing with the app error answers app_identity_failed, not no_token', async () => {
    const { ReviewPostError } = await import('../src/review/review-poster.ts');
    const err = new AppIdentityError(APP, 'The app is not installed there any more.', {
      operation: 'PR comment',
      repo: 'acme/web',
    });
    const r = await postPrNotice(
      {
        poster: {
          findByMarker: async () => {
            throw new ReviewPostError('reviewer_token_missing', `app_identity_failed: ${err.message}`);
          },
          post: async () => {
            throw new Error('must not post');
          },
        } as never,
      },
      notice as never,
    );
    expect(r).toMatchObject({ ok: false, code: 'app_identity_failed' });
    if (r.ok) return;
    expect(r.error).toContain('(PR comment on acme/web)');
  });

  it('PrReviewCommands.notice posts with the app token from the plan; a failing app never uses the reviewer token', async () => {
    const { PrReviewCommands } = await import('../src/review/pr-review-commands.ts');
    const seen: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push(
        `${init.method ?? 'GET'} ${url} ${String((init.headers as Record<string, string>).Authorization)}`,
      );
      if ((init.method ?? 'GET') === 'GET') return new Response('[]', { status: 200 });
      return new Response('{"html_url":"https://github.com/acme/web/pull/7#r1"}', { status: 200 });
    }) as unknown as typeof fetch;
    const reviewerTokens = {
      get: () => {
        seen.push('reviewer token read');
        return { token: 'github_pat_REVIEWER' };
      },
    };
    const make = (b: never) =>
      new PrReviewCommands({
        fetch: f,
        tokens: reviewerTokens,
        scope: (p: PostAsPlan | null | undefined) => actorScope(baseEnv(f).env, b, p),
      } as never);

    const ok = await make(broker().b).notice({ ...notice, postAs: plan('app') } as never);
    expect(ok.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.endsWith(`Bearer ${APP_TOKEN}`))).toBe(true);

    seen.length = 0;
    const failed = await make(broker(new AppTokenError('installation_not_found', 'gone')).b).notice({
      ...notice,
      noticeId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a3',
      postAs: plan('app'),
    } as never);
    expect(failed).toMatchObject({ ok: false, code: 'app_identity_failed' });
    if (failed.ok) return;
    expect(failed.error).toContain('(PR comment on acme/web)');
    expect(seen).toEqual([]);
  });
});
