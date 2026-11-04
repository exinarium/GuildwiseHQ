import { describe, expect, it } from 'vitest';
import {
  authorFailure,
  filesOutsideWritable,
  missingNewVideoFiles,
  newVideoWritableFiles,
  ReleasePrepShiftSchema,
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
    expect(rp.task.repairOf?.error).toBe('Timeout');
    expect(() => ReleasePrepShiftSchema.parse({ ...rp, task: { ...task, slug: '../x' } })).toThrow();
  });
});
