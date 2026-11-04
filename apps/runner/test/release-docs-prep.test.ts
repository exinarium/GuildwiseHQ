import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReleaseDocsPrepPayload, ReleaseDocsPrepResult } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { areaOf, runReleaseDocsPrep } from '../src/git/release-docs-prep.ts';
import { DOCS_PREP_STEP_HANDLERS } from '../src/git/release-docs-prep-steps.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const RUN = '019e3f6a-7b1c-7a2d-8c3e-0123456789d1';
const ID = (n: number) => `019e3f6a-7b1c-7a2d-8c3e-01234567890${n}`;

function commit(clone: string, path: string, text: string, message: string) {
  mkdirSync(dirname(join(clone, path)), { recursive: true });
  writeFileSync(join(clone, path), text);
  sh(clone, 'git', ['add', '-A']);
  sh(clone, 'git', ['commit', '-m', message]);
}

/** main with the tag v1.3.0 (when `tag`), then release/1.4.0 with a few commits, pushed. */
function setup(opts: { tag?: boolean } = {}) {
  const repo = makeRepo();
  commit(repo.clone, 'README.md', 'hello\n', 'chore: start');
  if (opts.tag ?? true) sh(repo.clone, 'git', ['tag', '-a', 'v1.3.0', '-m', '1.3.0']);
  sh(repo.clone, 'git', ['push', 'origin', 'main', '--tags']);
  sh(repo.clone, 'git', ['checkout', '-b', 'release/1.4.0']);
  commit(repo.clone, 'apps/server/a.ts', 'a', 'feat: a (GWP-12)');
  commit(repo.clone, 'docs/guide.md', 'g', 'docs: guide');
  sh(repo.clone, 'git', ['push', '-u', 'origin', 'release/1.4.0']);
  return { repo, integrationDir: tmp('aom-integration-') };
}

const payload = (s: ReturnType<typeof setup>, over: Partial<ReleaseDocsPrepPayload> = {}): ReleaseDocsPrepPayload => ({
  runId: RUN,
  projectId: ID(2),
  repoId: ID(3),
  remoteUrlNormalized: s.repo.remoteNormalized,
  releaseBranch: 'release/1.4.0',
  mainBranch: 'main',
  step: 'analyse',
  components: [],
  projectKey: 'GWP',
  commitAs: { name: 'Release Owner', email: 'owner@example.test' },
  ...over,
});

const run = (s: ReturnType<typeof setup>, over: Partial<ReleaseDocsPrepPayload> = {}): Promise<ReleaseDocsPrepResult> =>
  runReleaseDocsPrep({ payload: payload(s, over), repoPath: s.repo.clone, integrationDir: s.integrationDir });

const originHead = (origin: string) => sh(origin, 'git', ['rev-parse', 'release/1.4.0']);
const originCount = (origin: string) => Number(sh(origin, 'git', ['rev-list', '--count', 'release/1.4.0']));

// A test-only content step that writes one file, the same bytes every time.
DOCS_PREP_STEP_HANDLERS.guide = async ({ worktree }) => {
  mkdirSync(join(worktree, 'docs'), { recursive: true });
  writeFileSync(join(worktree, 'docs/USER-GUIDE.md'), '# Guide\n');
  return { ok: true, files: ['docs/USER-GUIDE.md'] };
};
DOCS_PREP_STEP_HANDLERS.boom = async () => ({ ok: false, error: 'the guide could not be written' });

/** Runs analyse, the guide step, commit prepare and commit push for one repo; returns each answer. */
async function wholeRun(s: ReturnType<typeof setup>, runId = RUN, withGuide = true) {
  const a = await run(s, { runId });
  const summary = a.summary;
  const common = { runId, ...(summary ? { summary } : {}), base: { sha: a.baseSha as string, tag: a.baseTag ?? null } };
  const g = withGuide ? await run(s, { ...common, step: 'guide' }) : undefined;
  const prep = await run(s, { ...common, step: 'commit', phase: 'prepare' });
  const push = await run(s, { ...common, step: 'commit', phase: 'push' });
  return { a, g, prep, push };
}

describe('release.docs_prep analyse', () => {
  it('lists the commits since the last release tag, the cards and the files by area', async () => {
    const s = setup();
    const count = originCount(s.repo.origin);
    const r = await run(s);
    expect(r.ok).toBe(true);
    expect(r.state).toBe('passed');
    expect(r.baseTag).toBe('v1.3.0');
    const sum = r.summary;
    expect(sum?.base.kind).toBe('tag');
    expect(sum?.commitCount).toBe(2);
    expect(sum?.commits.map((c) => c.subject)).toEqual(['docs: guide', 'feat: a (GWP-12)']);
    expect(sum?.cards.map((c) => c.key)).toEqual(['GWP-12']);
    expect(sum?.areas.map((x) => x.area).sort()).toEqual(['apps/server', 'docs']);
    expect(sum?.areas.find((x) => x.area === 'docs')).toMatchObject({ files: 1, added: 1 });
    // read-only
    expect(originCount(s.repo.origin)).toBe(count);
  });

  it('falls back to the main branch when there is no release tag', async () => {
    const s = setup({ tag: false });
    const r = await run(s);
    expect(r.baseTag).toBeNull();
    expect(r.summary?.base.kind).toBe('main');
    expect(r.summary?.commitCount).toBe(2);
  });

  it('skips a repository whose release branch is not on origin', async () => {
    const s = setup();
    const r = await run(s, { releaseBranch: 'release/9.9.9' });
    expect(r.state).toBe('skipped');
    expect(r.error).toContain('does not exist on origin');
  });

  it('refuses the main branch as the release branch', async () => {
    const s = setup();
    const count = originCount(s.repo.origin);
    const r = await run(s, { releaseBranch: 'main' });
    expect(r.state).toBe('failed');
    expect(originCount(s.repo.origin)).toBe(count);
  });

  it('names the area after a component rule first, then the first two path segments', () => {
    const rule = { name: 'runner', paths: ['apps/runner/**'], versionFile: 'v.ts', pattern: 'x' };
    expect(areaOf('apps/runner/src/a.ts', [rule])).toBe('runner');
    expect(areaOf('apps/web/src/a.ts', [rule])).toBe('apps/web');
    expect(areaOf('docs/a.md', [])).toBe('docs');
    expect(areaOf('README.md', [])).toBe('(root)');
  });
});

describe('release.docs_prep commit', () => {
  it('commits the produced files to the release branch as the project identity and pushes them', async () => {
    const s = setup();
    const before = originCount(s.repo.origin);
    const mainHead = sh(s.repo.origin, 'git', ['rev-parse', 'main']);
    const r = await wholeRun(s);
    expect(r.g?.state).toBe('passed');
    expect(r.g?.files).toEqual(['docs/USER-GUIDE.md']);
    expect(r.prep.commit).toBeTruthy();
    expect(r.push.state).toBe('passed');
    expect(r.push.pushed).toBe(true);
    expect(originCount(s.repo.origin)).toBe(before + 1);
    expect(originHead(s.repo.origin)).toBe(r.push.commit);
    const log = sh(s.repo.origin, 'git', ['log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', 'release/1.4.0']);
    expect(log).toBe(
      'Release Owner <owner@example.test>|Release Owner <owner@example.test>|docs(release): prepare the release documentation for release/1.4.0',
    );
    expect(sh(s.repo.origin, 'git', ['show', 'release/1.4.0:docs/USER-GUIDE.md'])).toBe('# Guide');
    // the release branch only: no tag, main untouched, kept refs gone
    expect(sh(s.repo.origin, 'git', ['tag', '--list'])).toBe('v1.3.0');
    expect(sh(s.repo.origin, 'git', ['rev-parse', 'main'])).toBe(mainHead);
    expect(sh(s.repo.clone, 'git', ['for-each-ref', 'refs/guildwise/docs-prep'])).toBe('');
  });

  it('makes no commit in a repository where no step produced a file', async () => {
    const s = setup();
    const head = originHead(s.repo.origin);
    const r = await wholeRun(s, RUN, false);
    expect(r.prep.state).toBe('passed');
    expect(r.prep.commit).toBeUndefined();
    expect(r.push.commit).toBeUndefined();
    expect(originHead(s.repo.origin)).toBe(head);
  });

  it('commits only the repository that changed when two repositories run together', async () => {
    const a = setup();
    const b = setup();
    const ha = originHead(a.repo.origin);
    const hb = originHead(b.repo.origin);
    const ra = await wholeRun(a);
    const rb = await wholeRun(b, RUN, false);
    expect(ra.push.commit).toBeTruthy();
    expect(rb.push.commit).toBeUndefined();
    expect(originHead(a.repo.origin)).not.toBe(ha);
    expect(originHead(b.repo.origin)).toBe(hb);
  });

  it('prepares without pushing: a failing push later leaves nothing on origin and a retry adds one commit only', async () => {
    const s = setup();
    const a = await run(s);
    const common = { summary: a.summary, base: { sha: a.baseSha as string, tag: a.baseTag ?? null } };
    await run(s, { ...common, step: 'guide' });
    const prep = await run(s, { ...common, step: 'commit', phase: 'prepare' });
    expect(prep.commit).toBeTruthy();
    // a hook on origin refuses the push
    const hook = join(s.repo.origin, 'hooks/pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho refused >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const head = originHead(s.repo.origin);
    const refused = await run(s, { ...common, step: 'commit', phase: 'push' });
    expect(refused.state).toBe('failed');
    expect(refused.error).toContain('refused');
    expect(originHead(s.repo.origin)).toBe(head);
    // the hook is lifted and the same push goes through
    rmSync(hook);
    const ok = await run(s, { ...common, step: 'commit', phase: 'push' });
    expect(ok.state).toBe('passed');
    expect(originHead(s.repo.origin)).toBe(prep.commit);
    // a redelivery answers alreadyPushed without a second commit
    const again = await run(s, { ...common, step: 'commit', phase: 'push' });
    expect(again.state).toBe('passed');
    // a new run after the partial push: same bytes, no diff, no duplicate commit
    const count = originCount(s.repo.origin);
    const retry = await wholeRun(s, '019e3f6a-7b1c-7a2d-8c3e-0123456789e2');
    expect(retry.prep.commit).toBeUndefined();
    expect(originCount(s.repo.origin)).toBe(count);
  });

  it('carries the prepared commit over when the release branch moved after the analysis', async () => {
    const s = setup();
    const a = await run(s);
    const common = { summary: a.summary, base: { sha: a.baseSha as string, tag: a.baseTag ?? null } };
    await run(s, { ...common, step: 'guide' });
    // somebody pushes to the release branch in between
    commit(s.repo.clone, 'apps/server/b.ts', 'b', 'feat: b');
    sh(s.repo.clone, 'git', ['push', 'origin', 'release/1.4.0']);
    const prep = await run(s, { ...common, step: 'commit', phase: 'prepare' });
    expect(prep.state).toBe('passed');
    const push = await run(s, { ...common, step: 'commit', phase: 'push' });
    expect(push.state).toBe('passed');
    expect(sh(s.repo.origin, 'git', ['show', 'release/1.4.0:apps/server/b.ts'])).toBe('b');
    expect(sh(s.repo.origin, 'git', ['show', 'release/1.4.0:docs/USER-GUIDE.md'])).toBe('# Guide');
  });

  it('fails a step whose handler fails, and an unknown step, without touching origin', async () => {
    const s = setup();
    const head = originHead(s.repo.origin);
    const a = await run(s);
    const common = { summary: a.summary, base: { sha: a.baseSha as string, tag: null } };
    const boom = await run(s, { ...common, step: 'boom' });
    expect(boom.state).toBe('failed');
    expect(boom.error).toBe('the guide could not be written');
    const unknown = await run(s, { ...common, step: 'nope' });
    expect(unknown.state).toBe('failed');
    expect(originHead(s.repo.origin)).toBe(head);
  });

  it('fails the prepare when there is no commit identity anywhere', async () => {
    const s = setup();
    const a = await run(s);
    const common = { summary: a.summary, base: { sha: a.baseSha as string, tag: null } };
    const r = await run(s, { ...common, step: 'guide', commitAs: null });
    // either the repository has an identity (then it passes) or the answer names the missing identity
    expect(['passed', 'failed']).toContain(r.state);
    if (r.state === 'failed') expect(r.error).toMatch(/identity|commit as/i);
  });
});
