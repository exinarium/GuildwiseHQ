import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReleaseDocsPrepPayload, ReleaseDocsPrepResult } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { runReleaseDocsPrep } from '../src/git/release-docs-prep.ts';
import type { DocsPrepExec, DocsPrepModelRequest } from '../src/git/release-docs-prep-steps.ts';
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
function setup(opts: { guide?: boolean; scripts?: boolean } = {}) {
  const repo = makeRepo();
  write(repo.clone, 'README.md', 'hello\n');
  if (opts.guide ?? true) write(repo.clone, 'docs/USER-GUIDE.md', GUIDE);
  if (opts.scripts) write(repo.clone, 'docs/guide/assemble-guide.mjs', '// assemble\n');
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

function fakeModel(proposal: unknown = PROPOSAL) {
  const calls: DocsPrepModelRequest[] = [];
  const runModel = async (req: DocsPrepModelRequest) => {
    calls.push(req);
    const file = /Write the JSON to (\S+)\./.exec(req.prompt)?.[1] as string;
    writeFileSync(file, JSON.stringify(proposal));
    return { ok: true as const };
  };
  return { calls, runModel };
}

function fakeExec(effect?: (cwd: string, args: string[]) => void, exitCode = 0) {
  const calls: string[][] = [];
  const exec: DocsPrepExec = async (cmd, args, { cwd }) => {
    calls.push([cmd, ...args]);
    effect?.(cwd, args);
    return { exitCode, stdout: '', stderr: exitCode ? 'boom' : '', timedOut: false };
  };
  return { calls, exec };
}

async function analyseThenGuide(
  s: S,
  m: ReturnType<typeof fakeModel>,
  e = fakeExec(),
  stepInput: Record<string, unknown> = {},
): Promise<{ analyse: ReleaseDocsPrepResult; guide: ReleaseDocsPrepResult }> {
  const analyse = await runReleaseDocsPrep({
    payload: payload(s),
    repoPath: s.repo.clone,
    integrationDir: s.integrationDir,
  });
  const guide = await runReleaseDocsPrep({
    payload: payload(s, {
      step: 'guide',
      ...(analyse.summary ? { summary: analyse.summary } : {}),
      stepInput,
    }),
    repoPath: s.repo.clone,
    integrationDir: s.integrationDir,
    runModel: m.runModel,
    exec: e.exec,
  });
  return { analyse, guide };
}

const workGuide = (s: S): string =>
  sh(s.repo.clone, 'git', ['show', `refs/guildwise/docs-prep/${RUN}/work:docs/USER-GUIDE.md`]);

describe("release prep step 'guide'", () => {
  it('updates the matching section, adds a numbered section and names them in the output', async () => {
    const s = setup();
    const m = fakeModel();
    const { guide } = await analyseThenGuide(s, m);
    expect(guide.state).toBe('passed');
    expect(guide.files).toEqual(['docs/USER-GUIDE.md']);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]?.prompt).toContain('card:GWP-89');
    expect(m.calls[0]?.prompt).toContain('apps/web/src/pages/Releases.tsx');
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
  });

  it('skips a repository without a user guide and passes, without a model call', async () => {
    const s = setup({ guide: false });
    const m = fakeModel();
    const { guide } = await analyseThenGuide(s, m);
    expect(guide.state).toBe('passed');
    expect(guide.files).toEqual([]);
    expect(guide.output).toMatchObject({ status: 'passed', skipped: 'no user guide' });
    expect(m.calls).toHaveLength(0);
  });

  it('does nothing when every change is covered by an earlier run', async () => {
    const s = setup();
    const m = fakeModel();
    const e = fakeExec();
    const { guide } = await analyseThenGuide(s, m, e, { coveredSources: ['card:GWP-89'] });
    expect(guide.state).toBe('passed');
    expect(guide.files).toEqual([]);
    expect(guide.output).toMatchObject({ nothing: 'no new changes' });
    expect(m.calls).toHaveLength(0);
    expect(e.calls).toHaveLength(0);
  });

  it('is idempotent: edits already in the guide change nothing', async () => {
    const s = setup();
    const first = await analyseThenGuide(s, fakeModel());
    expect(first.guide.files).toEqual(['docs/USER-GUIDE.md']);
    // the same proposal on the guide that already has it
    const md = workGuide(s);
    sh(s.repo.clone, 'git', ['checkout', '-q', 'release/1.5.0']);
    writeFileSync(join(s.repo.clone, 'docs/USER-GUIDE.md'), md);
    sh(s.repo.clone, 'git', ['commit', '-qam', 'docs: guide']);
    sh(s.repo.clone, 'git', ['push', '-q', 'origin', 'release/1.5.0']);
    sh(s.repo.clone, 'git', ['update-ref', '-d', `refs/guildwise/docs-prep/${RUN}/work`]);
    sh(s.repo.clone, 'git', ['update-ref', '-d', `refs/guildwise/docs-prep/${RUN}/start`]);
    const again = await analyseThenGuide(s, fakeModel());
    expect(again.guide.state).toBe('passed');
    expect(again.guide.files).toEqual([]);
    expect(again.guide.output).toMatchObject({ nothing: 'no guide change needed', duplicates: 2 });
  });

  it('runs twice on the same release with no further change (a second run is a no-op)', async () => {
    const s = setup();
    const m = fakeModel();
    const { analyse, guide } = await analyseThenGuide(s, m);
    expect(guide.files).toEqual(['docs/USER-GUIDE.md']);
    const work = sh(s.repo.clone, 'git', ['rev-parse', `refs/guildwise/docs-prep/${RUN}/work`]);
    // the step again (redelivered, or run again): it starts from its own kept work and the writer proposes the same edits
    const again = await runReleaseDocsPrep({
      payload: payload(s, { step: 'guide', ...(analyse.summary ? { summary: analyse.summary } : {}) }),
      repoPath: s.repo.clone,
      integrationDir: s.integrationDir,
      runModel: m.runModel,
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
    const m = fakeModel();
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
      runModel: m.runModel,
      exec: e.exec,
    });
    expect(commit.state).toBe('passed');
    expect(commit.notices).toContain('no changes');
    expect(commit.commit).toBeUndefined();
    expect(m.calls).toHaveLength(0);
    expect(e.calls).toHaveLength(0);
    expect(sh(s.repo.clone, 'git', ['show', 'origin/release/1.5.0:docs/USER-GUIDE.md'])).toBe(
      GUIDE.trimEnd(),
    );
    expect(sh(s.repo.clone, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('fails with the errors and writes nothing when the edits stay invalid after one repair', async () => {
    const s = setup();
    const m = fakeModel({ edits: [{ op: 'append', section: '9.9', text: 'x', sources: [] }] });
    const { guide } = await analyseThenGuide(s, m);
    expect(guide.state).toBe('failed');
    expect(guide.error).toMatch(/unknown section/);
    expect(m.calls).toHaveLength(2);
    expect((guide.output as { errors: string[] }).errors.join()).toMatch(/9\.9/);
  });

  it('rebuilds the PDF with the repository scripts and commits it with the text', async () => {
    const s = setup({ scripts: true });
    const e = fakeExec((cwd, args) => {
      if (String(args[0]).endsWith('assemble-guide.mjs'))
        writeFileSync(join(cwd, 'docs/guide/guide.html'), '<html/>');
    });
    const { guide } = await analyseThenGuide(s, fakeModel(), e);
    expect(guide.state).toBe('passed');
    expect([...guide.files].sort()).toEqual(['docs/USER-GUIDE.md', 'docs/guide/guide.html']);
    expect(guide.output).toMatchObject({ pdf: 'rebuilt' });
    expect(e.calls.map((c) => c.join(' '))).toContain('node docs/guide/assemble-guide.mjs');
  });

  it('fails when the PDF build fails or touches files outside the guide', async () => {
    const s = setup({ scripts: true });
    const bad = await analyseThenGuide(s, fakeModel(), fakeExec(undefined, 1));
    expect(bad.guide.state).toBe('failed');
    expect(bad.guide.error).toMatch(/PDF guide could not be built/);
    const s2 = setup({ scripts: true });
    const outside = await analyseThenGuide(
      s2,
      fakeModel(),
      fakeExec((cwd, args) => {
        if (String(args[0]).endsWith('assemble-guide.mjs')) writeFileSync(join(cwd, 'CHANGELOG.md'), 'x');
      }),
    );
    expect(outside.guide.state).toBe('failed');
    expect(outside.guide.error).toMatch(/changed CHANGELOG\.md/);
  });

  it('fails when the writer edits the repository itself', async () => {
    const s = setup();
    const runModel = async (req: DocsPrepModelRequest) => {
      writeFileSync(join(req.readDirs[0] as string, 'docs/USER-GUIDE.md'), 'oops');
      return { ok: true as const };
    };
    const { guide } = await analyseThenGuide(s, { calls: [], runModel });
    expect(guide.state).toBe('failed');
    expect(guide.error).toMatch(/writer changed files/);
  });

  it('fails clearly when no model is available on this runner', async () => {
    const s = setup();
    const analyse = await runReleaseDocsPrep({
      payload: payload(s),
      repoPath: s.repo.clone,
      integrationDir: s.integrationDir,
    });
    const guide = await runReleaseDocsPrep({
      payload: payload(s, { step: 'guide', ...(analyse.summary ? { summary: analyse.summary } : {}) }),
      repoPath: s.repo.clone,
      integrationDir: s.integrationDir,
    });
    expect(guide.state).toBe('failed');
    expect(guide.error).toMatch(/no agent on this workstation/);
    expect(readFileSync(join(s.repo.clone, 'docs/USER-GUIDE.md'), 'utf8')).toBe(GUIDE);
  });
});
