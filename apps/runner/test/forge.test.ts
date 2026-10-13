import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectSteps, describeConnection, saveAndVerify } from '../src/forge/connect.ts';
import {
  AzureDevOpsForge,
  BitbucketCloudForge,
  FileTokenStore,
  forgeForUrl,
  forgePrCreator,
  GitHubForge,
  GitLabForge,
  gitConnections,
  MemoryTokenStore,
  PlainGitForge,
} from '../src/forge/index.ts';
import type { ForgeEnv, RemoteRepo } from '../src/forge/types.ts';
import type { ExecOptions, ExecResult, Executor } from '../src/toolchain/exec.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

/** Scripted CLI: rules are matched against "cmd arg arg ..."; nothing runs for real. */
class FakeExec implements Executor {
  calls: Array<{ line: string; env?: Record<string, string> | undefined }> = [];
  constructor(private readonly rules: Array<[RegExp, Partial<ExecResult>]> = []) {}
  async run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    const line = [cmd, ...args].join(' ');
    this.calls.push({ line, env: opts?.env });
    for (const [re, r] of this.rules) if (re.test(line)) return { exitCode: 0, stdout: '', stderr: '', ...r };
    return { exitCode: 127, stdout: '', stderr: 'not found' };
  }
}

interface Call {
  url: string;
  method: string;
  auth: string | undefined;
  body: unknown;
}

const parseBody = (b: string): unknown => {
  try {
    return JSON.parse(b);
  } catch {
    return b;
  }
};

/** Scripted HTTP: handlers matched by "METHOD url-substring". No network. */
function fakeFetch(handlers: Array<[string, unknown | ((c: Call) => unknown)]>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      auth: headers.authorization ?? headers['PRIVATE-TOKEN'],
      body: init?.body ? parseBody(String(init.body)) : undefined,
    };
    calls.push(call);
    for (const [key, h] of [...handlers].sort((a, b) => b[0].length - a[0].length)) {
      const [m, ...rest] = key.split(' ');
      if (m === call.method && url.includes(rest.join(' '))) {
        const v = typeof h === 'function' ? (h as (c: Call) => unknown)(call) : h;
        if (v instanceof Response) return v;
        return new Response(JSON.stringify(v), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const env = (over: Partial<ForgeEnv> = {}): ForgeEnv => ({
  exec: new FakeExec(),
  fetch: fakeFetch([]).fetch,
  tokens: new MemoryTokenStore(),
  now: () => new Date('2026-10-10T08:00:00Z'),
  processEnv: {},
  ...over,
});

const repo = (kind: RemoteRepo['kind'], host: string, fullName: string): RemoteRepo => ({
  kind,
  host,
  fullName,
  url: `https://${host}/${fullName}.git`,
});

describe('forge registry', () => {
  it('picks the adapter from the URL and honours a manual override', () => {
    const e = env();
    expect(forgeForUrl(e, 'git@github.com:acme/web.git')?.forge).toBeInstanceOf(GitHubForge);
    expect(forgeForUrl(e, 'https://gitlab.com/grp/sub/app.git')?.repo.fullName).toBe('grp/sub/app');
    expect(forgeForUrl(e, 'git@ssh.dev.azure.com:v3/acme/shop/web')?.repo.fullName).toBe('acme/shop/web');
    expect(forgeForUrl(e, 'https://bitbucket.org/ws/app.git')?.forge).toBeInstanceOf(BitbucketCloudForge);
    expect(forgeForUrl(e, 'https://git.example.com/team/app.git')?.forge).toBeInstanceOf(PlainGitForge);
    // a self-hosted GitLab on an unrecognisable host
    const hit = forgeForUrl(e, 'https://code.example.com/team/app.git', 'gitlab');
    expect(hit?.forge).toBeInstanceOf(GitLabForge);
    expect(hit?.forge.host).toBe('code.example.com');
  });
});

describe('GitHub adapter (gh stubbed)', () => {
  it('reports connected with the account, or how to log in', async () => {
    const ok = new GitHubForge(env({ exec: new FakeExec([[/^gh api user/, { stdout: 'octo\n' }]]) }));
    expect(await ok.status?.()).toMatchObject({ provider: 'github', state: 'connected', account: 'octo' });
    const out = new GitHubForge(env({ exec: new FakeExec([[/^gh api user/, { exitCode: 1 }]]) }));
    expect((await out.status?.())?.state).toBe('not_connected');
    expect((await new GitHubForge(env()).status?.())?.state).toBe('unavailable');
  });

  it('opens a pull request and reads its state and branch rules', async () => {
    const x = new FakeExec([
      [/^gh pr create/, { stdout: 'Creating pull request\nhttps://github.com/acme/web/pull/12\n' }],
      [/^gh pr view 12/, { stdout: 'MERGED\n' }],
      [/branches\/main\/protection/, { stdout: JSON.stringify({ required_pull_request_reviews: {} }) }],
      [/rules\/branches\/main/, { stdout: '[]' }],
    ]);
    const gh = new GitHubForge(env({ exec: x }));
    const r = repo('github', 'github.com', 'acme/web');
    expect(await gh.openChange(r, { base: 'main', head: 'aom/x', title: 't', body: 'b' })).toEqual({
      id: '12',
      url: 'https://github.com/acme/web/pull/12',
    });
    expect(await gh.changeState(r, '12')).toBe('merged');
    expect(await gh.branchRules(r, 'main')).toEqual({ directPushAllowed: false, requiresChange: true });
  });

  it('an unprotected branch allows a direct push; unreadable rules are unknown', async () => {
    const open = new GitHubForge(
      env({
        exec: new FakeExec([
          [/protection/, { exitCode: 1, stderr: 'Branch not protected (HTTP 404)' }],
          [/rules\/branches/, { stdout: '[]' }],
        ]),
      }),
    );
    expect(await open.branchRules(repo('github', 'github.com', 'a/b'), 'main')).toEqual({
      directPushAllowed: true,
      requiresChange: false,
    });
    const denied = new GitHubForge(
      env({ exec: new FakeExec([[/protection/, { exitCode: 1, stderr: 'HTTP 403' }]]) }),
    );
    expect(await denied.branchRules(repo('github', 'github.com', 'a/b'), 'main')).toBeNull();
  });

  it('lists repositories with a search filter', async () => {
    const list = JSON.stringify([
      {
        nameWithOwner: 'acme/web',
        url: 'https://github.com/acme/web',
        sshUrl: 'git@github.com:acme/web.git',
        isPrivate: true,
        defaultBranchRef: { name: 'main' },
      },
      { nameWithOwner: 'acme/api', url: 'https://github.com/acme/api', isPrivate: false },
    ]);
    const gh = new GitHubForge(env({ exec: new FakeExec([[/^gh repo list/, { stdout: list }]]) }));
    const all = await gh.listRepos({});
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      fullName: 'acme/web',
      cloneUrl: 'https://github.com/acme/web.git',
      defaultBranch: 'main',
    });
    expect((await gh.listRepos({ search: 'API' })).map((r) => r.fullName)).toEqual(['acme/api']);
  });
});

describe('GitLab adapter (REST stubbed)', () => {
  const tokens = () => {
    const t = new MemoryTokenStore();
    t.set({ provider: 'gitlab', host: 'gitlab.com', token: 'glpat-SECRET' });
    return t;
  };

  it('status, picker, create, merge request, state and protected-branch rules', async () => {
    const f = fakeFetch([
      ['GET /api/v4/user', { username: 'jo' }],
      [
        'GET /api/v4/projects?',
        [
          {
            path_with_namespace: 'grp/sub/app',
            http_url_to_repo: 'https://gitlab.com/grp/sub/app.git',
            default_branch: 'main',
            visibility: 'private',
          },
        ],
      ],
      ['GET /api/v4/namespaces/grp%2Fsub', { id: 7 }],
      [
        'POST /api/v4/projects',
        (c: Call) => ({
          path_with_namespace: `grp/sub/${(c.body as { name: string }).name}`,
          http_url_to_repo: 'https://gitlab.com/grp/sub/new.git',
        }),
      ],
      [
        'POST /api/v4/projects/grp%2Fsub%2Fapp/merge_requests',
        { iid: 4, web_url: 'https://gitlab.com/grp/sub/app/-/merge_requests/4' },
      ],
      ['GET /api/v4/projects/grp%2Fsub%2Fapp/merge_requests/4', { state: 'merged' }],
      [
        'GET /api/v4/projects/grp%2Fsub%2Fapp/protected_branches/main',
        { push_access_levels: [{ access_level: 0 }] },
      ],
      ['GET /api/v4/projects/grp%2Fsub%2Fapp/protected_branches/dev', new Response('{}', { status: 404 })],
    ]);
    const gl = new GitLabForge(env({ fetch: f.fetch, tokens: tokens() }));
    expect(await gl.status?.()).toMatchObject({ state: 'connected', account: 'jo' });
    expect((await gl.listRepos({ search: 'app' }))[0]).toMatchObject({
      fullName: 'grp/sub/app',
      private: true,
    });
    expect((await gl.createRepo({ fullName: 'grp/sub/new', private: true })).cloneUrl).toBe(
      'https://gitlab.com/grp/sub/new.git',
    );
    expect(f.calls.find((c) => c.method === 'POST' && c.url.endsWith('/projects'))?.body).toMatchObject({
      name: 'new',
      namespace_id: 7,
      visibility: 'private',
    });
    const r = repo('gitlab', 'gitlab.com', 'grp/sub/app');
    expect(await gl.openChange(r, { base: 'main', head: 'x', title: 't', body: 'b' })).toMatchObject({
      id: '4',
    });
    expect(await gl.changeState(r, '4')).toBe('merged');
    expect(await gl.branchRules(r, 'main')).toEqual({ directPushAllowed: false, requiresChange: true });
    expect(await gl.branchRules(r, 'dev')).toEqual({ directPushAllowed: true, requiresChange: false });
    // the token travels in a header only, never in a URL
    expect(f.calls.every((c) => !c.url.includes('SECRET'))).toBe(true);
  });

  it('git gets the token through the environment of its own process, not argv', async () => {
    const gl = new GitLabForge(env({ tokens: tokens() }));
    const a = await gl.gitAuth('https://gitlab.com/grp/sub/app.git');
    expect(a.args).toEqual([]);
    expect(a.env.AOM_GIT_TOKEN).toBe('glpat-SECRET');
    expect(JSON.stringify(a.args)).not.toContain('SECRET');
    expect(await gl.gitAuth('git@gitlab.com:grp/sub/app.git')).toEqual({ args: [], env: {} });
  });

  it('without a token it is not connected and a merge request is "unavailable"', async () => {
    const gl = new GitLabForge(env());
    expect((await gl.status?.())?.state).toBe('not_connected');
    await expect(
      gl.openChange(repo('gitlab', 'gitlab.com', 'a/b'), { base: 'm', head: 'h', title: 't', body: '' }),
    ).rejects.toThrow(/not connected/);
  });
});

describe('Azure DevOps adapter (REST stubbed)', () => {
  const tokens = () => {
    const t = new MemoryTokenStore();
    t.set({ provider: 'azure-devops', host: 'dev.azure.com', token: 'PAT-SECRET', organization: 'acme' });
    return t;
  };
  const basic = `Basic ${Buffer.from(':PAT-SECRET').toString('base64')}`;

  it('lists, creates, opens a PR, reads its state and the branch policies', async () => {
    const f = fakeFetch([
      ['GET https://dev.azure.com/acme/_apis/projects', { count: 1 }],
      [
        'GET https://dev.azure.com/acme/_apis/git/repositories',
        {
          value: [
            {
              name: 'web',
              remoteUrl: 'https://acme@dev.azure.com/acme/Shop/_git/web',
              sshUrl: 'git@ssh.dev.azure.com:v3/acme/Shop/web',
              defaultBranch: 'refs/heads/main',
              project: { name: 'Shop' },
            },
          ],
        },
      ],
      [
        'POST https://dev.azure.com/acme/Shop/_apis/git/repositories',
        { name: 'new', remoteUrl: 'https://acme@dev.azure.com/acme/Shop/_git/new' },
      ],
      ['POST https://dev.azure.com/acme/Shop/_apis/git/repositories/web/pullrequests', { pullRequestId: 9 }],
      [
        'GET https://dev.azure.com/acme/Shop/_apis/git/repositories/web/pullrequests/9',
        { status: 'completed' },
      ],
      ['GET https://dev.azure.com/acme/Shop/_apis/git/repositories/web?', { id: 'rid' }],
      [
        'GET https://dev.azure.com/acme/Shop/_apis/policy/configurations',
        {
          value: [
            { isEnabled: true, isBlocking: true, type: { id: 'fa4e907d-c16b-4a4c-9dfa-4906e5d171dd' } },
          ],
        },
      ],
    ]);
    const az = new AzureDevOpsForge(env({ fetch: f.fetch, tokens: tokens() }));
    expect(await az.status?.()).toMatchObject({ state: 'connected', account: 'acme', method: 'token' });
    const list = await az.listRepos({});
    expect(list[0]).toMatchObject({
      fullName: 'acme/Shop/web',
      cloneUrl: 'https://dev.azure.com/acme/Shop/_git/web',
      defaultBranch: 'main',
    });
    expect((await az.createRepo({ fullName: 'acme/Shop/new', private: true })).fullName).toBe(
      'acme/Shop/new',
    );
    const r = repo('azure-devops', 'dev.azure.com', 'acme/Shop/web');
    expect(await az.openChange(r, { base: 'main', head: 'aom/x', title: 't', body: 'b' })).toEqual({
      id: '9',
      url: 'https://dev.azure.com/acme/Shop/_git/web/pullrequest/9',
    });
    expect(f.calls.find((c) => c.url.endsWith('/pullrequests?api-version=7.1'))?.body).toMatchObject({
      sourceRefName: 'refs/heads/aom/x',
      targetRefName: 'refs/heads/main',
    });
    expect(await az.changeState(r, '9')).toBe('merged');
    expect(await az.branchRules(r, 'main')).toEqual({ directPushAllowed: false, requiresChange: true });
    expect(f.calls.every((c) => c.auth === basic)).toBe(true);
  });

  it('a bad PAT (sign-in page) is "not connected"; without a token az is tried, then not connected', async () => {
    const bad = fakeFetch([
      ['GET https://dev.azure.com/acme/_apis/projects', new Response('<html>', { status: 203 })],
    ]);
    const az = new AzureDevOpsForge(env({ fetch: bad.fetch, tokens: tokens() }));
    expect((await az.status?.())?.state).toBe('not_connected');
    const none = new AzureDevOpsForge(env());
    expect((await none.status?.())?.state).toBe('not_connected');
    const viaAz = new AzureDevOpsForge(
      env({ exec: new FakeExec([[/^az account get-access-token/, { stdout: 'ENTRA\n' }]]) }),
    );
    expect(await viaAz.status?.()).toMatchObject({ state: 'connected', method: 'cli' });
    const g = await viaAz.gitAuth('https://dev.azure.com/acme/Shop/_git/web');
    expect(g.env.GIT_CONFIG_VALUE_0).toBe('Authorization: Bearer ENTRA');
  });
});

describe('Bitbucket Cloud adapter (REST stubbed)', () => {
  const tokens = () => {
    const t = new MemoryTokenStore();
    t.set({
      provider: 'bitbucket-cloud',
      host: 'bitbucket.org',
      token: 'ATAT-SECRET',
      user: 'me@example.com',
    });
    return t;
  };

  it('lists, creates, opens a PR, reads its state and branch restrictions', async () => {
    const f = fakeFetch([
      ['GET https://api.bitbucket.org/2.0/user', { nickname: 'me' }],
      [
        'GET https://api.bitbucket.org/2.0/repositories?',
        {
          values: [
            {
              full_name: 'ws/app',
              is_private: true,
              mainbranch: { name: 'main' },
              links: {
                clone: [
                  { name: 'https', href: 'https://me@bitbucket.org/ws/app.git' },
                  { name: 'ssh', href: 'git@bitbucket.org:ws/app.git' },
                ],
              },
            },
          ],
        },
      ],
      [
        'POST https://api.bitbucket.org/2.0/repositories/ws/new',
        {
          full_name: 'ws/new',
          links: { clone: [{ name: 'https', href: 'https://me@bitbucket.org/ws/new.git' }] },
        },
      ],
      [
        'POST https://api.bitbucket.org/2.0/repositories/ws/app/pullrequests',
        { id: 3, links: { html: { href: 'https://bitbucket.org/ws/app/pull-requests/3' } } },
      ],
      ['GET https://api.bitbucket.org/2.0/repositories/ws/app/pullrequests/3', { state: 'DECLINED' }],
      [
        'GET https://api.bitbucket.org/2.0/repositories/ws/app/branch-restrictions',
        { values: [{ kind: 'push', pattern: 'main', branch_match_kind: 'glob' }] },
      ],
    ]);
    const bb = new BitbucketCloudForge(env({ fetch: f.fetch, tokens: tokens() }));
    expect(await bb.status?.()).toMatchObject({ state: 'connected', account: 'me' });
    expect((await bb.listRepos({ search: 'app' }))[0]).toMatchObject({
      fullName: 'ws/app',
      cloneUrl: 'https://bitbucket.org/ws/app.git',
      sshUrl: 'git@bitbucket.org:ws/app.git',
    });
    expect((await bb.createRepo({ fullName: 'ws/new', private: true })).cloneUrl).toBe(
      'https://bitbucket.org/ws/new.git',
    );
    const r = repo('bitbucket-cloud', 'bitbucket.org', 'ws/app');
    expect((await bb.openChange(r, { base: 'main', head: 'x', title: 't', body: '' })).url).toBe(
      'https://bitbucket.org/ws/app/pull-requests/3',
    );
    expect(await bb.changeState(r, '3')).toBe('closed');
    expect(await bb.branchRules(r, 'main')).toEqual({ directPushAllowed: false, requiresChange: true });
    expect(await bb.branchRules(r, 'feature')).toEqual({ directPushAllowed: true, requiresChange: false });
    expect(f.calls[0]?.auth).toBe(`Basic ${Buffer.from('me@example.com:ATAT-SECRET').toString('base64')}`);
  });

  describe('status', () => {
    const BB = 'https://api.bitbucket.org/2.0';
    const deny = (status: number, message = 'nope') =>
      new Response(JSON.stringify({ error: { message } }), { status });
    const run = (handlers: Parameters<typeof fakeFetch>[0], store: MemoryTokenStore = tokens()) =>
      new BitbucketCloudForge(env({ fetch: fakeFetch(handlers).fetch, tokens: store })).status();

    it('no token: not connected, problem no_token', async () => {
      expect(await run([], new MemoryTokenStore())).toMatchObject({
        state: 'not_connected',
        problem: 'no_token',
      });
    });

    it('/user answers: connected with the account', async () => {
      expect(await run([[`GET ${BB}/user`, { nickname: 'me' }]])).toMatchObject({
        state: 'connected',
        account: 'me',
      });
    });

    it('/user refused for lack of the account scope but repositories work: connected, not "not available"', async () => {
      const st = await run([
        [`GET ${BB}/user`, deny(403, 'Your credentials lack one or more required privilege scopes')],
        [`GET ${BB}/repositories?`, { values: [] }],
      ]);
      expect(st).toMatchObject({ state: 'connected', method: 'token', account: 'me@example.com' });
      expect(st.problem).toBeUndefined();
    });

    it('both calls refused: token_refused with the HTTP status and a scope hint (403) or e-mail hint (401)', async () => {
      const r403 = await run([
        [`GET ${BB}/user`, deny(403)],
        [`GET ${BB}/repositories?`, deny(403)],
      ]);
      expect(r403).toMatchObject({ state: 'not_connected', problem: 'token_refused' });
      expect(r403.detail).toMatch(/HTTP 403/);
      expect(r403.detail).toMatch(/scope/);
      const r401 = await run([
        [`GET ${BB}/user`, deny(401)],
        [`GET ${BB}/repositories?`, deny(401)],
      ]);
      expect(r401.detail).toMatch(/HTTP 401/);
      expect(r401.detail).toMatch(/e-mail/);
    });

    it('API unreachable or erroring: unavailable/unreachable, never "not connected"', async () => {
      const down = new BitbucketCloudForge(
        env({
          fetch: (async () => {
            throw new Error('getaddrinfo ENOTFOUND api.bitbucket.org');
          }) as typeof fetch,
          tokens: tokens(),
        }),
      );
      expect(await down.status()).toMatchObject({ state: 'unavailable', problem: 'unreachable' });
      expect(await run([[`GET ${BB}/user`, deny(503, 'busy')]])).toMatchObject({
        state: 'unavailable',
        problem: 'unreachable',
      });
    });

    it('a token without an e-mail still pushes: connected, with a note that pull requests need the e-mail', async () => {
      const t = new MemoryTokenStore();
      t.set({ provider: 'bitbucket-cloud', host: 'bitbucket.org', token: 'ATAT' });
      const st = await run([], t);
      expect(st).toMatchObject({ state: 'connected', method: 'token' });
      expect(st.detail).toMatch(/e-mail/);
    });
  });

  it('git over https uses the API-token user name', async () => {
    const bb = new BitbucketCloudForge(env({ tokens: tokens() }));
    const a = await bb.gitAuth('https://bitbucket.org/ws/app.git');
    expect(a.env.AOM_GIT_USER).toBe('x-bitbucket-api-token-auth');
    expect(a.env.AOM_GIT_TOKEN).toBe('ATAT-SECRET');
  });
});

describe('plain git fallback', () => {
  it('has no pull requests: the completion PrCreator reports "unavailable"', async () => {
    const r = makeRepo();
    sh(r.clone, 'git', ['remote', 'set-url', 'origin', 'https://git.example.com/team/app.git']);
    const pr = forgePrCreator(env());
    const res = await pr.create({ cwd: r.clone, base: 'main', branch: 'b', title: 't', body: 'b' });
    expect('unavailable' in res).toBe(true);
  });

  it('a forge that is not logged in reports unavailable instead of failing the completion', async () => {
    const r = makeRepo();
    sh(r.clone, 'git', ['remote', 'set-url', 'origin', 'https://gitlab.com/grp/app.git']);
    const res = await forgePrCreator(env()).create({
      cwd: r.clone,
      base: 'main',
      branch: 'b',
      title: 't',
      body: 'b',
    });
    expect(res).toHaveProperty('unavailable');
  });

  it('the forge override on the repository wins over the URL', async () => {
    const r = makeRepo();
    sh(r.clone, 'git', ['remote', 'set-url', 'origin', 'https://code.example.com/team/app.git']);
    const x = new FakeExec([[/^gh pr create/, { stdout: 'https://code.example.com/team/app/pull/1\n' }]]);
    const res = await forgePrCreator(env({ exec: x })).create({
      cwd: r.clone,
      base: 'main',
      branch: 'b',
      title: 't',
      body: 'b',
      forge: 'github',
    });
    expect(res).toEqual({ url: 'https://code.example.com/team/app/pull/1' });
  });
});

describe('connections and the token store', () => {
  it('reports every provider without leaking a secret', async () => {
    const tokens = new MemoryTokenStore();
    tokens.set({ provider: 'gitlab', host: 'gitlab.com', token: 'glpat-SECRET' });
    const f = fakeFetch([['GET https://gitlab.com/api/v4/user', { username: 'jo' }]]);
    const list = await gitConnections(
      env({ tokens, fetch: f.fetch, exec: new FakeExec([[/^gh api user/, { stdout: 'octo' }]]) }),
    );
    expect(list.map((c) => `${c.provider}:${c.state}`)).toEqual([
      'github:connected',
      'gitlab:connected',
      'bitbucket-cloud:not_connected',
      'azure-devops:not_connected',
    ]);
    expect(JSON.stringify(list)).not.toContain('SECRET');
  });

  it('saveAndVerify keeps a working token and drops a refused one', async () => {
    const tokens = new MemoryTokenStore();
    const good = fakeFetch([['GET https://gitlab.com/api/v4/user', { username: 'jo' }]]);
    const st = await saveAndVerify(env({ tokens, fetch: good.fetch }), { provider: 'gitlab', token: 't1' });
    expect(st.state).toBe('connected');
    expect(tokens.get('gitlab', 'gitlab.com')?.token).toBe('t1');
    const bad = fakeFetch([]);
    const st2 = await saveAndVerify(env({ tokens, fetch: bad.fetch }), {
      provider: 'gitlab',
      host: 'git.corp',
      token: 'nope',
    });
    expect(st2.state).toBe('not_connected');
    expect(tokens.get('gitlab', 'git.corp')).toBeUndefined();
  });

  it('FileTokenStore writes mode 0600 and lists without tokens', () => {
    const dir = mkdtempSync(join(tmp(), 'tok-'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'secrets', 'git-tokens.json');
    const s = new FileTokenStore(file);
    s.set({ provider: 'azure-devops', host: 'dev.azure.com', token: 'abc', organization: 'acme' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new FileTokenStore(file).get('azure-devops', 'dev.azure.com')?.organization).toBe('acme');
    expect(JSON.stringify(s.list())).not.toContain('abc');
    expect(readFileSync(file, 'utf8')).toContain('abc');
  });

  it('describes status and guidance in plain words', () => {
    expect(
      describeConnection({
        provider: 'github',
        host: 'github.com',
        state: 'connected',
        account: 'octo',
        checkedAt: '2026-10-10T00:00:00.000Z',
      }),
    ).toBe('GitHub (github.com): connected as octo');
    expect(connectSteps('bitbucket-cloud').join('\n')).toMatch(/API token/);
    expect(connectSteps('azure-devops').join('\n')).toMatch(/2026-12-01/);
  });
});

describe('Azure DevOps with a Microsoft Entra service principal', () => {
  const sp = { AZURE_TENANT_ID: 'tenant-1', AZURE_CLIENT_ID: 'client-1', AZURE_CLIENT_SECRET: 'S3CRET' };

  it('asks Entra for a token with the client secret and uses it for REST and git', async () => {
    const f = fakeFetch([
      [
        'POST https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token',
        { access_token: 'ENTRA-SP', expires_in: 3600 },
      ],
      ['GET https://dev.azure.com/acme/_apis/projects', { count: 1 }],
    ]);
    const az = new AzureDevOpsForge(
      env({ fetch: f.fetch, processEnv: { ...sp, AZURE_DEVOPS_ORGANIZATION: 'acme' } }),
    );
    expect(await az.status?.()).toMatchObject({
      state: 'connected',
      method: 'service-principal',
      account: 'acme',
    });
    const tokenCall = f.calls.find((c) => c.url.includes('login.microsoftonline.com'));
    const form = new URLSearchParams(String(tokenCall?.body));
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_id')).toBe('client-1');
    expect(form.get('client_secret')).toBe('S3CRET');
    expect(f.calls.find((c) => c.url.includes('_apis/projects'))?.auth).toBe('Bearer ENTRA-SP');
    const g = await az.gitAuth('https://dev.azure.com/acme/Shop/_git/web');
    expect(g.env.GIT_CONFIG_VALUE_0).toBe('Authorization: Bearer ENTRA-SP');
    // the token is cached: one token request for the calls above
    expect(f.calls.filter((c) => c.url.includes('login.microsoftonline.com'))).toHaveLength(1);
  });

  it('uses the workload identity token file instead of a secret', async () => {
    const dir = tmp('azfed');
    const file = join(dir, 'token');
    writeFileSync(file, 'FEDERATED-JWT\n');
    let sent = '';
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('login.microsoftonline.com')) {
        sent = String(init?.body);
        return new Response(JSON.stringify({ access_token: 'T', expires_in: 3600 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const az = new AzureDevOpsForge(
      env({
        fetch: fetcher,
        processEnv: { AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_FEDERATED_TOKEN_FILE: file },
      }),
      'dev.azure.com',
      'acme',
    );
    expect((await az.status?.())?.method).toBe('service-principal');
    const form = new URLSearchParams(sent);
    expect(form.get('client_assertion')).toBe('FEDERATED-JWT');
    expect(form.get('client_secret')).toBeNull();
    expect(form.get('scope')).toBe('499b84ac-1321-427f-aa17-267ca6975798/.default');
  });

  it('a saved PAT wins; a refused service principal falls back to az; incomplete settings are ignored', async () => {
    const t = new MemoryTokenStore();
    t.set({ provider: 'azure-devops', host: 'dev.azure.com', token: 'PAT', organization: 'acme' });
    const f = fakeFetch([['GET https://dev.azure.com/acme/_apis/projects', { count: 1 }]]);
    const withPat = new AzureDevOpsForge(env({ fetch: f.fetch, tokens: t, processEnv: sp }));
    expect(await withPat.status?.()).toMatchObject({ method: 'token' });
    expect(f.calls.some((c) => c.url.includes('login.microsoftonline.com'))).toBe(false);

    const refused = fakeFetch([
      ['POST https://login.microsoftonline.com', new Response('{"error":"invalid_client"}', { status: 401 })],
    ]);
    const viaAz = new AzureDevOpsForge(
      env({
        fetch: refused.fetch,
        processEnv: sp,
        exec: new FakeExec([[/^az account get-access-token/, { stdout: 'AZ\n' }]]),
      }),
    );
    expect(await viaAz.status?.()).toMatchObject({ state: 'connected', method: 'cli' });

    const partial = new AzureDevOpsForge(env({ processEnv: { AZURE_CLIENT_ID: 'c', AZURE_TENANT_ID: 't' } }));
    expect((await partial.status?.())?.state).toBe('not_connected');
  });
});

describe('openChange reuses an open change for the same branch (a reopened card)', () => {
  const bbTokens = () => {
    const t = new MemoryTokenStore();
    t.set({ provider: 'bitbucket-cloud', host: 'bitbucket.org', token: 'T', user: 'me@example.com' });
    return t;
  };

  it('Bitbucket: returns the open pull request and creates none', async () => {
    const f = fakeFetch([
      [
        'GET https://api.bitbucket.org/2.0/repositories/ws/app/pullrequests?',
        { values: [{ id: 7, links: { html: { href: 'https://bitbucket.org/ws/app/pull-requests/7' } } }] },
      ],
    ]);
    const bb = new BitbucketCloudForge(env({ fetch: f.fetch, tokens: bbTokens() }));
    const r = repo('bitbucket-cloud', 'bitbucket.org', 'ws/app');
    expect(await bb.openChange(r, { base: 'main', head: 'aom/x', title: 't', body: '' })).toEqual({
      id: '7',
      url: 'https://bitbucket.org/ws/app/pull-requests/7',
    });
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(decodeURIComponent(f.calls[0]?.url ?? '')).toContain('source.branch.name="aom/x"');
  });

  it('GitHub: returns the open pull request and does not run gh pr create', async () => {
    const x = new FakeExec([
      [/^gh pr list/, { stdout: JSON.stringify([{ number: 5, url: 'https://github.com/acme/web/pull/5' }]) }],
    ]);
    const gh = new GitHubForge(env({ exec: x }));
    const r = repo('github', 'github.com', 'acme/web');
    expect(await gh.openChange(r, { base: 'main', head: 'aom/x', title: 't', body: 'b' })).toEqual({
      id: '5',
      url: 'https://github.com/acme/web/pull/5',
    });
    expect(x.calls.some((c) => c.line.startsWith('gh pr create'))).toBe(false);
  });
});
