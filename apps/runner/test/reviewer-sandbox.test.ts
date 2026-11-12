import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ReviewerRunSpec, ReviewerRunSpecSchema } from '@aom/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentEnv } from '../src/adapters/claude-policy.ts';
import { runnerPaths } from '../src/paths.ts';
import { ReviewHeadMovedError } from '../src/review/review-checkout.ts';
import {
  disposeReviewerRun,
  prepareReviewerRun,
  type ReviewerRun,
  type ReviewerSandboxDeps,
  reviewerPolicy,
  sweepReviewRuns,
} from '../src/review/reviewer-sandbox.ts';
import { MemoryReviewerTokenStore } from '../src/review/reviewer-tokens.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const REMOTE = 'github.com/acme/toy';
const FAKE_TOKEN = 'github_pat_FAKE_reviewer_0123456789';
const RUN_A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const RUN_B = '019e3f6a-7b1c-7a2d-8c3e-0123456789b2';
const root = process.getuid?.() === 0;

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
/** git that is expected to fail: returns the exit code. */
const gitFails = (cwd: string, ...args: string[]) =>
  spawnSync('git', args, { cwd, env, encoding: 'utf8' }).status;
const refs = (dir: string) => git(dir, 'for-each-ref');

interface Fixture {
  base: string;
  bare: string;
  clone: string;
  headSha: string;
  baseSha: string;
  deps: ReviewerSandboxDeps;
  spec: (runId: string, over?: Partial<ReviewerRunSpec>) => ReviewerRunSpec;
}

let savedTmpRoot: string | undefined;
let fx: Fixture;
const prepared: ReviewerRun[] = [];

beforeEach(() => {
  const base = tmp();
  savedTmpRoot = process.env.AOM_AGENT_TMP_ROOT;
  process.env.AOM_AGENT_TMP_ROOT = join(base, 'agent-tmp');
  mkdirSync(process.env.AOM_AGENT_TMP_ROOT, { recursive: true });
  // the fake git host: a bare repository with `main` and a pull request ref
  const bare = join(base, 'host.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = join(base, 'seed');
  git(base, 'clone', '-q', bare, seed);
  writeFileSync(join(seed, 'a.txt'), 'base\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'base');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  const baseSha = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(seed, 'a.txt'), 'changed by the pull request\n');
  git(seed, 'commit', '-q', '-am', 'the change');
  const headSha = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
  // the owner's clone of it
  const clone = join(base, 'clone');
  git(base, 'clone', '-q', bare, clone);
  const paths = runnerPaths(join(base, 'runner'));
  const tokens = new MemoryReviewerTokenStore();
  tokens.set(REMOTE, FAKE_TOKEN);
  const deps: ReviewerSandboxDeps = {
    paths,
    tokens,
    findRepo: (n) => (n === REMOTE ? clone : undefined),
    sandboxState: { state: 'enforced', reason: 'test' },
    configDir: join(base, 'runner', 'agents', 'rev', 'claude'),
    agentId: 'rev',
  };
  const spec = (runId: string, over: Partial<ReviewerRunSpec> = {}): ReviewerRunSpec => ({
    runId,
    projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c3',
    projectRepoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d4',
    remoteUrlNormalized: REMOTE,
    prNumber: 7,
    headSha,
    baseSha,
    baseRef: 'main',
    ...over,
  });
  fx = { base, bare, clone, headSha, baseSha, deps, spec };
});

afterEach(async () => {
  for (const r of prepared.splice(0)) await disposeReviewerRun(r);
  if (savedTmpRoot === undefined) delete process.env.AOM_AGENT_TMP_ROOT;
  else process.env.AOM_AGENT_TMP_ROOT = savedTmpRoot;
});

async function start(runId: string, over: Partial<ReviewerRunSpec> = {}): Promise<ReviewerRun> {
  const r = await prepareReviewerRun(fx.deps, fx.spec(runId, over));
  if ('refused' in r) throw new Error(`refused: ${r.refused}`);
  prepared.push(r);
  return r;
}

describe('AC1: a reviewer run cannot change the checkout or the repository', () => {
  it('the checkout is the pull request head, standalone, with no remote and no credential configuration', async () => {
    const run = await start(RUN_A);
    expect(git(run.checkout, 'rev-parse', 'HEAD')).toBe(fx.headSha);
    expect(readFileSync(join(run.checkout, 'a.txt'), 'utf8')).toBe('changed by the pull request\n');
    expect(git(run.checkout, 'rev-parse', 'refs/review/base')).toBe(fx.baseSha);
    expect(git(run.checkout, 'diff', '--stat', 'refs/review/base...HEAD')).toContain('a.txt');
    expect(git(run.checkout, 'remote', '-v')).toBe('');
    expect(git(run.checkout, 'rev-parse', '--git-dir')).toBe('.git');
    const config = readFileSync(join(run.checkout, '.git', 'config'), 'utf8');
    expect(config).not.toMatch(/url|credential|includeIf|helper|extraheader/i);
    // the private refs in the owner's clone are gone again
    expect(refs(fx.clone)).not.toContain('refs/guildwise');
  });

  it.skipIf(root)('writing to the checkout fails, and so do git add and git commit', async () => {
    const run = await start(RUN_A);
    expect(() => writeFileSync(join(run.checkout, 'a.txt'), 'hacked')).toThrow(/EACCES|EPERM|EROFS/);
    expect(() => writeFileSync(join(run.checkout, 'new.txt'), 'x')).toThrow(/EACCES|EPERM|EROFS/);
    expect(() => writeFileSync(join(run.checkout, '.git', 'HEAD'), 'x')).toThrow(/EACCES|EPERM|EROFS/);
    expect(gitFails(run.checkout, 'add', 'a.txt')).not.toBe(0);
    expect(gitFails(run.checkout, 'commit', '-q', '--allow-empty', '-m', 'x')).not.toBe(0);
    expect(readFileSync(join(run.checkout, 'a.txt'), 'utf8')).toBe('changed by the pull request\n');
  });

  it('a push has nowhere to go, and nothing reaches the remote or the owner clone', async () => {
    const before = { host: refs(fx.bare), clone: refs(fx.clone) };
    const run = await start(RUN_A);
    expect(gitFails(run.checkout, 'push')).not.toBe(0);
    expect(gitFails(run.checkout, 'push', 'origin', 'HEAD:main')).not.toBe(0);
    // (a push to an explicit url is stopped by the sandbox, not by git: see the policy test below)
    expect(refs(fx.bare)).toBe(before.host);
    expect(refs(fx.clone)).toBe(before.clone);
  });

  it('the shell policy: checkout read-only, no network, push denied, the token nowhere', async () => {
    const run = await start(RUN_A);
    const base = {
      runnerRoot: fx.deps.paths.root,
      agentDir: fx.deps.paths.agentDir('rev'),
      cwd: fx.deps.paths.root,
      addDirs: ['/somewhere/else'],
      gitDirs: [fx.clone],
      readDirs: [fx.clone],
      aomReadPaths: [],
      realHome: join(fx.base, 'home'),
      mode: 'required' as const,
      extraAllowedDomains: ['example.com'],
    };
    const { ctx, settings } = reviewerPolicy(run, base);
    expect(ctx.cwd).toBe(run.checkout);
    expect(ctx.gitDirs).toEqual([]);
    expect(ctx.addDirs).toEqual([]);
    const sb = settings.sandbox;
    expect(sb?.network.allowedDomains).toEqual([]);
    expect(sb?.filesystem.denyWrite).toContain(run.checkout);
    expect(sb?.filesystem.allowWrite).toEqual([run.sandbox.home, run.sandbox.scratch, run.sandbox.tmp]);
    expect(settings.permissions.deny).toContain('Bash(git push:*)');
    expect(settings.permissions.allow).not.toContain(`Edit(${run.checkout}/**)`);
    // the agent's environment holds no token or git credential variable
    const agent = agentEnv(
      { HOME: run.sandbox.home },
      {},
      { PATH: '/usr/bin', GH_TOKEN: FAKE_TOKEN, GITHUB_TOKEN: FAKE_TOKEN },
    );
    expect(Object.keys(agent)).not.toEqual(expect.arrayContaining(['GH_TOKEN']));
    expect(JSON.stringify(settings) + JSON.stringify(agent)).not.toContain(FAKE_TOKEN);
  });

  it('a pull request that moved since the run was queued is refused and leaves nothing behind', async () => {
    const wrong = '0'.repeat(40);
    await expect(prepareReviewerRun(fx.deps, fx.spec(RUN_A, { headSha: wrong }))).rejects.toBeInstanceOf(
      ReviewHeadMovedError,
    );
    expect(existsSync(join(fx.deps.paths.reviews, RUN_A))).toBe(false);
    expect(refs(fx.clone)).not.toContain('refs/guildwise');
  });
});

describe('AC4 (runner backstop): no token, no run', () => {
  it('refuses before anything is created', async () => {
    fx.deps.tokens.remove(REMOTE);
    const r = await prepareReviewerRun(fx.deps, fx.spec(RUN_A));
    expect(r).toEqual({ refused: 'reviewer_token_missing' });
    expect(existsSync(fx.deps.paths.reviews)).toBe(false);
    expect(readdirSync(process.env.AOM_AGENT_TMP_ROOT as string)).toEqual([]);
  });

  it('refuses an unsandboxed shift, a non-GitHub host and a missing clone', async () => {
    fx.deps.sandboxState = { state: 'unsandboxed', reason: 'off' };
    expect(await prepareReviewerRun(fx.deps, fx.spec(RUN_A))).toEqual({ refused: 'sandbox_unavailable' });
    fx.deps.sandboxState = { state: 'enforced', reason: 'ok' };
    fx.deps.tokens.set('gitlab.com/acme/toy', FAKE_TOKEN);
    expect(
      await prepareReviewerRun(fx.deps, fx.spec(RUN_A, { remoteUrlNormalized: 'gitlab.com/acme/toy' })),
    ).toEqual({ refused: 'unsupported_host' });
    fx.deps.findRepo = () => undefined;
    expect(await prepareReviewerRun(fx.deps, fx.spec(RUN_A))).toEqual({ refused: 'no_clone' });
    expect(existsSync(fx.deps.paths.reviews)).toBe(false);
  });
});

describe('AC5: every run starts from a fresh checkout', () => {
  it('nothing an earlier run left is visible to the next one', async () => {
    const first = await start(RUN_A);
    for (const d of [first.sandbox.scratch, first.sandbox.home, first.sandbox.tmp])
      writeFileSync(join(d, 'leftover.txt'), 'from run one');
    const firstDirs = [first.runDir, first.sandbox.tmp];
    await disposeReviewerRun(first);
    prepared.length = 0;
    for (const d of firstDirs) expect(existsSync(d)).toBe(false);

    const second = await start(RUN_B);
    expect(second.runDir).not.toBe(first.runDir);
    expect(second.sandbox.tmp).not.toBe(first.sandbox.tmp);
    for (const d of [second.checkout, second.sandbox.scratch, second.sandbox.home, second.sandbox.tmp])
      expect(existsSync(join(d, 'leftover.txt'))).toBe(false);
    expect(readdirSync(second.sandbox.scratch)).toEqual([]);
  });

  it('two runs at once do not share a folder', async () => {
    const a = await start(RUN_A);
    const b = await start(RUN_B);
    expect(new Set([a.runDir, b.runDir, a.sandbox.tmp, b.sandbox.tmp]).size).toBe(4);
  });

  it('the startup sweep removes the folders of a run that never ended, and keeps a live one', async () => {
    const live = await start(RUN_A);
    const orphan = join(fx.deps.paths.reviews, RUN_B);
    mkdirSync(join(orphan, 'checkout'), { recursive: true });
    writeFileSync(join(orphan, 'checkout', 'x'), 'x');
    const orphanTmp = join(process.env.AOM_AGENT_TMP_ROOT as string, 'aom-r-0123456789');
    mkdirSync(orphanTmp);
    const removed = await sweepReviewRuns(fx.deps.paths);
    expect(removed).toBe(2);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(orphanTmp)).toBe(false);
    expect(existsSync(live.checkout)).toBe(true);
    expect(existsSync(live.sandbox.tmp)).toBe(true);
  });
});

describe('the run payload carries no credential', () => {
  it('ReviewerRunSpec refuses a token key', () => {
    expect(ReviewerRunSpecSchema.safeParse(fx.spec(RUN_A)).success).toBe(true);
    expect(ReviewerRunSpecSchema.safeParse({ ...fx.spec(RUN_A), token: FAKE_TOKEN }).success).toBe(false);
  });
});
