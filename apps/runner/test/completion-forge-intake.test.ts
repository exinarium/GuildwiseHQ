import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FinalizeExecutePayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { GitHubForge, GitLabForge, MemoryTokenStore } from '../src/forge/index.ts';
import type { ForgeEnv, RemoteRepo } from '../src/forge/types.ts';
import { executeCompletion } from '../src/git/completion.ts';
import type { PrCreator, PrInput } from '../src/git/gh.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import type { ExecResult, Executor } from '../src/toolchain/exec.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

/**
 * The forges write the merge commit of a pull/merge request from its head branch and title (the runner cannot preset
 * it), so an intake card's PR must reach both forges with an ABC-1 head branch, title and body and no internal ref.
 */

const BRANCH = 'aom/ABC-1-add-thing';

async function intakePrInput(): Promise<PrInput> {
  const repo = makeRepo();
  const path = join(tmp(), 'wt');
  await ensureWorktree({
    repoPath: repo.clone,
    roots: ['/'],
    spec: {
      mode: 'create',
      repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
      remoteUrlNormalized: repo.remoteNormalized,
      baseBranch: 'main',
      branchName: BRANCH,
    },
    defaultPath: path,
  });
  writeFileSync(join(path, 'thing.txt'), 'thing\n');
  sh(path, 'git', ['add', '-A']);
  sh(path, 'git', ['commit', '-m', 'ABC-1: add thing']);
  const payload: FinalizeExecutePayload = {
    cardId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
    ref: 'TOY-1',
    title: 'Add thing',
    projectKey: 'TOY',
    action: 'pr',
    repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
    remoteUrlNormalized: repo.remoteNormalized,
    baseBranch: 'main',
    branchName: BRANCH,
    worktreePath: path,
    prBranchPrefix: 'feature',
    ticket: 'ABC-1',
    workRef: 'ABC-1',
    isClientRef: true,
  };
  const calls: PrInput[] = [];
  const pr: PrCreator = {
    async create(input) {
      calls.push(input);
      return { url: 'u' };
    },
  };
  const res = await executeCompletion({
    payload,
    repoPath: repo.clone,
    worktreePath: path,
    worktreesDir: '/',
    integrationDir: join(tmp(), 'integration'),
    pr,
  });
  expect(res.ok).toBe(true);
  expect(calls).toHaveLength(1);
  return calls[0] as PrInput;
}

class ArgsExec implements Executor {
  calls: string[][] = [];
  async run(cmd: string, args: string[]): Promise<ExecResult> {
    this.calls.push([cmd, ...args]);
    if (args[0] === 'pr' && args[1] === 'list') return { exitCode: 0, stdout: '[]', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'create')
      return { exitCode: 0, stdout: 'https://github.com/acme/web/pull/12\n', stderr: '' };
    return { exitCode: 127, stdout: '', stderr: 'not found' };
  }
}

const env = (over: Partial<ForgeEnv>): ForgeEnv => ({
  exec: new ArgsExec(),
  fetch: (async () => new Response('{}', { status: 404 })) as typeof fetch,
  tokens: new MemoryTokenStore(),
  now: () => new Date('2026-11-08T08:00:00Z'),
  processEnv: {},
  ...over,
});

const repo = (kind: RemoteRepo['kind'], host: string, fullName: string): RemoteRepo => ({
  kind,
  host,
  fullName,
  url: `https://${host}/${fullName}.git`,
});

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

describe('intake card pull request on the forges', () => {
  it('GitHub: gh pr create gets the ABC-1 head branch, title and body, no internal ref', async () => {
    const input = await intakePrInput();
    const x = new ArgsExec();
    const gh = new GitHubForge(env({ exec: x }));
    await gh.openChange(repo('github', 'github.com', 'acme/web'), {
      base: input.base,
      head: input.branch,
      title: input.title,
      body: input.body,
    });
    const create = x.calls.find((c) => c[1] === 'pr' && c[2] === 'create') as string[];
    expect(flag(create, '--head')).toBe('feature/ABC-1');
    expect(flag(create, '--title')).toBe('ABC-1: Add thing');
    expect(flag(create, '--body')).toBe('Add thing');
    expect(create.join(' ')).not.toMatch(/TOY-1/i);
  });

  it('GitLab: the merge request gets the ABC-1 source branch, title and description, no internal ref', async () => {
    const input = await intakePrInput();
    const posts: unknown[] = [];
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/merge_requests?'))
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      if (init?.method === 'POST' && url.endsWith('/merge_requests')) {
        posts.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({ iid: 4, web_url: 'https://gitlab.com/grp/app/-/merge_requests/4' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const tokens = new MemoryTokenStore();
    tokens.set({ provider: 'gitlab', host: 'gitlab.com', token: 'glpat-x' });
    const gl = new GitLabForge(env({ fetch: f, tokens }));
    await gl.openChange(repo('gitlab', 'gitlab.com', 'grp/app'), {
      base: input.base,
      head: input.branch,
      title: input.title,
      body: input.body,
    });
    expect(posts).toEqual([
      {
        source_branch: 'feature/ABC-1',
        target_branch: 'main',
        title: 'ABC-1: Add thing',
        description: 'Add thing',
      },
    ]);
    expect(JSON.stringify(posts)).not.toMatch(/TOY-1/i);
  });
});
