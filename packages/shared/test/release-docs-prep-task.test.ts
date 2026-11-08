import { describe, expect, it } from 'vitest';
import {
  authorFailure,
  checkChangelogProposal,
  filesOutsideWritable,
  missingNewVideoFiles,
  newVideoWritableFiles,
  PREP_PROPOSAL_FILE,
  PREP_TASK_KINDS,
  prepWriterUnavailable,
  ReleasePrepShiftSchema,
  ReleasePrepTaskSchema,
  renderReleasePrepInstructions,
  renderReleasePrepPrompt,
  ShiftKind,
  ShiftStartSchema,
  writableFilesFor,
} from '../src/index.ts';

const task = {
  kind: 'new_video' as const,
  slug: 'timesheets',
  title: 'Timesheets',
  pages: ['apps/web/src/pages/Timesheets.tsx'],
  cards: ['GWP-200'],
};

describe('release prep tasks', () => {
  it('a new_video task may write exactly its spec, narration, the screen map, the video list and the plan', () => {
    expect(writableFilesFor(task)).toEqual([
      'e2e/video/timesheets.spec.ts',
      'e2e/video/narration/timesheets.ts',
      'e2e/video/screens.json',
      'apps/web/src/lib/videos.ts',
      'docs/guide/VIDEO-PLAN.md',
    ]);
    expect(newVideoWritableFiles('a')).toHaveLength(5);
  });

  it('names every changed file outside the writable list, sorted and once', () => {
    const w = writableFilesFor(task);
    expect(filesOutsideWritable(['e2e/video/timesheets.spec.ts'], w)).toEqual([]);
    expect(
      filesOutsideWritable(
        ['e2e/video/harness.ts', 'e2e/video/timesheets.spec.ts', 'apps/server/x.ts', 'e2e/video/harness.ts'],
        w,
      ),
    ).toEqual(['apps/server/x.ts', 'e2e/video/harness.ts']);
  });

  it('a task is only done with its spec and narration', () => {
    expect(missingNewVideoFiles(task, ['e2e/video/timesheets.spec.ts'])).toEqual([
      'e2e/video/narration/timesheets.ts',
    ]);
    expect(
      missingNewVideoFiles(task, ['e2e/video/timesheets.spec.ts', 'e2e/video/narration/timesheets.ts']),
    ).toEqual([]);
  });

  it('the failure names the video', () => {
    expect(authorFailure('timesheets', 'the agent stopped')).toBe(
      'timesheets: could not write the video script: the agent stopped',
    );
  });

  it('the prompt names the slug, the pages, the files to write and, in a repair round, the render error', () => {
    const rp = ReleasePrepShiftSchema.parse({
      taskId: '0190a1b2-0000-7000-8000-000000000001',
      runId: '0190a1b2-0000-7000-8000-000000000002',
      repoId: '0190a1b2-0000-7000-8000-000000000003',
      step: 'videos',
      phase: 'author',
      remoteUrlNormalized: 'github.com/acme/app',
      workRef: 'refs/guildwise/docs-prep/r/work',
      startSha: 'a'.repeat(40),
      task,
      writable: writableFilesFor(task),
    });
    const prompt = renderReleasePrepPrompt(rp);
    expect(prompt).toContain('e2e/video/timesheets.spec.ts');
    expect(prompt).toContain('apps/web/src/pages/Timesheets.tsx');
    expect(prompt).toContain('GWP-200');
    expect(prompt).not.toContain('second try');
    expect(renderReleasePrepPrompt({ ...rp, task: { ...task, repairOf: { error: 'locator x' } } })).toContain(
      'locator x',
    );
    const instr = renderReleasePrepInstructions({ name: 'Bea' }, { key: 'GWP', name: 'Platform' }, rp);
    for (const f of rp.writable) expect(instr).toContain(f);
    expect(instr).toContain('aom prep done');
    expect(instr).toContain('aom prep fail');
  });

  it('release_prep is a shift kind and shift.start carries the task', () => {
    expect(ShiftKind.parse('release_prep')).toBe('release_prep');
    expect(ShiftStartSchema.shape.kind.parse('release_prep')).toBe('release_prep');
    const rp = ReleasePrepShiftSchema.parse({
      taskId: '0190a1b2-0000-7000-8000-000000000001',
      runId: '0190a1b2-0000-7000-8000-000000000002',
      repoId: '0190a1b2-0000-7000-8000-000000000003',
      step: 'videos',
      phase: 'author',
      remoteUrlNormalized: 'github.com/acme/app',
      workRef: 'refs/guildwise/docs-prep/r/work',
      startSha: 'a'.repeat(40),
      task: { ...task, repairOf: { error: 'Timeout' } },
      writable: writableFilesFor(task),
    });
    expect(rp.task.kind === 'new_video' && rp.task.repairOf?.error).toBe('Timeout');
    expect(() => ReleasePrepShiftSchema.parse({ ...rp, task: { ...task, slug: '../x' } })).toThrow();
  });
});

describe('proposal task kinds (one writer mechanism)', () => {
  const changelog = {
    kind: 'changelog_entries' as const,
    projectName: 'Toy',
    repoName: 'toy-repo',
    releaseBranch: 'release/1.5.0',
    changes: [{ source: 'a'.repeat(40), subject: 'Add the export button', cards: [], areas: [] }],
    existing: [{ heading: 'Added', text: 'Retire a workstation.' }],
  };
  const guide = {
    kind: 'guide_edits' as const,
    guidePath: 'docs/USER-GUIDE.md',
    changes: [
      {
        sources: ['card:TOY-1'],
        title: 'Export',
        subjects: [],
        files: ['apps/web/src/pages/Export.tsx'],
        areas: ['web'],
        routes: ['/export'],
        hints: [{ section: '4.2 Export', score: 3, why: 'heading: export' }],
      },
    ],
    coveredSources: [],
  };
  const rpOf = (task: unknown) => ({
    taskId: '0190a1b2-0000-7000-8000-000000000001',
    runId: '0190a1b2-0000-7000-8000-000000000002',
    repoId: '0190a1b2-0000-7000-8000-000000000003',
    step: 'x',
    phase: 'write',
    remoteUrlNormalized: 'github.com/acme/app',
    workRef: 'refs/guildwise/docs-prep/r/work',
    startSha: 'a'.repeat(40),
    task,
    writable: [PREP_PROPOSAL_FILE],
  });

  it('parses the three kinds and may write only the proposal file for the proposal kinds', () => {
    expect(ReleasePrepTaskSchema.parse(changelog).kind).toBe('changelog_entries');
    expect(ReleasePrepTaskSchema.parse(guide).kind).toBe('guide_edits');
    expect(writableFilesFor(ReleasePrepTaskSchema.parse(changelog))).toEqual(['release-prep-proposal.json']);
    expect(writableFilesFor(ReleasePrepTaskSchema.parse(guide))).toEqual(['release-prep-proposal.json']);
    expect(() => ReleasePrepTaskSchema.parse({ ...guide, changes: [] })).toThrow();
  });

  it('chooses the writer roles in one registry: BA first for the changelog, architect first for the guide, builder for videos', () => {
    expect(PREP_TASK_KINDS.changelog_entries.roles).toEqual(['ba', 'architect', 'builder']);
    expect(PREP_TASK_KINDS.guide_edits.roles).toEqual(['architect', 'ba', 'builder']);
    expect(PREP_TASK_KINDS.new_video.roles).toEqual(['builder']);
    expect(PREP_TASK_KINDS.changelog_entries.result).toBe('proposal');
    expect(PREP_TASK_KINDS.new_video.result).toBe('files');
  });

  it('words the no-writer failure the same way for every step, naming what is missing and the fix', () => {
    const c = prepWriterUnavailable('no_writer', 'changelog_entries', { workstation: 'ws-1' });
    const g = prepWriterUnavailable('no_writer', 'guide_edits', { workstation: 'ws-1' });
    const v = prepWriterUnavailable('no_writer', 'new_video', { workstation: 'ws-1', what: 'the timesheets video' });
    expect(c).toBe(
      'Write changelog: no agent on ws-1 can write the changelog entries. It needs an active BA, architect or builder agent on that workstation. Hire or move one there (or turn the step off), then Retry prep. Or write the entries under ## [Unreleased] by hand and Skip prep.',
    );
    expect(g).toContain('Update user guide: no agent on ws-1 can write the user guide update.');
    expect(g).toContain('active architect, BA or builder agent');
    expect(v).toContain('Generate videos: no agent on ws-1 can write the timesheets video.');
    for (const m of [c, g, v]) expect(m).toContain('then Retry prep.');
  });

  it('words the unreachable and failed cases', () => {
    expect(
      prepWriterUnavailable('writer_unreachable', 'guide_edits', { workstation: 'ws-1', reason: 'the runner is offline' }),
    ).toContain('within 2 hours (the runner is offline)');
    expect(prepWriterUnavailable('writer_failed', 'changelog_entries', { reason: 'no reason' })).toBe(
      'Write changelog: the changelog entries could not be written: no reason',
    );
  });

  it('the changelog and guide instructions say to write the proposal file and finish with aom prep', () => {
    const agent = { name: 'Ada' };
    const project = { key: 'TOY', name: 'Toy' };
    const c = renderReleasePrepInstructions(agent, project, rpOf(changelog) as never);
    expect(c).toContain('release-prep-proposal.json');
    expect(c).toContain('Added, Changed, Deprecated, Removed, Fixed, Security');
    expect(c).toContain('aom prep done');
    const g = renderReleasePrepInstructions(agent, project, rpOf(guide) as never);
    expect(g).toContain('release-prep-proposal.json');
    expect(g).toContain('replace_text');
    expect(renderReleasePrepPrompt(rpOf(changelog) as never)).toContain(`id ${'a'.repeat(40)}: Add the export button`);
    expect(renderReleasePrepPrompt(rpOf(guide) as never)).toContain('docs/USER-GUIDE.md');
  });

  it('an uncovered change missing from a changelog proposal is still refused by the shared check', () => {
    const r = checkChangelogProposal(
      { entries: [], covered: [], skipped: [] },
      { uncovered: ['a'.repeat(40)], existingCount: 0, publicText: (s) => s },
    );
    expect(r.ok).toBe(false);
  });
});
