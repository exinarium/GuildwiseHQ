import { describe, expect, it } from 'vitest';
import {
  capVideoReport,
  checkVideoVoice,
  enabledReleaseDocsPrepSteps,
  isServerPhase,
  kebabOfStem,
  libraryVoiceLabel,
  mapChangesToVideos,
  nextReleaseDocsPrepAction,
  phaseIndex,
  releaseDocsPrepSteps,
  stepPhases,
  type VideoChange,
  type VideoScreenMap,
  VideoScreenMapSchema,
} from '../src/index.ts';

const map: VideoScreenMap = VideoScreenMapSchema.parse({
  version: 1,
  ui: ['apps/web/src/**'],
  pages: ['apps/web/src/pages/*.tsx'],
  shared: ['apps/web/src/components/shell/**', 'apps/web/src/components/ui/**', '**/*.test.*'],
  exclude: ['apps/web/src/pages/Login.tsx'],
  videos: {
    backlog: {
      screens: [{ name: 'Backlog', files: ['apps/web/src/pages/Backlog.tsx', 'apps/web/src/components/backlog/**'] }],
    },
    releases: {
      screens: [
        { name: 'Releases', files: ['apps/web/src/pages/Releases.tsx', 'apps/web/src/components/delivery/**'] },
      ],
    },
    overview: {
      screens: [
        { name: 'Backlog', files: ['apps/web/src/pages/Backlog.tsx'] },
        { name: 'Desk', files: ['apps/web/src/pages/Desk.tsx'] },
      ],
    },
  },
  planned: { forms: { title: 'Forms: build a form', pages: ['apps/web/src/pages/Forms.tsx'] } },
});
const specs = ['backlog', 'releases', 'overview'];
const run = (changes: VideoChange[], cardsByPath?: Record<string, string[]>) =>
  mapChangesToVideos({ changes, map, specs, cardsByPath });
const M = (path: string): VideoChange => ({ path, status: 'M' });

describe('Generate videos step registry', () => {
  it('sits between analyse and commit and is off by default, even when prep is on', () => {
    expect(releaseDocsPrepSteps().map((s) => s.id)).toEqual(['analyse', 'videos', 'commit']);
    expect(enabledReleaseDocsPrepSteps({ steps: {} }).map((s) => s.id)).toEqual(['analyse', 'commit']);
    expect(enabledReleaseDocsPrepSteps({ steps: { videos: true } }).map((s) => s.id)).toEqual([
      'analyse',
      'videos',
      'commit',
    ]);
  });
  it('has plan, author (server) and render phases; commit keeps prepare then push', () => {
    expect(stepPhases('videos')).toEqual(['plan', 'author', 'render']);
    expect(isServerPhase('videos', 'author')).toBe(true);
    expect(isServerPhase('videos', 'render')).toBe(false);
    expect(stepPhases('commit')).toEqual(['prepare', 'push']);
    expect(stepPhases('analyse')).toEqual(['']);
    expect(phaseIndex('videos', 'render')).toBeGreaterThan(phaseIndex('videos', 'plan'));
  });
});

describe('planner with phases', () => {
  const steps = ['analyse', 'videos', 'commit'];
  const done = { step: 'analyse', state: 'passed' as const };
  it('runs the plan phase in every repo first', () => {
    const r = nextReleaseDocsPrepAction({
      status: 'running',
      steps,
      repos: [
        { repoId: 'a', state: 'running', steps: [done] },
        { repoId: 'b', state: 'running', steps: [done] },
      ],
    });
    expect(r).toEqual({ kind: 'dispatch', step: 'videos', phase: 'plan', repoIds: ['a', 'b'] });
  });
  it('marks the author phase as run by the server', () => {
    const r = nextReleaseDocsPrepAction({
      status: 'running',
      steps,
      repos: [{ repoId: 'a', state: 'running', steps: [done, { step: 'videos', phase: 'plan', state: 'passed' }] }],
    });
    expect(r).toEqual({ kind: 'dispatch', step: 'videos', phase: 'author', repoIds: ['a'], by: 'server' });
  });
  it('skips the later phases of a repo whose plan was skipped, with its note, and the repo reaches commit', () => {
    const plan = { step: 'videos', phase: 'plan', state: 'skipped' as const, error: 'skipped: no videos' };
    const r = nextReleaseDocsPrepAction({
      status: 'running',
      steps,
      repos: [{ repoId: 'cloud', state: 'running', steps: [done, plan] }],
    });
    expect(r).toEqual({
      kind: 'skip',
      step: 'videos',
      phase: 'author',
      repoIds: ['cloud'],
      notes: { cloud: 'skipped: no videos' },
    });
    const after = nextReleaseDocsPrepAction({
      status: 'running',
      steps,
      repos: [
        {
          repoId: 'cloud',
          state: 'running',
          steps: [
            done,
            plan,
            { step: 'videos', phase: 'author', state: 'skipped', error: 'skipped: no videos' },
            { step: 'videos', phase: 'render', state: 'skipped', error: 'skipped: no videos' },
          ],
        },
      ],
    });
    expect(after).toEqual({ kind: 'dispatch', step: 'commit', phase: 'prepare', repoIds: ['cloud'] });
  });
  it('a failed plan (voice unavailable) fails the run before commit', () => {
    const r = nextReleaseDocsPrepAction({
      status: 'running',
      steps,
      repos: [
        {
          repoId: 'a',
          state: 'running',
          steps: [done, { step: 'videos', phase: 'plan', state: 'failed', error: 'voice unavailable: x' }],
        },
      ],
    });
    expect(r).toEqual({ kind: 'finish', status: 'failed', step: 'videos', repoId: 'a', error: 'voice unavailable: x' });
  });
});

describe('mapChangesToVideos', () => {
  it('a changed screen selects every video that lists it, with the reason and card keys', () => {
    const r = run([M('apps/web/src/pages/Backlog.tsx')], { 'apps/web/src/pages/Backlog.tsx': ['GWP-12'] });
    expect(r.selected.map((s) => s.slug)).toEqual(['backlog', 'overview']);
    expect(r.selected[0]?.reasons).toEqual(['screen Backlog changed: apps/web/src/pages/Backlog.tsx (GWP-12)']);
    expect(r.newVideos).toEqual([]);
  });
  it('a component folder of a screen selects its video only', () => {
    expect(run([M('apps/web/src/components/delivery/ReleaseDocsPrepTab.tsx')]).selected.map((s) => s.slug)).toEqual([
      'releases',
    ]);
  });
  it('a server or docs change selects nothing and is only counted', () => {
    const r = run([M('apps/server/src/app.ts'), M('docs/USER-GUIDE.md')]);
    expect(r.selected).toEqual([]);
    expect(r.ignoredCount).toBe(2);
  });
  it('shared UI selects nothing and is listed', () => {
    const r = run([M('apps/web/src/components/shell/Sidebar.tsx'), M('apps/web/src/pages/Backlog.test.tsx')]);
    expect(r.selected).toEqual([]);
    expect(r.shared).toEqual(['apps/web/src/components/shell/Sidebar.tsx', 'apps/web/src/pages/Backlog.test.tsx']);
  });
  it('a changed spec or narration selects its slug', () => {
    const r = run([M('e2e/video/narration/releases.ts'), M('e2e/video/backlog.spec.ts')]);
    expect(r.selected.map((s) => [s.slug, s.reasons])).toEqual([
      ['backlog', ['script changed: e2e/video/backlog.spec.ts']],
      ['releases', ['script changed: e2e/video/narration/releases.ts']],
    ]);
  });
  it('a new page asks for a new video named after the file; a planned page gives the planned slug', () => {
    const r = run([
      { path: 'apps/web/src/pages/JourneyDesigner.tsx', status: 'A' },
      M('apps/web/src/pages/Forms.tsx'),
    ]);
    expect(r.newVideos.map((v) => [v.slug, v.title])).toEqual([
      ['forms', 'Forms: build a form'],
      ['journey-designer', 'Journey designer'],
    ]);
    expect(r.newVideos[0]?.reasons).toEqual(['new screen Forms: build a form: apps/web/src/pages/Forms.tsx']);
  });
  it('an excluded or deleted page asks for nothing', () => {
    const r = run([M('apps/web/src/pages/Login.tsx'), { path: 'apps/web/src/pages/Gone.tsx', status: 'D' }]);
    expect(r.newVideos).toEqual([]);
    expect(r.selected).toEqual([]);
  });
  it('other UI files are listed as unmapped and select nothing', () => {
    const r = run([M('apps/web/src/components/agents/Card.tsx')]);
    expect(r.unmapped).toEqual(['apps/web/src/components/agents/Card.tsx']);
    expect(r.selected).toEqual([]);
  });
  it('groups many paths of one screen as the first five and a count', () => {
    const paths = Array.from({ length: 7 }, (_, i) => M(`apps/web/src/components/backlog/F${i}.tsx`));
    expect(run(paths).selected[0]?.reasons[0]).toMatch(/and 2 more$/);
  });
  it('a selected video without its spec is marked missing', () => {
    const r = mapChangesToVideos({ changes: [M('apps/web/src/pages/Releases.tsx')], map, specs: ['backlog'] });
    expect(r.selected[0]).toMatchObject({ slug: 'releases', specMissing: true });
  });
  it('kebab-cases a file stem', () => {
    expect(kebabOfStem('apps/web/src/pages/FormBuilderPage.tsx')).toBe('form-builder-page');
    expect(kebabOfStem('AIRuntimes.tsx')).toBe('ai-runtimes');
  });
});

describe('the voice check', () => {
  const lib = libraryVoiceLabel([{ voice: 'Kokoro af_heart' }, { voice: 'Kokoro af_heart' }]);
  it('reads the voice of the existing videos', () => {
    expect(lib).toEqual({ ok: true, label: 'Kokoro af_heart' });
    expect(libraryVoiceLabel([])).toEqual({ ok: true, label: null });
  });
  it('fails when the existing videos disagree', () => {
    const l = libraryVoiceLabel([{ voice: 'Kokoro af_heart' }, { voice: 'Piper en_GB-cori-high' }]);
    expect(l.ok).toBe(false);
    expect(checkVideoVoice({ available: true, label: 'Kokoro af_heart' }, l, 'ws')).toMatch(/^voice unavailable: /);
  });
  it('fails when the voice is not installed', () => {
    expect(checkVideoVoice({ available: false, label: 'Kokoro af_heart' }, lib, 'ws1')).toBe(
      'voice unavailable: Kokoro af_heart is not installed on ws1 (run e2e/video/setup-voice.sh; ask DevOps)',
    );
  });
  it('fails when the environment selects another voice', () => {
    expect(checkVideoVoice({ available: true, label: 'Piper en_GB-cori-high' }, lib, 'ws')).toMatch(
      /^voice unavailable: the workstation's environment selects Piper/,
    );
  });
  it('passes on the same installed voice', () => {
    expect(checkVideoVoice({ available: true, label: 'Kokoro af_heart' }, lib, 'ws')).toBeNull();
  });
});

describe('capVideoReport', () => {
  it('cuts reasons, errors and long lists', () => {
    const r = capVideoReport({
      harness: true,
      videos: [
        {
          slug: 'a',
          action: 'regenerate',
          state: 'failed',
          reasons: Array.from({ length: 30 }, (_, i) => `r${i}`),
          error: 'x'.repeat(5000),
        },
      ],
      shared: Array.from({ length: 250 }, (_, i) => `s${i}`),
      unmapped: [],
      ignoredCount: 0,
    });
    expect(r.videos[0]?.reasons).toHaveLength(20);
    expect(r.videos[0]?.error?.length).toBeLessThan(2100);
    expect(r.shared).toHaveLength(200);
    expect(r.more).toEqual({ shared: 50, unmapped: 0 });
  });
});
