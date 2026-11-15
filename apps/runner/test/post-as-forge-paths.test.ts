import { join } from 'node:path';
import { CommandPayloadSchemas, normalizeRemoteUrl, type PostAsPlan } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { appRepos } from '../src/forge/app-repos.ts';
import type { AppActor } from '../src/forge/types.ts';
import { appOfPlan, withPushReport } from '../src/git/gh.ts';
import { checkBranchMerged } from '../src/git/merged.ts';
import { rebaseOntoBase } from '../src/git/rebase.ts';
import { AppIdentityError } from '../src/git/identity.ts';
import { postPrReview } from '../src/review/post.ts';
import { GitHubReviewPoster } from '../src/review/review-poster.ts';
import type { ReviewerTokenStore } from '../src/review/reviewer-tokens.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';

cleanupTmp();
afterEach(() => appRepos.clear());

const APP = {
  integrationId: '0b9f3c0e-1d2a-4c1b-9a51-6f0e2a7d8c11',
  provider: 'github-app' as const,
  label: 'Guild Bot',
  botName: 'guild-bot[bot]',
  botEmail: '99+guild-bot[bot]@users.noreply.github.com',
  instance: '4242:777',
  host: 'github.com',
};
const REPO_ID = '0b9f3c0e-1d2a-4c1b-9a51-6f0e2a7d8c12';
const UUID = '0b9f3c0e-1d2a-4c1b-9a51-6f0e2a7d8c13';
const plan = (remote = 'github.com/acme/web'): PostAsPlan => ({
  repos: [{ repoId: REPO_ID, remoteUrlNormalized: remote, source: 'app', app: APP }],
});

const commit = (cwd: string, msg: string) =>
  sh(cwd, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', msg]);

/** A bare remote with `main` and a merged card branch, and a clone of it. */
function repoWithMergedBranch() {
  const root = tmp('post-as-paths-');
  const bare = join(root, 'remote.git');
  sh(root, 'git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const clone = join(root, 'clone');
  sh(root, 'git', ['init', '-q', '-b', 'main', clone]);
  commit(clone, 'base');
  sh(clone, 'git', ['remote', 'add', 'origin', bare]);
  sh(clone, 'git', ['push', '-q', 'origin', 'main', 'main:refs/heads/card/x']);
  sh(clone, 'git', ['fetch', '-q', 'origin']);
  return { root, bare, clone };
}

describe('forge payloads carry the post-as plan', () => {
  const p = plan();
  const cases: Array<[keyof typeof CommandPayloadSchemas, Record<string, unknown>]> = [
    [
      'repo.open_pr',
      {
        requestId: UUID,
        projectId: UUID,
        repoId: REPO_ID,
        remoteUrlNormalized: 'x',
        head: 'w',
        title: 't',
        body: 'b',
      },
    ],
    [
      'repo.release_facts',
      { requestId: UUID, projectId: UUID, repoId: REPO_ID, remoteUrlNormalized: 'x', head: 'w' },
    ],
    ['repo.list_prs', { requestId: UUID, repoId: REPO_ID, remoteUrlNormalized: 'x' }],
    [
      'repo.list_merged_prs',
      { requestId: UUID, replayId: UUID, repoId: REPO_ID, remoteUrlNormalized: 'x', limit: 5 },
    ],
    ['repo.access', { repoId: REPO_ID, remoteUrl: 'https://github.com/acme/web.git' }],
    ['repo.sync', { repoId: REPO_ID, remoteUrlNormalized: 'x', workingBranch: 'w' }],
    [
      'branch.check_merged',
      {
        cardId: UUID,
        ref: 'GWP-1',
        repoId: REPO_ID,
        remoteUrlNormalized: 'x',
        branchName: 'b',
        workingBranch: 'w',
        action: 'pr',
      },
    ],
    [
      'repo.clone',
      {
        requestId: UUID,
        repoId: REPO_ID,
        projectId: UUID,
        projectKey: 'GWP',
        projectName: 'n',
        name: 'web',
        remoteUrl: 'https://github.com/acme/web.git',
      },
    ],
  ];
  it.each(cases)('%s keeps postAs when given and parses without it as before', (cmd, body) => {
    const schema = CommandPayloadSchemas[cmd];
    expect((schema.parse({ ...body, postAs: p }) as { postAs?: PostAsPlan }).postAs).toEqual(p);
    expect('postAs' in (schema.parse(body) as object)).toBe(false);
  });

  it('pr_review.post (strict) accepts postAs', () => {
    const body = {
      runId: UUID,
      spec: {
        runId: UUID,
        projectId: UUID,
        projectRepoId: REPO_ID,
        remoteUrlNormalized: 'github.com/acme/web',
        prNumber: 3,
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        baseRef: 'main',
      },
      summary: 's',
      findings: [],
    };
    const parsed = CommandPayloadSchemas['pr_review.post'].safeParse({ ...body, postAs: p });
    expect(parsed.success).toBe(true);
  });
});

describe('PR review poster as the app', () => {
  const spec = { remoteUrlNormalized: 'github.com/acme/web', prNumber: 3, headSha: 'a'.repeat(40) };
  const tokens = {
    get: () => ({ token: 'reviewer-token' }),
    has: () => true,
  } as unknown as ReviewerTokenStore;
  const recorder = () => {
    const auth: string[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      auth.push(String(headers.Authorization));
      if (init?.method === 'GET') return new Response('[]', { status: 200 });
      return new Response(JSON.stringify({ id: 1, html_url: 'https://github.com/acme/web/pull/3#r1' }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    return { auth, fetchFn };
  };
  const actor = (token: () => Promise<string>): AppActor => ({ app: APP, repoName: 'acme/web', token });

  it('posts and looks up the marker with the installation token, not the reviewer token', async () => {
    const { auth, fetchFn } = recorder();
    let calls = 0;
    const poster = new GitHubReviewPoster({
      fetch: fetchFn,
      tokens,
      actor: actor(async () => `ghs_app${++calls}`),
    });
    await poster.findByMarker(spec, 'm');
    await poster.post({ spec }, [], 'summary');
    expect(auth).toEqual(['Bearer ghs_app1', 'Bearer ghs_app2']);
  });

  it('without an app it uses the reviewer token as before', async () => {
    const { auth, fetchFn } = recorder();
    await new GitHubReviewPoster({ fetch: fetchFn, tokens }).post({ spec }, [], 'summary');
    expect(auth).toEqual(['Bearer reviewer-token']);
  });

  it('an app that cannot mint fails closed: nothing is sent, the reason names the app', async () => {
    const { auth, fetchFn } = recorder();
    const poster = new GitHubReviewPoster({
      fetch: fetchFn,
      tokens,
      actor: actor(async () => {
        throw new AppIdentityError(APP, 'the installation was removed');
      }),
    });
    const r = await postPrReview(
      { poster },
      {
        runId: UUID,
        spec: {
          runId: UUID,
          projectId: UUID,
          projectRepoId: REPO_ID,
          remoteUrlNormalized: spec.remoteUrlNormalized,
          prNumber: 3,
          headSha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
          baseRef: 'main',
        },
        summary: 's',
        findings: [],
      },
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toContain('app_identity_failed');
    expect(r.ok ? '' : r.error).toContain('Guild Bot');
    expect(auth).toEqual([]);
  });
});

describe('branch merge check with the app credential', () => {
  it('fetches and deletes the remote branch with the auth env (the push carries the app marker)', async () => {
    const { root, bare, clone } = repoWithMergedBranch();
    appRepos
      .forRoot(root)
      .set(normalizeRemoteUrl(bare), { integrationId: APP.integrationId, label: APP.label });
    const urls: string[] = [];
    const r = await checkBranchMerged({
      repoPath: clone,
      payload: {
        cardId: UUID,
        ref: 'GWP-1',
        repoId: REPO_ID,
        remoteUrlNormalized: normalizeRemoteUrl(bare),
        branchName: 'card/x',
        workingBranch: 'main',
        action: 'push_branch',
      },
      auth: async (url) => {
        urls.push(url);
        return { args: [], env: { AOM_GIT_APP: APP.integrationId } };
      },
    });
    expect(r).toMatchObject({ merged: true, remoteBranchDeleted: true });
    expect(urls.length).toBeGreaterThan(0);
    expect(sh(bare, 'git', ['branch', '--list', 'card/x'])).toBe('');
  });

  it('an app that cannot mint touches nothing on the remote', async () => {
    const { bare, clone } = repoWithMergedBranch();
    const r = await checkBranchMerged({
      repoPath: clone,
      payload: {
        cardId: UUID,
        ref: 'GWP-1',
        repoId: REPO_ID,
        remoteUrlNormalized: normalizeRemoteUrl(bare),
        branchName: 'card/x',
        workingBranch: 'main',
        action: 'push_branch',
      },
      auth: async () => {
        throw new AppIdentityError(APP, 'gone');
      },
    });
    expect(r.remoteBranchDeleted).toBe(false);
    expect(sh(bare, 'git', ['branch', '--list', 'card/x'])).toContain('card/x');
  });
});

describe('rebase fetch with the app credential', () => {
  it('asks auth for origin and fetches with its env', async () => {
    const { bare, clone } = repoWithMergedBranch();
    const urls: string[] = [];
    const r = await rebaseOntoBase(clone, 'main', null, null, async (url) => {
      urls.push(url);
      return { args: [], env: {} };
    });
    expect(r).toBe('up_to_date');
    expect(urls).toEqual([bare]);
  });
});

describe('push rejection reports', () => {
  it('appOfPlan finds only app entries', () => {
    expect(appOfPlan(plan(), 'github.com/acme/web')?.label).toBe('Guild Bot');
    expect(appOfPlan(plan(), 'github.com/acme/other')).toBeNull();
    expect(appOfPlan(undefined, 'github.com/acme/web')).toBeNull();
  });

  it('withPushReport appends the bypass for an app and leaves the message alone otherwise', () => {
    const why =
      'remote: error: GH006: Protected branch update failed for refs/heads/main.\nremote: error: Changes must be made through a pull request.';
    const out = withPushReport('pushing main failed', why, APP);
    expect(out.startsWith('pushing main failed\n')).toBe(true);
    expect(out).toContain('Guild Bot');
    expect(withPushReport('pushing main failed', why, null)).toBe('pushing main failed');
  });
});
