import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReleaseDocsPrepPayload, ReleaseDocsPrepResult } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { runReleaseDocsPrep } from '../src/git/release-docs-prep.ts';
import type { DocsPrepExec } from '../src/git/release-docs-prep-steps.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const RUN = '019e3f6a-7b1c-7a2d-8c3e-0123456789e1';
const ID = (n: number) => `019e3f6a-7b1c-7a2d-8c3e-01234567890${n}`;

const GUIDE = [
  '# Guide',
  '',
  '<!-- toc -->',
  '**Contents**',
  '',
  '- [4. Delivery](#4-delivery)',
  '  - [4.28 Releases](#428-releases)',
  '  - [4.29 Metrics](#429-metrics)',
  '',
  '<!-- /toc -->',
  '',
  '## 4. Delivery',
  '',
  '### 4.28 Releases',
  '',
  'The **Releases** page lists each version.',
  '',
  '### 4.29 Metrics',
  '',
  'Charts of the work.',
  '',
].join('\n');

function write(clone: string, path: string, text: string) {
  mkdirSync(dirname(join(clone, path)), { recursive: true });
  writeFileSync(join(clone, path), text);
}

/** main (tagged), then release/1.5.0 with one merge of a feature branch that changes the Releases page. */
function setup(
  opts: {
    guide?: boolean;
    scripts?: boolean;
    build?: 'flags' | 'old';
    guideAt?: string;
    alsoDefault?: boolean;
  } = {},
) {
  const repo = makeRepo();
  write(repo.clone, 'README.md', 'hello\n');
  if (opts.guideAt) write(repo.clone, opts.guideAt, GUIDE);
  if ((opts.guide ?? true) && (!opts.guideAt || opts.alsoDefault))
    write(repo.clone, 'docs/USER-GUIDE.md', GUIDE);
  if (opts.scripts) write(repo.clone, 'docs/guide/assemble-guide.mjs', '// assemble\n');
  if (opts.build)
    write(
      repo.clone,
      'docs/guide/build-guide.mjs',
      opts.build === 'flags' ? "// takes '--date' and '--edition'\n" : '// takes --out only\n',
    );
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', 'chore: start']);
  sh(repo.clone, 'git', ['tag', '-a', 'v1.4.0', '-m', '1.4.0']);
  sh(repo.clone, 'git', ['push', 'origin', 'main', '--tags']);
  sh(repo.clone, 'git', ['checkout', '-b', 'release/1.5.0']);
  sh(repo.clone, 'git', ['checkout', '-b', 'feature']);
  write(repo.clone, 'apps/web/src/pages/Releases.tsx', 'export {}\n');
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', 'feat: release prep on the Releases page']);
  sh(repo.clone, 'git', ['checkout', 'release/1.5.0']);
  sh(repo.clone, 'git', ['merge', '--no-ff', 'feature', '-m', 'Merge GWP-89 release prep']);
  sh(repo.clone, 'git', ['push', '-u', 'origin', 'release/1.5.0']);
  return { repo, integrationDir: tmp('aom-integration-') };
}

type S = ReturnType<typeof setup>;

const payload = (s: S, over: Partial<ReleaseDocsPrepPayload> = {}): ReleaseDocsPrepPayload => ({
  runId: RUN,
  projectId: ID(2),
  repoId: ID(3),
  remoteUrlNormalized: s.repo.remoteNormalized,
  releaseBranch: 'release/1.5.0',
  mainBranch: 'main',
  step: 'analyse',
  components: [],
  projectKey: 'GWP',
  commitAs: { name: 'Release Owner', email: 'owner@example.test' },
  ...over,
});

const PROPOSAL = {
  edits: [
    {
      op: 'append',
      section: '4.28',
      text: '**Release prep.** Run release prep before you approve a release.',
      sources: ['card:GWP-89'],
    },
    {
      op: 'add_section',
      after: '4.28',
      title: 'Release prep',
      body: 'Release prep runs before the ship.',
      sources: ['card:GWP-89'],
    },
  ],
  covered: [],
  skipped: [],
  notes: [],
};

function fakeExec(effect?: (cwd: string, args: string[]) => void, exitCode = 0) {
  const calls: string[][] = [];
  const exec: DocsPrepExec = async (cmd, args, { cwd }) => {
    calls.push([cmd, ...args]);
    effect?.(cwd, args);
    return { exitCode, stdout: '', stderr: exitCode ? 'boom' : '', timedOut: false };
  };
  return { calls, exec };
}

type Phased = {
  analyse: ReleaseDocsPrepResult;
  check: ReleaseDocsPrepResult;
  guide: ReleaseDocsPrepResult;
};

/** analyse, then the guide `check` phase, then the guide `apply` phase with the writer's proposal as its input. */
async function analyseThenGuide(
  s: S,
  proposal: unknown = PROPOSAL,
  e = fakeExec(),
  stepInput: Record<string, unknown> = {},
): Promise<Phased> {
  const analyse = await runReleaseDocsPrep({
    payload: payload(s),
    repoPath: s.repo.clone,
    integrationDir: s.integrationDir,
  });
  const base = { step: 'guide', ...(analyse.summary ? { summary: analyse.summary } : {}), stepInput };
  const check = await runReleaseDocsPrep({
    payload: payload(s, { ...base, phase: 'check' }),
    repoPath: s.repo.clone,
    integrationDir: s.integrationDir,
    exec: e.exec,
  });
  const guide = await runReleaseDocsPrep({
    payload: payload(s, { ...base, phase: 'apply', ...(proposal === null ? {} : { input: { proposal } }) }),
    repoPath: s.repo.clone,
    integrationDir: s.integrationDir,
    exec: e.exec,
  });
  return { analyse, check, guide };
}

const workGuide = (s: S): string =>
  sh(s.repo.clone, 'git', ['show', `refs/guildwise/docs-prep/${RUN}/work:docs/USER-GUIDE.md`]);

describe("release prep step 'guide'", () => {
  it('check reports the uncovered changes with the sections that describe them, and writes nothing', async () => {
    const s = setup();
    const { check } = await analyseThenGuide(s);
    expect(check.state).toBe('passed');
    expect(check.files).toEqual([]);
    const report = check.report as {
      guidePath: string;
      changes: { sources: string[]; files: string[]; hints: { section: string }[] }[];
    };
    expect(report.guidePath).toBe('docs/USER-GUIDE.md');
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]?.sources).toEqual(['card:GWP-89']);
    expect(report.changes[0]?.files).toContain('apps/web/src/pages/Releases.tsx');
    expect(report.changes[0]?.hints.map((h) => h.section)).toContain('4.28 Releases');
    expect(sh(s.repo.clone, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('apply updates the matching section, adds a numbered section and names them in the output', async () => {
    const s = setup();
    const { guide } = await analyseThenGuide(s);
    expect(guide.state).toBe('passed');
    expect(guide.files).toEqual(['docs/USER-GUIDE.md']);
    expect(guide.output).toMatchObject({
      status: 'passed',
      changed: [{ section: '4.28 Releases', sources: ['card:GWP-89'] }],
      added: [{ section: '4.28a Release prep', after: '4.28 Releases', sources: ['card:GWP-89'] }],
      pdf: 'no PDF build',
    });
    const md = workGuide(s);
    expect(md).toContain('### 4.28a Release prep');
    expect(md).toContain('  - [4.28a Release prep](#428a-release-prep)');
    expect(md.indexOf('### 4.28a')).toBeLessThan(md.indexOf('### 4.29'));
    // the handler does not commit on the release branch
    expect(sh(s.repo.clone, 'git', ['rev-parse', 'release/1.5.0'])).toBe(
      sh(s.repo.clone, 'git', ['rev-parse', 'origin/release/1.5.0']),
    );
    // the work commit keeps the step's label and the owner's identity
    const work = `refs/guildwise/docs-prep/${RUN}/work`;
    expect(sh(s.repo.clone, 'git', ['log', '-1', '--format=%s|%an <%ae>', work])).toBe(
      'docs(release): guide|Release Owner <owner@example.test>',
    );
  });

  it('a repository without a user guide is skipped (not passed) by the first phase and needs no writer', async () => {
    const s = setup({ guide: false });
    const { check } = await analyseThenGuide(s, null);
    expect(check.ok).toBe(true);
    expect(check.state).toBe('skipped');
    expect(check.error).toBe('skipped: no user guide in this repository');
    expect(check.files).toEqual([]);
    expect(check.output).toMatchObject({ status: 'passed', skipped: 'no user guide' });
  });

  it('check with every change covered by an earlier run has nothing to write', async () => {
    const s = setup();
    const e = fakeExec();
    const { check, guide } = await analyseThenGuide(s, null, e, { coveredSources: ['card:GWP-89'] });
    expect(check.state).toBe('passed');
    expect(check.report).toEqual({ changes: [] });
    expect(guide.state).toBe('passed');
    expect(guide.files).toEqual([]);
    expect(guide.output).toMatchObject({ nothing: 'no new changes' });
    expect(e.calls).toHaveLength(0);
  });

  it('apply with no proposal passes with "no new changes" and builds nothing', async () => {
    const s = setup({ scripts: true });
    const e = fakeExec();
    const { guide } = await analyseThenGuide(s, null, e);
    expect(guide.state).toBe('passed');
    expect(guide.output).toMatchObject({ nothing: 'no new changes' });
    expect(e.calls).toHaveLength(0);
  });

  it('the legacy single phase fails with "needs a newer server"', async () => {
    const s = setup();
    const analyse = await runReleaseDocsPrep({
      payload: payload(s),
      repoPath: s.repo.clone,
      integrationDir: s.integrationDir,
    });
    const r = await runReleaseDocsPrep({
      payload: payload(s, { step: 'guide', ...(analyse.summary ? { summary: analyse.summary } : {}) }),
      repoPath: s.repo.clone,
      integrationDir: s.integrationDir,
    });
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/needs a newer server for Update user guide/);
  });

  it('is idempotent: edits already in the guide change nothing', async () => {
    const s = setup();
    const first = await analyseThenGuide(s);
    expect(first.guide.files).toEqual(['docs/USER-GUIDE.md']);
    // the same proposal on the guide that already has it
    const md = workGuide(s);
    sh(s.repo.clone, 'git', ['checkout', '-q', 'release/1.5.0']);
    writeFileSync(join(s.repo.clone, 'docs/USER-GUIDE.md'), md);
    sh(s.repo.clone, 'git', ['commit', '-qam', 'docs: guide']);
    sh(s.repo.clone, 'git', ['push', '-q', 'origin', 'release/1.5.0']);
    sh(s.repo.clone, 'git', ['update-ref', '-d', `refs/guildwise/docs-prep/${RUN}/work`]);
    sh(s.repo.clone, 'git', ['update-ref', '-d', `refs/guildwise/docs-prep/${RUN}/start`]);
    const again = await analyseThenGuide(s);
    expect(again.guide.state).toBe('passed');
    expect(again.guide.files).toEqual([]);
    expect(again.guide.output).toMatchObject({ nothing: 'no guide change needed', duplicates: 2 });
  });

  it('runs twice on the same release with no further change (a second run is a no-op)', async () => {
    const s = setup();
    const { analyse, guide } = await analyseThenGuide(s);
    expect(guide.files).toEqual(['docs/USER-GUIDE.md']);
    const work = sh(s.repo.clone, 'git', ['rev-parse', `refs/guildwise/docs-prep/${RUN}/work`]);
    // the apply phase again (redelivered, or run again): it starts from its own kept work with the same proposal
    const again = await runReleaseDocsPrep({
      payload: payload(s, {
        step: 'guide',
        phase: 'apply',
        input: { proposal: PROPOSAL },
        ...(analyse.summary ? { summary: analyse.summary } : {}),
      }),
      repoPath: s.repo.clone,
      integrationDir: s.integrationDir,
      exec: fakeExec().exec,
    });
    expect(again.state).toBe('passed');
    expect(again.files).toEqual([]);
    expect(again.output).toMatchObject({ nothing: 'no guide change needed', changed: [], added: [] });
    expect(sh(s.repo.clone, 'git', ['rev-parse', `refs/guildwise/docs-prep/${RUN}/work`])).toBe(work);
    // the commit step squashes one guide change, not two
    const commit = await runReleaseDocsPrep({
      payload: payload(s, {
        step: 'commit',
        phase: 'prepare',
        ...(analyse.summary ? { summary: analyse.summary } : {}),
      }),
      repoPath: s.repo.clone,
      integrationDir: s.integrationDir,
    });
    expect(commit.state).toBe('passed');
    expect(commit.files).toEqual(['docs/USER-GUIDE.md']);
    const md = sh(s.repo.clone, 'git', ['show', `${commit.commit}:docs/USER-GUIDE.md`]);
    expect(md.match(/### 4\.28a Release prep/g)).toHaveLength(1);
    expect(md.match(/\*\*Release prep\.\*\*/g)).toHaveLength(1);
  });

  it('with the step not ticked, a run (analyse and commit only) leaves the guide untouched', async () => {
    const s = setup({ scripts: true });
    const e = fakeExec();
    // the server dispatches only the ticked steps: here 'analyse' and 'commit', never 'guide'
    const analyse = await runReleaseDocsPrep({
      payload: payload(s),
      repoPath: s.repo.clone,
      integrationDir: s.integrationDir,
    });
    const commit = await runReleaseDocsPrep({
      payload: payload(s, {
        step: 'commit',
        phase: 'prepare',
        ...(analyse.summary ? { summary: analyse.summary } : {}),
      }),
      repoPath: s.repo.clone,
      integrationDir: s.integrationDir,
      exec: e.exec,
    });
    expect(commit.state).toBe('passed');
    expect(commit.notices).toContain('no changes');
    expect(commit.commit).toBeUndefined();
    expect(e.calls).toHaveLength(0);
    expect(sh(s.repo.clone, 'git', ['show', 'origin/release/1.5.0:docs/USER-GUIDE.md'])).toBe(
      GUIDE.trimEnd(),
    );
    expect(sh(s.repo.clone, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('apply refuses edits that fail the guide checks and writes nothing', async () => {
    const s = setup();
    const { guide } = await analyseThenGuide(s, {
      edits: [{ op: 'append', section: '9.9', text: 'x', sources: [] }],
    });
    expect(guide.state).toBe('failed');
    expect(guide.error).toMatch(/the guide update was refused: .*unknown section/);
    expect((guide.output as { errors: string[] }).errors.join()).toMatch(/9\.9/);
    expect(readFileSync(join(s.repo.clone, 'docs/USER-GUIDE.md'), 'utf8')).toBe(GUIDE);
  });

  it('apply refuses a proposal that is not the expected shape', async () => {
    const s = setup();
    const { guide } = await analyseThenGuide(s, { edits: 'nope' });
    expect(guide.state).toBe('failed');
    expect(guide.error).toMatch(/guide proposal is not valid/);
  });

  it('rebuilds the PDF with the repository scripts and commits it with the text', async () => {
    const s = setup({ scripts: true });
    const e = fakeExec((cwd, args) => {
      if (String(args[0]).endsWith('assemble-guide.mjs'))
        writeFileSync(join(cwd, 'docs/guide/guide.html'), '<html/>');
    });
    const { guide } = await analyseThenGuide(s, PROPOSAL, e);
    expect(guide.state).toBe('passed');
    expect([...guide.files].sort()).toEqual(['docs/USER-GUIDE.md', 'docs/guide/guide.html']);
    expect(guide.output).toMatchObject({ pdf: 'rebuilt' });
    expect(e.calls.map((c) => c.join(' '))).toContain('node docs/guide/assemble-guide.mjs');
  });

  it('passes the run date and the release version to a build script that takes them', async () => {
    const s = setup({ scripts: true, build: 'flags' });
    const e = fakeExec();
    const { guide } = await analyseThenGuide(s, fakeModel(), e, {
      release: { version: '1.5.0', date: null, runDate: '2026-11-08' },
    });
    expect(guide.state).toBe('passed');
    expect(e.calls.map((c) => c.join(' '))).toContain(
      'node docs/guide/build-guide.mjs --date 2026-11-08 --edition 1.5.0',
    );
    expect(guide.output).toMatchObject({
      pdf: 'rebuilt',
      pdfDate: '2026-11-08',
      pdfDateSource: 'run',
      pdfEdition: '1.5.0',
    });
    expect((guide.output as { notes: string[] }).notes.join()).toMatch(/no date yet.*2026-11-08/);
  });

  it('passes the release date when the release has one, without a note', async () => {
    const s = setup({ scripts: true, build: 'flags' });
    const e = fakeExec();
    const { guide } = await analyseThenGuide(s, fakeModel(), e, {
      release: { version: null, date: '2026-12-01', runDate: '2026-11-08' },
    });
    expect(e.calls.map((c) => c.join(' '))).toContain('node docs/guide/build-guide.mjs --date 2026-12-01');
    expect(guide.output).toMatchObject({ pdfDate: '2026-12-01', pdfDateSource: 'release' });
    expect((guide.output as { notes: string[] }).notes.join()).not.toMatch(/no date yet/);
  });

  it('passes no flag to a build script that does not take them, and warns', async () => {
    const s = setup({ scripts: true, build: 'old' });
    const e = fakeExec();
    const { guide } = await analyseThenGuide(s, fakeModel(), e, {
      release: { version: '1.5.0', date: null, runDate: '2026-11-08' },
    });
    expect(e.calls.map((c) => c.join(' '))).toContain('node docs/guide/build-guide.mjs');
    const o = guide.output as { pdfDate?: string; warnings: string[] };
    expect(o.pdfDate).toBeUndefined();
    expect(o.warnings.join()).toMatch(/takes no --date/);
  });

  it('edits the configured guide and not docs/USER-GUIDE.md, and skips the PDF for another name', async () => {
    const s = setup({ scripts: true, build: 'flags', guideAt: 'docs/MANUAL.md', alsoDefault: true });
    const e = fakeExec();
    const { guide } = await analyseThenGuide(s, fakeModel(), e, {
      guidePath: 'docs/MANUAL.md',
      guidePathConfigured: true,
      repoName: 'GuildwiseHQ',
    });
    expect(guide.state).toBe('passed');
    expect(guide.files).toEqual(['docs/MANUAL.md']);
    expect(guide.output).toMatchObject({ pdf: 'no PDF build' });
    expect((guide.output as { notes: string[] }).notes.join()).toMatch(/not rebuilt.*MANUAL\.md/);
    expect(e.calls).toHaveLength(0);
  });

  it('fails naming the repository and path when the configured guide is missing', async () => {
    const s = setup();
    const { guide } = await analyseThenGuide(s, fakeModel(), fakeExec(), {
      guidePath: 'docs/guide/MANUAL.md',
      guidePathConfigured: true,
      repoName: 'GuildwiseHQ',
    });
    expect(guide.state).toBe('failed');
    expect(guide.error).toContain('docs/guide/MANUAL.md');
    expect(guide.error).toContain('GuildwiseHQ');
    expect(guide.error).toContain('release/1.5.0');
  });

  it('still skips a missing default guide when no path is configured', async () => {
    const s = setup({ guide: false });
    const { guide } = await analyseThenGuide(s, fakeModel(), fakeExec(), {
      guidePath: 'docs/USER-GUIDE.md',
      guidePathConfigured: false,
      repoName: 'GuildwiseHQ',
    });
    expect(guide.state).toBe('passed');
    expect(guide.output).toMatchObject({ skipped: 'no user guide' });
  });

  it('refuses a path outside the repository', async () => {
    const s = setup();
    const { guide } = await analyseThenGuide(s, fakeModel(), fakeExec(), {
      guidePath: '../x.md',
      guidePathConfigured: true,
    });
    expect(guide.state).toBe('failed');
    expect(guide.error).toMatch(/refusing the user guide path \.\.\/x\.md/);
  });

  it('refuses a guide that is a symlink to a file outside the worktree', async () => {
    const s = setup({ guide: false });
    const outside = join(tmp('aom-outside-'), 'x.md');
    writeFileSync(outside, GUIDE);
    symlinkSync(outside, join(s.repo.clone, 'docs-link.md'));
    sh(s.repo.clone, 'git', ['add', '-A']);
    sh(s.repo.clone, 'git', ['commit', '-m', 'link']);
    sh(s.repo.clone, 'git', ['push', 'origin', 'release/1.5.0']);
    const { guide } = await analyseThenGuide(s, fakeModel(), fakeExec(), {
      guidePath: 'docs-link.md',
      guidePathConfigured: true,
    });
    expect(guide.state).toBe('failed');
    expect(guide.error).toMatch(/points outside the repository/);
  });

  it('fails when the PDF build fails or touches files outside the guide', async () => {
    const s = setup({ scripts: true });
    const bad = await analyseThenGuide(s, PROPOSAL, fakeExec(undefined, 1));
    expect(bad.guide.state).toBe('failed');
    expect(bad.guide.error).toMatch(/PDF guide could not be built/);
    const s2 = setup({ scripts: true });
    const outside = await analyseThenGuide(
      s2,
      PROPOSAL,
      fakeExec((cwd, args) => {
        if (String(args[0]).endsWith('assemble-guide.mjs')) writeFileSync(join(cwd, 'CHANGELOG.md'), 'x');
      }),
    );
    expect(outside.guide.state).toBe('failed');
    expect(outside.guide.error).toMatch(/changed CHANGELOG\.md/);
  });
});
