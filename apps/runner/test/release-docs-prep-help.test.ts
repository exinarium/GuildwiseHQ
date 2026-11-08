import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  PREP_PROPOSAL_FILE,
  type ReleaseDocsPrepPayload,
  type ReleaseDocsPrepResult,
  type ReleasePrepShift,
} from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { runReleaseDocsPrep } from '../src/git/release-docs-prep.ts';
import { runHelpStep, safeHelpDir } from '../src/git/release-docs-prep-help.ts';
import { finishPrepProposal } from '../src/git/release-prep-proposal.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const RUN = '019e3f6a-7b1c-7a2d-8c3e-0123456789f1';
const ID = (n: number) => `019e3f6a-7b1c-7a2d-8c3e-01234567890${n}`;
const DIR = 'apps/web/src/help/articles';

const PHASES = [
  '---',
  'title: Phases and follow-ups',
  'summary: Phases and releases.',
  'keywords: [phase, release]',
  'order: 12',
  '---',
  '',
  'A **phase** is a slice of work.',
  '',
  '## Releases {#releases}',
  '',
  'The **Releases** page lists each version.',
  '',
  '## Notes',
  '',
  'Plain notes.',
  '',
].join('\n');

const BOARD = [
  '---',
  'title: Board and cards',
  'summary: The board.',
  'keywords: [board]',
  'order: 3',
  '---',
  '',
  '## Columns {#columns}',
  '',
  'The board has columns.',
  '',
].join('\n');

function write(clone: string, path: string, text: string) {
  mkdirSync(dirname(join(clone, path)), { recursive: true });
  writeFileSync(join(clone, path), text);
}

/** main (tagged), then release/1.5.0 with one merge that changes `changed` (default: the Releases page). */
function setup(opts: { help?: boolean; changed?: string } = {}) {
  const repo = makeRepo();
  write(repo.clone, 'README.md', 'hello\n');
  if (opts.help ?? true) {
    write(repo.clone, `${DIR}/phases.md`, PHASES);
    write(repo.clone, `${DIR}/board.md`, BOARD);
  }
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', 'chore: start']);
  sh(repo.clone, 'git', ['tag', '-a', 'v1.4.0', '-m', '1.4.0']);
  sh(repo.clone, 'git', ['push', 'origin', 'main', '--tags']);
  sh(repo.clone, 'git', ['checkout', '-b', 'release/1.5.0']);
  sh(repo.clone, 'git', ['checkout', '-b', 'feature']);
  write(repo.clone, opts.changed ?? 'apps/web/src/pages/Releases.tsx', 'export {}\n');
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', [
    'commit',
    '-m',
    opts.changed?.startsWith('apps/server')
      ? 'fix: tidy the queue worker'
      : 'feat: releases page shows each version',
  ]);
  sh(repo.clone, 'git', ['checkout', 'release/1.5.0']);
  const server = opts.changed?.startsWith('apps/server');
  sh(repo.clone, 'git', [
    'merge',
    '--no-ff',
    'feature',
    '-m',
    server ? 'Merge GWP-90 queue worker' : 'Merge GWP-89 releases page',
  ]);
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
      op: 'replace_text',
      article: 'phases',
      section: 'releases',
      find: 'lists each version',
      replace: 'lists each version with its state',
      sources: ['card:GWP-89'],
    },
  ],
  covered: [],
  skipped: [],
  notes: [],
};

/** analyse, then the help `check` phase, then the help `apply` phase with the writer's proposal as its input. */
async function analyseThenHelp(
  s: S,
  proposal: unknown = PROPOSAL,
  stepInput: Record<string, unknown> = {},
): Promise<{ check: ReleaseDocsPrepResult; help: ReleaseDocsPrepResult }> {
  const analyse = await runReleaseDocsPrep({
    payload: payload(s),
    repoPath: s.repo.clone,
    integrationDir: s.integrationDir,
  });
  const base = { step: 'help', ...(analyse.summary ? { summary: analyse.summary } : {}), stepInput };
  const check = await runReleaseDocsPrep({
    payload: payload(s, { ...base, phase: 'check' }),
    repoPath: s.repo.clone,
    integrationDir: s.integrationDir,
  });
  const help = await runReleaseDocsPrep({
    payload: payload(s, { ...base, phase: 'apply', ...(proposal === null ? {} : { input: { proposal } }) }),
    repoPath: s.repo.clone,
    integrationDir: s.integrationDir,
  });
  return { check, help };
}

const work = `refs/guildwise/docs-prep/${RUN}/work`;
const show = (s: S, path: string): string => sh(s.repo.clone, 'git', ['show', `${work}:${path}`]);
const workExists = (s: S): boolean => {
  try {
    sh(s.repo.clone, 'git', ['rev-parse', '--verify', '--quiet', work]);
    return true;
  } catch {
    return false;
  }
};

describe("release prep step 'help'", () => {
  it('check reports the change with the Help section that describes it, and writes nothing', async () => {
    const s = setup();
    const { check } = await analyseThenHelp(s, null);
    expect(check.state).toBe('passed');
    expect(check.files).toEqual([]);
    const report = check.report as {
      helpDir: string;
      changes: { sources: string[]; hints: { article: string; section: string }[] }[];
    };
    expect(report.helpDir).toBe(DIR);
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]?.sources).toEqual(['card:GWP-89']);
    expect(report.changes[0]?.hints[0]).toMatchObject({ article: 'phases', section: 'releases' });
  });

  it('apply updates only that section, keeps every other article byte for byte and lists the update', async () => {
    const s = setup();
    const { help } = await analyseThenHelp(s);
    expect(help.state).toBe('passed');
    expect(help.files).toEqual([`${DIR}/phases.md`]);
    expect(help.output).toMatchObject({
      status: 'passed',
      changed: [
        {
          article: 'phases',
          section: 'releases',
          title: 'Phases and follow-ups',
          heading: 'Releases',
          sources: ['card:GWP-89'],
        },
      ],
    });
    // (sh trims the output)
    expect(show(s, `${DIR}/phases.md`)).toBe(
      PHASES.replace('lists each version', 'lists each version with its state').trimEnd(),
    );
    expect(show(s, `${DIR}/board.md`)).toBe(BOARD.trimEnd());
    expect(sh(s.repo.clone, 'git', ['log', '-1', '--format=%s', work])).toBe('docs(release): help');
  });

  it('a proposal that breaks an anchor or the header is refused, nothing is written or committed', async () => {
    const s = setup();
    const bad = {
      ...PROPOSAL,
      edits: [
        { op: 'append', article: 'phases', section: 'releases', text: '## Sneaky heading', sources: [] },
      ],
    };
    const { help } = await analyseThenHelp(s, bad);
    expect(help.ok).toBe(false);
    expect(help.state).toBe('failed');
    expect(help.error).toMatch(/^the Help update was refused: /);
    expect(workExists(s)).toBe(false);
    const unknown = { ...PROPOSAL, edits: [{ ...PROPOSAL.edits[0], article: 'nope' }] };
    const r2 = await analyseThenHelp(setup(), unknown);
    expect(r2.help.error).toContain('unknown article "nope"');
    const path = { ...PROPOSAL, edits: [{ ...PROPOSAL.edits[0], article: '../../x' }] };
    const r3 = await analyseThenHelp(setup(), path);
    expect(r3.help.ok).toBe(false);
    expect(r3.help.error).toMatch(/the Help proposal is not valid/);
  });

  it('fails when a file outside the Help folder changed, and commits nothing', async () => {
    const s = setup();
    const analyse = await runReleaseDocsPrep({
      payload: payload(s),
      repoPath: s.repo.clone,
      integrationDir: s.integrationDir,
    });
    const wt = tmp('aom-help-wt-');
    sh(s.repo.clone, 'git', ['worktree', 'add', '--detach', wt, 'origin/release/1.5.0']);
    writeFileSync(join(wt, 'README.md'), 'changed\n');
    const out = await runHelpStep({
      worktree: wt,
      payload: payload(s, { step: 'help', phase: 'apply' }),
      summary: analyse.summary,
      outDir: tmp('aom-out-'),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      phase: 'apply',
      input: { proposal: PROPOSAL },
      repoPath: s.repo.clone,
      dataDir: undefined,
      start: sh(s.repo.clone, 'git', ['rev-parse', 'origin/release/1.5.0']),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe(`the Help update changed files outside ${DIR}: README.md`);
  });

  it('a release that only changes server code has no Help work: no writer, no commit', async () => {
    const s = setup({ changed: 'apps/server/src/queue/worker.ts' });
    const { check, help } = await analyseThenHelp(s, null);
    expect(check.state).toBe('passed');
    expect(check.report).toEqual({ changes: [] });
    expect(check.output).toMatchObject({ nothing: 'no changed area is covered by a Help article' });
    expect(help.state).toBe('passed');
    expect(help.files).toEqual([]);
    expect(help.output).toMatchObject({ nothing: 'no new changes' });
    expect(workExists(s)).toBe(false);
  });

  it('every change already covered by an earlier run leaves nothing to write', async () => {
    const s = setup();
    const { check } = await analyseThenHelp(s, null, { coveredSources: ['card:GWP-89'] });
    expect(check.report).toEqual({ changes: [] });
    expect(check.output).toMatchObject({ nothing: 'no new changes' });
  });

  it('a repository without Help articles is skipped by the first phase', async () => {
    const s = setup({ help: false });
    const { check } = await analyseThenHelp(s, null);
    expect(check.ok).toBe(true);
    expect(check.state).toBe('skipped');
    expect(check.error).toBe('skipped: no Help articles in this repository');
    expect(check.output).toMatchObject({ status: 'passed', skipped: 'no help articles' });
  });

  it('refuses a Help folder outside the repository, and the unnamed phase asks for a newer server', async () => {
    expect(safeHelpDir('/etc')).toBeNull();
    expect(safeHelpDir('../x')).toBeNull();
    expect(safeHelpDir('a/../../x')).toBeNull();
    expect(safeHelpDir('C:\\x')).toBeNull();
    expect(safeHelpDir('apps/web/src/help/articles/')).toBe(DIR);
    const s = setup();
    const { check } = await analyseThenHelp(s, null, { helpDir: '../outside' });
    expect(check.ok).toBe(false);
    expect(check.error).toBe('refusing the Help folder ../outside');
    const out = await runHelpStep({
      worktree: s.repo.clone,
      payload: payload(s, { step: 'help' }),
      summary: undefined,
      outDir: tmp('aom-out-'),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      phase: '',
      input: undefined,
      repoPath: s.repo.clone,
      dataDir: undefined,
      start: 'x',
    });
    expect(out.ok).toBe(false);
    if (!out.ok)
      expect(out.error).toBe('this runner needs a newer server for Update Help articles: update the server');
  });
});

describe('help_edits at aom prep done', () => {
  function shift(s: S): { wt: { path: string; repoPath: string; base: string }; rp: ReleasePrepShift } {
    const path = tmp('aom-help-task-');
    sh(s.repo.clone, 'git', ['worktree', 'add', '--detach', path, 'origin/release/1.5.0']);
    const base = sh(s.repo.clone, 'git', ['rev-parse', 'origin/release/1.5.0']);
    return {
      wt: { path, repoPath: s.repo.clone, base },
      rp: {
        taskId: ID(5),
        runId: RUN,
        repoId: ID(3),
        step: 'help',
        phase: 'write',
        remoteUrlNormalized: s.repo.remoteNormalized,
        workRef: work,
        startSha: base,
        task: {
          kind: 'help_edits',
          helpDir: DIR,
          changes: [
            {
              sources: ['card:GWP-89'],
              title: 'Releases page',
              subjects: [],
              files: [],
              areas: [],
              routes: [],
              hints: [],
            },
          ],
          coveredSources: [],
        },
        writable: [PREP_PROPOSAL_FILE],
      },
    };
  }

  it('accepts a valid proposal and refuses one that breaks an anchor, with the findings', async () => {
    const s = setup();
    const ok = shift(s);
    writeFileSync(join(ok.wt.path, PREP_PROPOSAL_FILE), JSON.stringify(PROPOSAL));
    expect(await finishPrepProposal(ok.wt, ok.rp)).toMatchObject({ ok: true });
    // the articles in the shift's worktree are not changed by the check
    expect(readFileSync(join(ok.wt.path, DIR, 'phases.md'), 'utf8')).toBe(PHASES);

    const bad = shift(s);
    writeFileSync(
      join(bad.wt.path, PREP_PROPOSAL_FILE),
      JSON.stringify({
        edits: [
          {
            op: 'add_section',
            article: 'phases',
            after: 'releases',
            title: 'Notes',
            id: 'notes',
            body: 'x',
            sources: [],
          },
        ],
      }),
    );
    const r = await finishPrepProposal(bad.wt, bad.rp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.findings.join('\n')).toContain('the id "notes" is already used in phases');
  });
});
