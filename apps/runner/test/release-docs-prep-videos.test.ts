import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type ReleaseDocsPrepPayload, type ReleaseDocsPrepResult, writableFilesFor } from '@aom/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runReleaseDocsPrep } from '../src/git/release-docs-prep.ts';
import { addPrepTaskWorktree, finishPrepTask, removePrepTaskWorktree } from '../src/git/release-prep-task.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const RUN = '019e3f6a-7b1c-7a2d-8c3e-0123456789e1';
const ID = (n: number) => `019e3f6a-7b1c-7a2d-8c3e-01234567890${n}`;
const VOICE = 'Kokoro af_heart';

function put(clone: string, path: string, text: string) {
  mkdirSync(dirname(join(clone, path)), { recursive: true });
  writeFileSync(join(clone, path), text);
}
function commit(clone: string, files: Record<string, string>, message: string) {
  for (const [p, t] of Object.entries(files)) put(clone, p, t);
  sh(clone, 'git', ['add', '-A']);
  sh(clone, 'git', ['commit', '-m', message]);
}

const MAP = {
  version: 1,
  ui: ['apps/web/src/**'],
  pages: ['apps/web/src/pages/*.tsx'],
  shared: ['apps/web/src/components/shell/**'],
  exclude: ['apps/web/src/pages/Login.tsx'],
  videos: {
    backlog: { screens: [{ name: 'Backlog', files: ['apps/web/src/pages/Backlog.tsx'] }] },
    releases: { screens: [{ name: 'Releases', files: ['apps/web/src/pages/Releases.tsx'] }] },
  },
  planned: {},
};

const sidecar = (slug: string, voice = VOICE) => `${JSON.stringify({ title: slug, voice, duration: 10 })}\n`;

/**
 * main (tag v1.3.0) with a video harness for backlog and releases; release/1.4.0 changes the given files.
 * `harness: false` leaves out e2e/video/screens.json.
 */
function setup(change: Record<string, string>, opts: { harness?: boolean } = {}) {
  const repo = makeRepo();
  const base: Record<string, string> = {
    'README.md': 'hello\n',
    'apps/web/src/pages/Backlog.tsx': 'backlog v1\n',
    'apps/web/src/pages/Releases.tsx': 'releases v1\n',
    'apps/web/src/components/shell/Sidebar.tsx': 'sidebar v1\n',
    'e2e/video/backlog.spec.ts': 'spec\n',
    'e2e/video/releases.spec.ts': 'spec\n',
    'media/videos/backlog.json': sidecar('backlog'),
    'media/videos/releases.json': sidecar('releases'),
  };
  if (opts.harness ?? true) base['e2e/video/screens.json'] = `${JSON.stringify(MAP, null, 2)}\n`;
  commit(repo.clone, base, 'chore: start');
  sh(repo.clone, 'git', ['tag', '-a', 'v1.3.0', '-m', '1.3.0']);
  const baseSha = sh(repo.clone, 'git', ['rev-parse', 'HEAD']);
  sh(repo.clone, 'git', ['push', 'origin', 'main', '--tags']);
  sh(repo.clone, 'git', ['checkout', '-b', 'release/1.4.0']);
  commit(repo.clone, change, 'feat: change (GWP-12)');
  sh(repo.clone, 'git', ['push', '-u', 'origin', 'release/1.4.0']);
  return { repo, baseSha, integrationDir: tmp('aom-integration-'), dataDir: tmp('aom-data-') };
}
type Setup = ReturnType<typeof setup>;

const payload = (s: Setup, over: Partial<ReleaseDocsPrepPayload> = {}): ReleaseDocsPrepPayload => ({
  runId: RUN,
  projectId: ID(2),
  repoId: ID(3),
  remoteUrlNormalized: s.repo.remoteNormalized,
  releaseBranch: 'release/1.4.0',
  mainBranch: 'main',
  step: 'videos',
  phase: 'plan',
  components: [],
  projectKey: 'GWP',
  commitAs: { name: 'Release Owner', email: 'owner@example.test' },
  base: { sha: s.baseSha, tag: 'v1.3.0' },
  ...over,
});

const run = (s: Setup, over: Partial<ReleaseDocsPrepPayload> = {}): Promise<ReleaseDocsPrepResult> =>
  runReleaseDocsPrep({
    payload: payload(s, over),
    repoPath: s.repo.clone,
    integrationDir: s.integrationDir,
    dataDir: s.dataDir,
  });

type Videos = { slug: string; action: string; state: string; reasons: string[]; error?: string }[];
const videosOf = (r: ReleaseDocsPrepResult): Videos =>
  (r.report as { videos: Videos } | undefined)?.videos ?? [];

/** A fake recorder: writes the four files into AOM_VIDEO_OUT (voice from FAKE_VOICE), fails for FAKE_FAIL, counts runs. */
function fakeRecorder(dir: string): { cmd: string; count: string } {
  const count = join(dir, 'count');
  const cmd = join(dir, 'record.sh');
  writeFileSync(
    cmd,
    [
      '#!/bin/sh',
      `echo "$AOM_VIDEO_SLUG" >> ${count}`,
      'if [ "$AOM_VIDEO_SLUG" = "$FAKE_FAIL" ]; then echo "selector not found: Backlog"; exit 1; fi',
      'for e in webm mp4 vtt; do echo "$AOM_VIDEO_SLUG $e" > "$AOM_VIDEO_OUT/$AOM_VIDEO_SLUG.$e"; done',
      'printf \'{"title":"%s","voice":"%s","duration":12}\\n\' "$AOM_VIDEO_SLUG" "${FAKE_VOICE:-Kokoro af_heart}" > "$AOM_VIDEO_OUT/$AOM_VIDEO_SLUG.json"',
    ].join('\n'),
  );
  chmodSync(cmd, 0o755);
  return { cmd, count };
}
const runs = (count: string): string[] =>
  existsSync(count) ? readFileSync(count, 'utf8').trim().split('\n').filter(Boolean) : [];

const ENV_KEYS = ['AOM_PREP_VIDEO_PROBE', 'AOM_PREP_VIDEO_CMD', 'FAKE_FAIL', 'FAKE_VOICE'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.AOM_PREP_VIDEO_PROBE = JSON.stringify({ available: true, label: VOICE, ffmpeg: null });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** plan then render, with the plan's report handed on as the server does. */
async function planAndRender(s: Setup, authored: string[] = []) {
  const plan = await run(s);
  const render = await run(s, { phase: 'render', input: { plan: plan.report, authored } });
  return { plan, render };
}
const workTree = (s: Setup) =>
  sh(s.repo.clone, 'git', ['ls-tree', '-r', '--name-only', `refs/guildwise/docs-prep/${RUN}/work`]).split(
    '\n',
  );

describe('release.docs_prep videos: plan', () => {
  it('selects exactly the videos that show a changed screen, with the reason and card key', async () => {
    const s = setup({ 'apps/web/src/pages/Backlog.tsx': 'backlog v2\n', 'apps/server/a.ts': 'x\n' });
    const r = await run(s);
    expect(r.state).toBe('passed');
    expect(videosOf(r).map((v) => [v.slug, v.action])).toEqual([['backlog', 'regenerate']]);
    expect(videosOf(r)[0]?.reasons.join(' ')).toContain(
      'screen Backlog changed: apps/web/src/pages/Backlog.tsx (GWP-12)',
    );
    expect((r.report as { rule?: string }).rule).toBeTruthy();
    expect((r.report as { voice?: string }).voice).toBe(VOICE);
  });

  it('selects nothing for a shared UI or non-UI change', async () => {
    const s = setup({ 'apps/web/src/components/shell/Sidebar.tsx': 'v2\n', 'apps/server/a.ts': 'x\n' });
    const r = await run(s);
    expect(r.state).toBe('passed');
    expect(videosOf(r)).toEqual([]);
    expect((r.report as { shared: string[] }).shared).toContain('apps/web/src/components/shell/Sidebar.tsx');
  });

  it('asks for a new video for a new page', async () => {
    const s = setup({ 'apps/web/src/pages/JourneyDesigner.tsx': 'new\n' });
    const r = await run(s);
    expect(videosOf(r).map((v) => [v.slug, v.action])).toEqual([['journey-designer', 'create']]);
    expect((r.report as { needsAuthoring: { slug: string }[] }).needsAuthoring.map((n) => n.slug)).toEqual([
      'journey-designer',
    ]);
  });

  it("skips a repository without a video harness with 'skipped: no videos'", async () => {
    const s = setup({ 'apps/web/src/pages/Backlog.tsx': 'v2\n' }, { harness: false });
    const r = await run(s);
    expect(r.ok).toBe(true);
    expect(r.state).toBe('skipped');
    expect(r.error).toBe('skipped: no videos');
  });

  it("fails with 'voice unavailable' when the voice is not installed, and writes nothing", async () => {
    process.env.AOM_PREP_VIDEO_PROBE = JSON.stringify({ available: false, label: VOICE, ffmpeg: null });
    const s = setup({ 'apps/web/src/pages/Backlog.tsx': 'v2\n' });
    const r = await run(s);
    expect(r.state).toBe('failed');
    expect(r.error).toMatch(/^voice unavailable: Kokoro af_heart is not installed/);
    expect(r.files).toEqual([]);
  });

  it("fails with 'voice unavailable' when the workstation selects another voice", async () => {
    process.env.AOM_PREP_VIDEO_PROBE = JSON.stringify({
      available: true,
      label: 'Piper en_GB-cori-high',
      ffmpeg: null,
    });
    const s = setup({ 'apps/web/src/pages/Backlog.tsx': 'v2\n' });
    const r = await run(s);
    expect(r.state).toBe('failed');
    expect(r.error).toContain('voice unavailable: the workstation');
  });

  it('fails when ffmpeg is missing', async () => {
    process.env.AOM_PREP_VIDEO_PROBE = JSON.stringify({
      available: true,
      label: VOICE,
      ffmpeg: 'no ffmpeg found',
    });
    const s = setup({ 'apps/web/src/pages/Backlog.tsx': 'v2\n' });
    const r = await run(s);
    expect(r.error).toBe('ffmpeg unavailable: no ffmpeg found');
  });
});

describe('release.docs_prep videos: render', () => {
  it('renders only the selected videos into media/videos and keeps them on the work ref', async () => {
    const f = fakeRecorder(tmp('aom-fake-'));
    process.env.AOM_PREP_VIDEO_CMD = f.cmd;
    const s = setup({ 'apps/web/src/pages/Backlog.tsx': 'v2\n' });
    const { render } = await planAndRender(s);
    expect(render.state).toBe('passed');
    expect(runs(f.count)).toEqual(['backlog']);
    expect(render.files.sort()).toEqual([
      'e2e/video/renders.json',
      'media/videos/backlog.json',
      'media/videos/backlog.mp4',
      'media/videos/backlog.vtt',
      'media/videos/backlog.webm',
    ]);
    expect(videosOf(render)[0]).toMatchObject({ slug: 'backlog', state: 'rendered' });
    const tree = workTree(s);
    expect(tree).toContain('media/videos/backlog.webm');
    expect(tree).toContain('e2e/video/renders.json');
    expect(tree).not.toContain('media/videos/releases.webm');
    // nothing pushed
    expect(sh(s.repo.origin, 'git', ['ls-tree', '-r', '--name-only', 'release/1.4.0'])).not.toContain(
      'backlog.webm',
    );
    // the render worktree is gone
    expect(sh(s.repo.clone, 'git', ['worktree', 'list'])).not.toContain('docs-prep-');
  });

  it('fails naming the video and its error, and still renders the others (nothing kept)', async () => {
    const f = fakeRecorder(tmp('aom-fake-'));
    process.env.AOM_PREP_VIDEO_CMD = f.cmd;
    process.env.FAKE_FAIL = 'backlog';
    const s = setup({ 'apps/web/src/pages/Backlog.tsx': 'v2\n', 'apps/web/src/pages/Releases.tsx': 'v2\n' });
    const { render } = await planAndRender(s);
    expect(render.state).toBe('failed');
    expect(render.error).toContain('1 video(s) failed: backlog: selector not found: Backlog');
    expect(runs(f.count).sort()).toEqual(['backlog', 'releases']);
    const v = videosOf(render);
    expect(v.find((x) => x.slug === 'backlog')?.error).toContain('selector not found');
    expect(v.find((x) => x.slug === 'releases')?.state).toBe('rendered');
  });

  it('refuses a recording made with another voice', async () => {
    const f = fakeRecorder(tmp('aom-fake-'));
    process.env.AOM_PREP_VIDEO_CMD = f.cmd;
    process.env.FAKE_VOICE = 'Piper en_GB-cori-high';
    const s = setup({ 'apps/web/src/pages/Backlog.tsx': 'v2\n' });
    const { render } = await planAndRender(s);
    expect(render.state).toBe('failed');
    expect(render.error).toContain('backlog: the recording used the voice Piper en_GB-cori-high');
  });

  it('does not render a new video whose script was not written', async () => {
    const f = fakeRecorder(tmp('aom-fake-'));
    process.env.AOM_PREP_VIDEO_CMD = f.cmd;
    const s = setup({ 'apps/web/src/pages/JourneyDesigner.tsx': 'new\n' });
    const { render } = await planAndRender(s);
    expect(render.state).toBe('failed');
    expect(render.error).toContain('journey-designer: no video script was written');
    expect(runs(f.count)).toEqual([]);
  });

  it('renders a new video once its script was written', async () => {
    const f = fakeRecorder(tmp('aom-fake-'));
    process.env.AOM_PREP_VIDEO_CMD = f.cmd;
    const s = setup({ 'apps/web/src/pages/JourneyDesigner.tsx': 'new\n' });
    const { render } = await planAndRender(s, ['journey-designer']);
    expect(render.state).toBe('passed');
    expect(runs(f.count)).toEqual(['journey-designer']);
    expect(render.files).toContain('media/videos/journey-designer.webm');
  });

  it('reuses the render cache on a retry instead of recording again', async () => {
    const f = fakeRecorder(tmp('aom-fake-'));
    process.env.AOM_PREP_VIDEO_CMD = f.cmd;
    const s = setup({ 'apps/web/src/pages/Backlog.tsx': 'v2\n' });
    const plan = await run(s);
    await run(s, { phase: 'render', input: { plan: plan.report, authored: [] } });
    const again = await run(s, {
      runId: '019e3f6a-7b1c-7a2d-8c3e-0123456789e2',
      phase: 'render',
      input: { plan: plan.report, authored: [] },
    });
    expect(again.state).toBe('passed');
    expect(runs(f.count)).toEqual(['backlog']);
    expect(videosOf(again)[0]?.action).toBe('reused');
  });

  it('joins a redelivered render command instead of recording twice', async () => {
    const f = fakeRecorder(tmp('aom-fake-'));
    process.env.AOM_PREP_VIDEO_CMD = f.cmd;
    const s = setup({ 'apps/web/src/pages/Backlog.tsx': 'v2\n' });
    const plan = await run(s);
    const over = { phase: 'render', input: { plan: plan.report, authored: [] } };
    const [a, b] = await Promise.all([run(s, over), run(s, over)]);
    expect(a.state).toBe('passed');
    expect(b).toBe(a);
    expect(runs(f.count)).toEqual(['backlog']);
  });

  it('plans up_to_date once the release commit already holds the render', async () => {
    const f = fakeRecorder(tmp('aom-fake-'));
    process.env.AOM_PREP_VIDEO_CMD = f.cmd;
    const s = setup({ 'apps/web/src/pages/Backlog.tsx': 'v2\n' });
    const { render } = await planAndRender(s);
    expect(render.state).toBe('passed');
    // a second plan on the same run starts from the work ref, which holds renders.json
    const again = await run(s);
    expect(videosOf(again)[0]).toMatchObject({ slug: 'backlog', action: 'up_to_date', state: 'skipped' });
  });
});

describe('release prep task: a new video script', () => {
  const task = {
    kind: 'new_video' as const,
    slug: 'journey-designer',
    title: 'Journey designer',
    pages: ['apps/web/src/pages/JourneyDesigner.tsx'],
    cards: ['GWP-12'],
  };
  const rpOf = (s: Setup, startSha: string) => ({
    taskId: ID(5),
    runId: RUN,
    repoId: ID(3),
    step: 'videos',
    phase: 'author',
    remoteUrlNormalized: s.repo.remoteNormalized,
    workRef: `refs/guildwise/docs-prep/${RUN}/work`,
    startSha,
    task,
    writable: writableFilesFor(task),
  });
  const commitAs = { name: 'Release Owner', email: 'owner@example.test' };
  const write = (wt: string) => {
    put(wt, 'e2e/video/journey-designer.spec.ts', 'spec journey\n');
    put(wt, 'e2e/video/narration/journey-designer.ts', 'export default []\n');
    const map = JSON.parse(readFileSync(join(wt, 'e2e/video/screens.json'), 'utf8'));
    map.videos['journey-designer'] = {
      screens: [{ name: 'Journey designer', files: ['apps/web/src/pages/JourneyDesigner.tsx'] }],
    };
    put(wt, 'e2e/video/screens.json', `${JSON.stringify(map, null, 2)}\n`);
  };

  it('refuses a file outside the task and keeps nothing', async () => {
    const s = setup({ 'apps/web/src/pages/JourneyDesigner.tsx': 'new\n' });
    await run(s);
    const head = sh(s.repo.clone, 'git', ['rev-parse', 'release/1.4.0']);
    const rp = rpOf(s, head);
    const wt = await addPrepTaskWorktree(s.repo.clone, rp, join(tmp('aom-wt-'), 'task'));
    write(wt.path);
    put(wt.path, 'e2e/video/harness.ts', 'changed\n');
    const r = await finishPrepTask(wt, rp, commitAs);
    expect(r).toEqual({ ok: false, reason: 'changed files outside the task: e2e/video/harness.ts' });
    await removePrepTaskWorktree(wt);
    expect(existsSync(wt.path)).toBe(false);
  });

  it('refuses a task without its spec and narration', async () => {
    const s = setup({ 'apps/web/src/pages/JourneyDesigner.tsx': 'new\n' });
    const head = sh(s.repo.clone, 'git', ['rev-parse', 'release/1.4.0']);
    const rp = rpOf(s, head);
    const wt = await addPrepTaskWorktree(s.repo.clone, rp, join(tmp('aom-wt-'), 'task'));
    put(wt.path, 'e2e/video/journey-designer.spec.ts', 'spec\n');
    const r = await finishPrepTask(wt, rp, commitAs);
    expect(r).toEqual({ ok: false, reason: 'missing e2e/video/narration/journey-designer.ts' });
    await removePrepTaskWorktree(wt);
  });

  it('an authored spec is committed to the work ref, then rendered and added to media/videos', async () => {
    const f = fakeRecorder(tmp('aom-fake-'));
    process.env.AOM_PREP_VIDEO_CMD = f.cmd;
    const s = setup({ 'apps/web/src/pages/JourneyDesigner.tsx': 'new\n' });
    const plan = await run(s);
    expect((plan.report as { needsAuthoring?: { slug: string }[] }).needsAuthoring?.map((n) => n.slug)).toEqual([
      'journey-designer',
    ]);
    const head = sh(s.repo.clone, 'git', ['rev-parse', 'release/1.4.0']);
    const rp = rpOf(s, head);
    const wt = await addPrepTaskWorktree(s.repo.clone, rp, join(tmp('aom-wt-'), 'task'));
    write(wt.path);
    // the agent may commit on its own: it is folded into one commit
    sh(wt.path, 'git', ['add', 'e2e/video/journey-designer.spec.ts']);
    sh(wt.path, 'git', ['-c', 'user.name=x', '-c', 'user.email=x@example.test', 'commit', '-m', 'wip']);
    const done = await finishPrepTask(wt, rp, commitAs);
    await removePrepTaskWorktree(wt);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.files).toEqual([
      'e2e/video/journey-designer.spec.ts',
      'e2e/video/narration/journey-designer.ts',
      'e2e/video/screens.json',
    ]);
    expect(sh(s.repo.clone, 'git', ['rev-parse', rp.workRef])).toBe(done.commit);
    expect(sh(s.repo.clone, 'git', ['log', '-1', '--format=%an %s', done.commit])).toBe(
      'Release Owner docs(release): the journey-designer video script',
    );
    const render = await run(s, { phase: 'render', input: { plan: plan.report, authored: ['journey-designer'] } });
    expect(render.state).toBe('passed');
    expect(runs(f.count)).toEqual(['journey-designer']);
    const tree = workTree(s);
    for (const p of [
      'e2e/video/journey-designer.spec.ts',
      'media/videos/journey-designer.webm',
      'media/videos/journey-designer.mp4',
      'media/videos/journey-designer.vtt',
      'media/videos/journey-designer.json',
      'e2e/video/renders.json',
    ])
      expect(tree).toContain(p);
    const map = JSON.parse(
      sh(s.repo.clone, 'git', ['show', `${rp.workRef}:e2e/video/screens.json`]),
    ) as { videos: Record<string, unknown> };
    expect(Object.keys(map.videos)).toContain('journey-designer');
    // the release branch itself is untouched: only Commit results commits
    expect(sh(s.repo.clone, 'git', ['rev-parse', 'release/1.4.0'])).toBe(head);
  });
});
