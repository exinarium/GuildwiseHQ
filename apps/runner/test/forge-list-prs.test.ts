import { PR_LIST_LIMIT, RepoListPrsResultSchema } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { GitHubForge, MemoryTokenStore } from '../src/forge/index.ts';
import { listOpenPrs } from '../src/forge/list-prs.ts';
import type { ForgeEnv, RemoteRepo } from '../src/forge/types.ts';
import type { ExecOptions, ExecResult, Executor } from '../src/toolchain/exec.ts';

/** Scripted CLI: rules are matched against "cmd arg arg ..."; nothing runs for real. */
class FakeExec implements Executor {
  calls: string[] = [];
  constructor(private readonly rules: Array<[RegExp, Partial<ExecResult>]> = []) {}
  async run(cmd: string, args: string[], _opts?: ExecOptions): Promise<ExecResult> {
    const line = [cmd, ...args].join(' ');
    this.calls.push(line);
    for (const [re, r] of this.rules) if (re.test(line)) return { exitCode: 0, stdout: '', stderr: '', ...r };
    return { exitCode: 127, stdout: '', stderr: 'not found' };
  }
}

const env = (exec: Executor): ForgeEnv => ({
  exec,
  fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
  tokens: new MemoryTokenStore(),
  now: () => new Date('2026-11-12T08:00:00Z'),
  processEnv: {},
});

const repo: RemoteRepo = {
  kind: 'github',
  host: 'github.com',
  fullName: 'acme/web',
  url: 'https://github.com/acme/web.git',
};

const ghRow = (n: number) => ({
  number: n,
  url: `https://github.com/acme/web/pull/${n}`,
  title: `Change ${n}`,
  author: { login: 'octo' },
  headRefName: `feature/${n}`,
  baseRefName: 'main',
  createdAt: '2026-11-12T07:00:00Z',
});

const payload = {
  requestId: '00000000-0000-4000-8000-000000000001',
  repoId: '00000000-0000-4000-8000-000000000002',
  remoteUrlNormalized: 'github.com/acme/web',
};

describe('GitHub lists open pull requests (gh stubbed)', () => {
  it('maps gh pr list JSON and asks for one more than the limit', async () => {
    const x = new FakeExec([
      [/^gh pr list/, { stdout: JSON.stringify([ghRow(7), { ...ghRow(8), author: null }]) }],
    ]);
    const out = await new GitHubForge(env(x)).listOpenChanges(repo, 5);
    expect(out.complete).toBe(true);
    expect(out.changes).toEqual([
      {
        id: '7',
        url: 'https://github.com/acme/web/pull/7',
        title: 'Change 7',
        author: 'octo',
        head: 'feature/7',
        base: 'main',
        createdAt: '2026-11-12T07:00:00Z',
      },
      expect.objectContaining({ id: '8', author: null }),
    ]);
    const call = x.calls.find((c) => c.startsWith('gh pr list'));
    expect(call).toContain('--repo acme/web');
    expect(call).toContain('--state open');
    expect(call).toContain('--limit 6');
  });

  it('is not complete when there are more than the limit', async () => {
    const x = new FakeExec([[/^gh pr list/, { stdout: JSON.stringify([ghRow(1), ghRow(2), ghRow(3)]) }]]);
    const out = await new GitHubForge(env(x)).listOpenChanges(repo, 2);
    expect(out.complete).toBe(false);
    expect(out.changes.map((c) => c.id)).toEqual(['1', '2']);
  });

  it('a gh failure throws', async () => {
    const x = new FakeExec([[/^gh pr list/, { exitCode: 1, stderr: 'HTTP 401' }]]);
    await expect(new GitHubForge(env(x)).listOpenChanges(repo, 2)).rejects.toThrow(/gh pr list failed/);
  });
});

describe('repo.list_prs answer', () => {
  it('lists through the forge of the clone, within the shared limit, as a valid result', async () => {
    const x = new FakeExec([[/^gh pr list/, { stdout: JSON.stringify([ghRow(4)]) }]]);
    const out = await listOpenPrs({ payload, remoteUrl: 'git@github.com:acme/web.git', forgeEnv: env(x) });
    expect(RepoListPrsResultSchema.parse(out)).toMatchObject({ ok: true, complete: true });
    expect(out.ok && out.changes.map((c) => c.id)).toEqual(['4']);
    expect(x.calls.find((c) => c.startsWith('gh pr list'))).toContain(`--limit ${PR_LIST_LIMIT + 1}`);
  });

  it('no clone here is an answer', async () => {
    const out = await listOpenPrs({ payload, remoteUrl: null, forgeEnv: env(new FakeExec()) });
    expect(out).toEqual({ ok: false, reason: 'no_clone' });
  });

  it('a git host without pull request listing answers unsupported', async () => {
    const out = await listOpenPrs({
      payload: { ...payload, remoteUrlNormalized: 'gitlab.com/acme/web' },
      remoteUrl: 'https://gitlab.com/acme/web.git',
      forgeEnv: env(new FakeExec()),
    });
    expect(out).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('a missing gh is not connected, any other failure is an error', async () => {
    const missing = await listOpenPrs({
      payload,
      remoteUrl: 'https://github.com/acme/web.git',
      forgeEnv: env(new FakeExec()),
    });
    expect(missing).toMatchObject({ ok: false, reason: 'not_connected' });
    const failing = await listOpenPrs({
      payload,
      remoteUrl: 'https://github.com/acme/web.git',
      forgeEnv: env(new FakeExec([[/^gh pr list/, { exitCode: 1, stderr: 'boom' }]])),
    });
    expect(failing).toMatchObject({ ok: false, reason: 'error' });
    expect(RepoListPrsResultSchema.safeParse(failing).success).toBe(true);
  });
});
