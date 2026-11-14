import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RepoListMergedPrsResultSchema } from '@aom/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitHubForge, MemoryTokenStore } from '../src/forge/index.ts';
import { listMergedPrs } from '../src/forge/list-prs.ts';
import type { ForgeEnv, RemoteRepo } from '../src/forge/types.ts';
import { runnerPaths } from '../src/paths.ts';
import { resolveReplayBase } from '../src/review/replay-base.ts';
import {
  disposeReviewerRun,
  prepareReviewerRun,
  type ReviewerSandboxDeps,
} from '../src/review/reviewer-sandbox.ts';
import { MemoryReviewerTokenStore } from '../src/review/reviewer-tokens.ts';
import type { ExecOptions, ExecResult, Executor } from '../src/toolchain/exec.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

class FakeExec implements Executor {
  constructor(private readonly rules: Array<[RegExp, Partial<ExecResult>]> = []) {}
  async run(cmd: string, args: string[], _opts?: ExecOptions): Promise<ExecResult> {
    const line = [cmd, ...args].join(' ');
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
const sha = (c: string) => c.repeat(40);
const row = (n: number, merge: string | null) => ({
  number: n,
  url: `https://github.com/acme/web/pull/${n}`,
  title: `Change ${n}`,
  author: { login: 'octo' },
  headRefName: `feature/${n}`,
  baseRefName: 'main',
  headRefOid: sha('a'),
  mergeCommit: merge ? { oid: merge } : null,
  mergedAt: `2026-11-${String(10 + n).padStart(2, '0')}T08:00:00Z`,
  additions: 3,
  deletions: 1,
});
const payload = {
  requestId: '00000000-0000-4000-8000-000000000001',
  replayId: '00000000-0000-4000-8000-000000000003',
  repoId: '00000000-0000-4000-8000-000000000002',
  remoteUrlNormalized: 'github.com/acme/web',
  limit: 50,
};

describe('listMergedChanges (AC1)', () => {
  it('parses gh json, drops rows without a merge commit and sorts newest first', async () => {
    const out = JSON.stringify([row(1, sha('b')), row(2, null), row(3, sha('c'))]);
    const forgeEnv = env(new FakeExec([[/gh pr list .*--state merged/, { stdout: out }]]));
    const r = await listMergedPrs({ payload, remoteUrl: 'https://github.com/acme/web.git', forgeEnv });
    expect(RepoListMergedPrsResultSchema.safeParse(r).success).toBe(true);
    if (!r.ok) throw new Error('not ok');
    expect(r.changes.map((c) => c.id)).toEqual(['3', '1']);
    expect(r.changes[0]).toMatchObject({ mergeCommitSha: sha('c'), author: 'octo', additions: 3 });
    const direct = await new GitHubForge(forgeEnv).listMergedChanges(repo, 50);
    expect(direct).toHaveLength(2);
  });
  it('answers without a clone, without gh, and for an unsupported host', async () => {
    expect(await listMergedPrs({ payload, remoteUrl: null, forgeEnv: env(new FakeExec()) })).toEqual({
      ok: false,
      reason: 'no_clone',
    });
    const r = await listMergedPrs({
      payload,
      remoteUrl: 'https://github.com/acme/web.git',
      forgeEnv: env(new FakeExec()),
    });
    expect(r).toMatchObject({ ok: false, reason: 'not_connected' });
    const other = await listMergedPrs({
      payload,
      remoteUrl: 'https://example.test/acme/web.git',
      forgeEnv: env(new FakeExec()),
    });
    expect(other.ok).toBe(false);
  });
});

const genv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@e.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@e.test',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: genv, encoding: 'utf8' }).trim();

describe('resolveReplayBase and an offline prepare (AC1)', () => {
  let base: string;
  let clone: string;
  let forkPoint: string;
  let head: string;
  let squash: string;
  let merge: string;
  let saved: string | undefined;
  beforeEach(() => {
    base = tmp();
    saved = process.env.AOM_AGENT_TMP_ROOT;
    process.env.AOM_AGENT_TMP_ROOT = join(base, 'agent-tmp');
    mkdirSync(process.env.AOM_AGENT_TMP_ROOT, { recursive: true });
    const bare = join(base, 'host.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', bare);
    const seed = join(base, 'seed');
    git(base, 'clone', '-q', bare, seed);
    writeFileSync(join(seed, 'a.txt'), 'base\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'base');
    forkPoint = git(seed, 'rev-parse', 'HEAD');
    git(seed, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(seed, 'a.txt'), 'changed\n');
    git(seed, 'commit', '-q', '-am', 'change');
    head = git(seed, 'rev-parse', 'HEAD');
    git(seed, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
    // main moves on, then the pull request is squash merged
    git(seed, 'checkout', '-q', 'main');
    writeFileSync(join(seed, 'b.txt'), 'other work\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'other');
    writeFileSync(join(seed, 'a.txt'), 'changed\n');
    git(seed, 'commit', '-q', '-am', 'squash of the pull request');
    squash = git(seed, 'rev-parse', 'HEAD');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    // a merge-commit merge of another pull request head
    git(seed, 'checkout', '-q', '-b', 'f2', forkPoint);
    writeFileSync(join(seed, 'c.txt'), 'c\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'c');
    git(seed, 'checkout', '-q', 'main');
    git(seed, 'merge', '-q', '--no-ff', '-m', 'merge', 'f2');
    merge = git(seed, 'rev-parse', 'HEAD');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    clone = join(base, 'clone');
    git(base, 'clone', '-q', bare, clone);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AOM_AGENT_TMP_ROOT;
    else process.env.AOM_AGENT_TMP_ROOT = saved;
  });

  it('the base of a squash merged pull request is where its branch left the base branch', async () => {
    const r = await resolveReplayBase({
      repoPath: clone,
      baseRef: 'main',
      prNumber: 7,
      headSha: head,
      mergeCommitSha: squash,
    });
    expect(r).toEqual({ headSha: head, baseSha: forkPoint });
  });
  it('the base of a merge-commit merge is the fork point of the merged branch', async () => {
    const f2 = git(clone, 'rev-parse', `${merge}^2`);
    const r = await resolveReplayBase({
      repoPath: clone,
      baseRef: 'main',
      prNumber: 8,
      headSha: f2,
      mergeCommitSha: merge,
    });
    expect(r.baseSha).toBe(forkPoint);
  });
  it('an offline prepare needs no token; the default still refuses without one', async () => {
    const REMOTE = 'github.com/acme/toy';
    const deps: ReviewerSandboxDeps = {
      paths: runnerPaths(join(base, 'runner')),
      tokens: new MemoryReviewerTokenStore(),
      findRepo: (n) => (n === REMOTE ? clone : undefined),
      sandboxState: { state: 'enforced', reason: 'test' },
      configDir: join(base, 'runner', 'agents', 'rev', 'claude'),
      agentId: 'rev',
    };
    const spec = {
      runId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
      projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c3',
      projectRepoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d4',
      remoteUrlNormalized: REMOTE,
      prNumber: 7,
      headSha: head,
      baseSha: forkPoint,
      baseRef: 'main',
    };
    expect(await prepareReviewerRun(deps, spec)).toEqual({ refused: 'reviewer_token_missing' });
    const run = await prepareReviewerRun(deps, spec, { requireToken: false });
    if ('refused' in run) throw new Error(`refused: ${run.refused}`);
    expect(git(run.checkout, 'rev-parse', 'HEAD')).toBe(head);
    await disposeReviewerRun(run);
  });
});
