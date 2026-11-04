import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  capVideoReport,
  checkVideoVoice,
  libraryVoiceLabel,
  mapChangesToVideos,
  NO_VIDEO_HARNESS_NOTE,
  VIDEO_FILE_EXTS,
  VIDEO_OUT_DIR,
  VIDEO_RENDERS_PATH,
  VIDEO_RULE_TEXT,
  VIDEO_SCREEN_MAP_PATH,
  type VideoChange,
  type VideoMapping,
  type VideoRenders,
  VideoRendersSchema,
  type VideoReportEntry,
  type VideoScreenMap,
  VideoScreenMapSchema,
  type VideoStepReport,
  VideoStepReportSchema,
  type VoiceProbe,
  videoGlobMatches,
} from '@aom/shared';
import { git } from './git.ts';
import type { DocsPrepStepContext, DocsPrepStepOutcome, DocsPrepStepSpec } from './release-docs-prep-steps.ts';

/**
 * Release prep 'Generate videos'. `plan` (under the repository lock, short): the voice and ffmpeg preflight, the mapping
 * of the release's changes to the help videos, and the inputs hash that makes an unchanged re-run render nothing.
 * `render` (outside the lock, long): each chosen video is recorded with the existing harness
 * (`AOM_VIDEO_SLUG=<slug> pnpm --filter @aom/e2e video`, what e2e/video/record.sh runs) into a staging folder, then its
 * four files are copied to media/videos. The step only writes files; Commit results commits them.
 *
 * The voice is never chosen here: AOM_VIDEO_TTS / AOM_VIDEO_VOICE / AOM_VIDEO_SPEED are never set, and a workstation
 * whose voice is missing or differs from the existing videos fails with 'voice unavailable'.
 */

/** The harness files every video depends on (a change re-renders every chosen video's hash, not the selection). */
const HARNESS_FILES = [
  'e2e/video/harness.ts',
  'e2e/video/captions.ts',
  'e2e/video/seed.ts',
  'e2e/video/seed-history.ts',
  'e2e/video/seed-deploy.ts',
  'e2e/video/platform.ts',
  'e2e/video/ceo-act.ts',
  'e2e/video/defaults.ts',
  'e2e/video/voice.ts',
  'e2e/video/playwright.video.config.ts',
  'packages/video/src/voice.ts',
  'packages/video/src/ffmpeg.ts',
  'packages/video/src/captions.ts',
  'packages/video/src/audio.ts',
];
const RENDER_TIMEOUT_MS = 20 * 60_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const TAIL_LINES = 40;
const TAIL_CHARS = 2000;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isTest = () => process.env.NODE_ENV === 'test';

interface Ran {
  code: number | null;
  out: string;
}

/** Runs a command with a time limit, keeping the combined output (its tail is what a failure reports). */
function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (d: Buffer) => {
      out = (out + d.toString()).slice(-200_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      out += `\n(timed out after ${Math.round(opts.timeoutMs / 60_000)} min)`;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, out: `${out}\n${errMsg(e)}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

export const tailOf = (out: string): string => out.trim().split('\n').slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS);

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function screenMap(wt: string): Promise<VideoScreenMap | null | { error: string }> {
  const path = join(wt, VIDEO_SCREEN_MAP_PATH);
  if (!existsSync(path)) return null;
  const parsed = VideoScreenMapSchema.safeParse(await readJson(path).catch(() => null));
  return parsed.success ? parsed.data : { error: `${VIDEO_SCREEN_MAP_PATH} is not a valid screen map` };
}

async function rendersOf(wt: string): Promise<VideoRenders> {
  const path = join(wt, VIDEO_RENDERS_PATH);
  if (!existsSync(path)) return {};
  const parsed = VideoRendersSchema.safeParse(await readJson(path).catch(() => ({})));
  return parsed.success ? parsed.data : {};
}

async function sidecars(wt: string): Promise<{ voice?: unknown }[]> {
  const dir = join(wt, VIDEO_OUT_DIR);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'manifest.json' && !f.startsWith('.'));
  const out: { voice?: unknown }[] = [];
  for (const f of files) {
    const j = await readJson(join(dir, f)).catch(() => null);
    if (j && typeof j === 'object') out.push(j as { voice?: unknown });
  }
  return out;
}

/**
 * The voice and ffmpeg of this workstation, read from the repository's own packages/video code (node strips the
 * types), with the runner's environment. Tests replace the probe with AOM_PREP_VIDEO_PROBE (JSON), read only under test.
 */
async function probe(wt: string): Promise<VoiceProbe & { ffmpeg: string | null }> {
  if (isTest() && process.env.AOM_PREP_VIDEO_PROBE) return JSON.parse(process.env.AOM_PREP_VIDEO_PROBE);
  const voice = join(wt, 'packages/video/src/voice.ts');
  const ffmpeg = join(wt, 'packages/video/src/ffmpeg.ts');
  const script = [
    `const v = await import(${JSON.stringify(`file://${voice}`)});`,
    `let ff = null; try { const f = await import(${JSON.stringify(`file://${ffmpeg}`)}); await f.findFfmpeg(); } catch (e) { ff = String(e && e.message || e); }`,
    'process.stdout.write(JSON.stringify({ available: !!(await v.voiceAvailable()), label: v.VOICE_LABEL, ffmpeg: ff }));',
  ].join('\n');
  const r = await run(process.execPath, ['--input-type=module', '-e', script], { cwd: wt, timeoutMs: 60_000 });
  if (r.code !== 0) return { available: false, label: '(unknown voice)', ffmpeg: null, ...{ probeError: tailOf(r.out) } };
  const last = r.out.trim().split('\n').pop() ?? '{}';
  return JSON.parse(last);
}

/** The voice check of 5.6: null when the voice and ffmpeg are fine, else the failure. */
async function preflight(wt: string): Promise<{ error: string; voice: string | null } | { voice: string }> {
  const library = libraryVoiceLabel(await sidecars(wt));
  const p = await probe(wt);
  const voiceError = checkVideoVoice(p, library, hostname());
  if (voiceError) return { error: voiceError, voice: library.ok ? library.label : null };
  if (p.ffmpeg) return { error: `ffmpeg unavailable: ${p.ffmpeg}`, voice: p.label };
  return { voice: p.label };
}

/** The full diff of the release (the summary keeps only 50 paths per area). */
async function changesOf(repoPath: string, base: string, head: string): Promise<VideoChange[]> {
  const r = await git(repoPath, ['diff', '--name-status', '-z', '-M', base, head]);
  const t = r.stdout.split('\0').filter((x) => x !== '');
  const out: VideoChange[] = [];
  for (let i = 0; i < t.length; ) {
    const code = (t[i] as string)[0] as string;
    if (code === 'R' || code === 'C') {
      out.push({ path: t[i + 2] as string, oldPath: t[i + 1] as string, status: 'R' });
      i += 3;
    } else {
      out.push({ path: t[i + 1] as string, status: (code === 'A' || code === 'D' ? code : 'M') as VideoChange['status'] });
      i += 2;
    }
  }
  return out;
}

const KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;

async function cardsByPath(repoPath: string, base: string, head: string): Promise<Record<string, string[]>> {
  const r = await git(repoPath, ['log', '--format=%x1e%B%x1f', '--name-only', `${base}..${head}`]);
  const out: Record<string, Set<string>> = {};
  for (const entry of r.stdout.split('\x1e')) {
    const [body = '', names = ''] = entry.split('\x1f');
    const keys = body.match(KEY_RE) ?? [];
    if (keys.length === 0) continue;
    for (const path of names.split('\n').map((s) => s.trim()).filter(Boolean)) {
      const set = out[path] ?? new Set<string>();
      for (const k of keys) set.add(k);
      out[path] = set;
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

/** sha256 over the sorted `path blob` pairs of the files a video depends on, plus the voice label. */
export async function inputsHash(
  repoPath: string,
  commit: string,
  map: VideoScreenMap,
  slug: string,
  voice: string,
): Promise<string> {
  const tree = (await git(repoPath, ['ls-tree', '-r', '--format=%(path) %(objectname)', commit])).stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const i = l.lastIndexOf(' ');
      return [l.slice(0, i), l.slice(i + 1)] as const;
    });
  const globs = (map.videos[slug]?.screens ?? []).flatMap((s) => s.files);
  const own = new Set([`e2e/video/${slug}.spec.ts`, `e2e/video/narration/${slug}.ts`, ...HARNESS_FILES]);
  const picked = tree.filter(([path]) => own.has(path) || videoGlobMatches(globs, path)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const h = createHash('sha256');
  for (const [path, blob] of picked) h.update(`${path} ${blob}\n`);
  h.update(`voice ${voice}\n`);
  return h.digest('hex');
}

const specsIn = async (wt: string): Promise<string[]> => {
  const dir = join(wt, 'e2e/video');
  if (!existsSync(dir)) return [];
  return (await readdir(dir))
    .filter((f) => f.endsWith('.spec.ts'))
    .map((f) => f.replace(/\.spec\.ts$/, ''))
    .sort();
};

const noHarness = (): DocsPrepStepOutcome => ({
  ok: true,
  files: [],
  state: 'skipped',
  note: NO_VIDEO_HARNESS_NOTE,
  report: { harness: false, videos: [], shared: [], unmapped: [], ignoredCount: 0 },
});

const report = (r: VideoStepReport): Record<string, unknown> => capVideoReport(r) as unknown as Record<string, unknown>;

// ------------------------------------------------------------------------------------------------------------- plan

async function plan(ctx: DocsPrepStepContext): Promise<DocsPrepStepOutcome> {
  const map = await screenMap(ctx.worktree);
  if (map === null) return noHarness();
  if ('error' in map) return { ok: false, error: map.error };
  const head = ctx.start;
  const base = ctx.payload.base?.sha ?? ctx.summary?.base.sha;
  const pre = await preflight(ctx.worktree);
  const empty: VideoStepReport = {
    harness: true,
    rule: VIDEO_RULE_TEXT,
    voice: pre.voice,
    ...(base ? { base } : {}),
    head,
    videos: [],
    shared: [],
    unmapped: [],
    ignoredCount: 0,
  };
  if ('error' in pre) return { ok: false, error: pre.error, report: report(empty) };
  if (!base)
    return {
      ok: false,
      error: "Generate videos needs the start of the release: tick 'Analyse changes' and run again",
      report: report(empty),
    };

  const mapping: VideoMapping = mapChangesToVideos({
    changes: await changesOf(ctx.repoPath, base, head),
    map,
    specs: await specsIn(ctx.worktree),
    cardsByPath: await cardsByPath(ctx.repoPath, base, head),
  });
  const renders = await rendersOf(ctx.worktree);
  const videos: VideoReportEntry[] = [];
  for (const s of mapping.selected) {
    if (s.specMissing) {
      videos.push({ slug: s.slug, action: 'regenerate', reasons: s.reasons, state: 'failed', error: 'spec missing' });
      continue;
    }
    const inputs = await inputsHash(ctx.repoPath, head, map, s.slug, pre.voice);
    const done = renders[s.slug];
    if (done && done.inputs === inputs && done.voice === pre.voice)
      videos.push({
        slug: s.slug,
        action: 'up_to_date',
        reasons: [...s.reasons, `already rendered for this release (inputs unchanged since ${done.sourceSha.slice(0, 12)})`],
        state: 'skipped',
      });
    else videos.push({ slug: s.slug, action: 'regenerate', reasons: s.reasons, state: 'pending' });
  }
  for (const n of mapping.newVideos)
    videos.push({ slug: n.slug, title: n.title, action: 'create', reasons: n.reasons, state: 'pending' });
  const out: VideoStepReport = {
    ...empty,
    videos,
    shared: mapping.shared,
    unmapped: mapping.unmapped,
    ignoredCount: mapping.ignoredCount,
    needsAuthoring: mapping.newVideos,
  };
  const missing = videos.filter((v) => v.state === 'failed');
  if (missing.length > 0)
    return {
      ok: false,
      error: `${missing.length} video(s) failed: ${missing.map((v) => `${v.slug}: spec missing`).join('; ')}`,
      report: report(out),
    };
  return { ok: true, files: [], report: report(out) };
}

// ----------------------------------------------------------------------------------------------------------- render

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });

/** The command that records one video; tests replace it with AOM_PREP_VIDEO_CMD (read only under test). */
function recordCommand(): { cmd: string; args: string[]; build: boolean } {
  const fake = isTest() ? process.env.AOM_PREP_VIDEO_CMD : undefined;
  if (fake) return { cmd: fake, args: [], build: false };
  return { cmd: 'pnpm', args: ['--filter', '@aom/e2e', 'video'], build: true };
}

const cacheDir = (dataDir: string, repoId: string, slug: string) =>
  join(dataDir, 'release-prep', 'videos', repoId, slug);

async function fromCache(dir: string | null, inputs: string, stage: string): Promise<boolean> {
  if (!dir) return false;
  const hit = join(dir, inputs);
  if (!existsSync(hit)) return false;
  await mkdir(stage, { recursive: true });
  for (const f of await readdir(hit)) await copyFile(join(hit, f), join(stage, f));
  return true;
}

async function toCache(dir: string | null, inputs: string, stage: string): Promise<void> {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, inputs), { recursive: true });
  for (const f of await readdir(stage)) await copyFile(join(stage, f), join(dir, inputs, f));
}

const sortedJson = (v: VideoRenders): string =>
  `${JSON.stringify(
    Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => {
          const e = v[k] as VideoRenders[string];
          return [k, { inputs: e.inputs, sourceSha: e.sourceSha, voice: e.voice }];
        }),
    ),
    null,
    2,
  )}\n`;

async function render(ctx: DocsPrepStepContext): Promise<DocsPrepStepOutcome> {
  const map = await screenMap(ctx.worktree);
  if (map === null) return noHarness();
  if ('error' in map) return { ok: false, error: map.error };
  const parsed = VideoStepReportSchema.safeParse(ctx.input?.plan);
  if (!parsed.success) return { ok: false, error: 'the render phase got no plan: run the prep again' };
  const planned = parsed.data;
  const authored = new Set(Array.isArray(ctx.input?.authored) ? (ctx.input?.authored as string[]) : []);
  const pre = await preflight(ctx.worktree);
  const videos: VideoReportEntry[] = planned.videos.map((v) => ({ ...v }));
  const out: VideoStepReport = { ...planned, voice: pre.voice, videos, needsAuthoring: undefined };
  if ('error' in pre) return { ok: false, error: pre.error, report: report(out) };

  // A new video is rendered only once its spec was written by the author phase.
  const todo = videos.filter(
    (v) => v.state === 'pending' && (v.action === 'regenerate' || (v.action === 'create' && authored.has(v.slug))),
  );
  for (const v of videos)
    if (v.state === 'pending' && v.action === 'create' && !authored.has(v.slug)) {
      v.state = 'failed';
      v.error = 'no video script was written for this new screen';
    }
  if (todo.length === 0 && !videos.some((v) => v.state === 'failed'))
    return { ok: true, files: [], report: report(out) };

  const rec = recordCommand();
  if (rec.build && todo.length > 0) {
    for (const [cmd, args] of [
      ['pnpm', ['install', '--frozen-lockfile', '--prefer-offline']],
      ['pnpm', ['build']],
    ] as const) {
      const r = await run(cmd, [...args], { cwd: ctx.worktree, timeoutMs: BUILD_TIMEOUT_MS });
      if (r.code !== 0) return { ok: false, error: `build failed: ${tailOf(r.out)}`, report: report(out) };
    }
  }

  const stageRoot = join(tmpdir(), `aom-prep-video-${ctx.payload.runId.slice(0, 8)}-${ctx.payload.repoId.slice(0, 8)}`);
  const db = `aom_prep_video_${ctx.payload.runId.replace(/-/g, '').slice(0, 8)}`;
  const renders = await rendersOf(ctx.worktree);
  const files: string[] = [];
  try {
    for (const v of todo) {
      const stage = join(stageRoot, `out-${v.slug}`);
      await rm(stage, { recursive: true, force: true });
      await mkdir(stage, { recursive: true });
      const inputs = await inputsHash(ctx.repoPath, ctx.start, map, v.slug, pre.voice);
      const cache = ctx.dataDir ? cacheDir(ctx.dataDir, ctx.payload.repoId, v.slug) : null;
      let reused = false;
      if (await fromCache(cache, inputs, stage)) reused = true;
      else {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          AOM_VIDEO_SLUG: v.slug,
          AOM_VIDEO_OUT: stage,
          AOM_VIDEO_PORT: String(await freePort()),
          AOM_VIDEO_DB: db,
          AOM_VIDEO_DIR_BASE: stageRoot,
        };
        const r = await run(rec.cmd, rec.args, { cwd: ctx.worktree, env, timeoutMs: RENDER_TIMEOUT_MS });
        if (r.code !== 0) {
          v.state = 'failed';
          v.error = tailOf(r.out) || `the recording exited with ${r.code}`;
          continue;
        }
      }
      const missing = VIDEO_FILE_EXTS.filter((ext) => !existsSync(join(stage, `${v.slug}.${ext}`)));
      if (missing.length > 0) {
        v.state = 'failed';
        v.error = `the recording did not write ${missing.map((e) => `${v.slug}.${e}`).join(', ')}`;
        continue;
      }
      const side = (await readJson(join(stage, `${v.slug}.json`)).catch(() => null)) as {
        voice?: unknown;
        duration?: unknown;
      } | null;
      if (side?.voice !== pre.voice) {
        v.state = 'failed';
        v.error = `the recording used the voice ${String(side?.voice)}, the videos use ${pre.voice}`;
        continue;
      }
      if (!reused) await toCache(cache, inputs, stage);
      await mkdir(join(ctx.worktree, VIDEO_OUT_DIR), { recursive: true });
      const mine: string[] = [];
      for (const ext of VIDEO_FILE_EXTS) {
        const rel = `${VIDEO_OUT_DIR}/${v.slug}.${ext}`;
        await copyFile(join(stage, `${v.slug}.${ext}`), join(ctx.worktree, rel));
        mine.push(rel);
      }
      const mb = async (ext: string) =>
        Math.round(((await stat(join(stage, `${v.slug}.${ext}`))).size / 1_048_576) * 10) / 10;
      v.mb = { webm: await mb('webm'), mp4: await mb('mp4') };
      if (typeof side?.duration === 'number') v.duration = side.duration;
      v.state = 'rendered';
      if (reused) {
        v.action = 'reused';
        v.reasons = [...v.reasons, 'reused render (inputs unchanged)'];
      }
      v.files = mine;
      files.push(...mine);
      renders[v.slug] = { inputs, sourceSha: ctx.start, voice: pre.voice };
    }
  } finally {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    if (rec.build)
      await run('psql', ['-h', '127.0.0.1', '-p', '5433', '-c', `DROP DATABASE IF EXISTS ${db}`], {
        cwd: ctx.worktree,
        timeoutMs: 30_000,
      }).catch(() => undefined);
  }
  const bad = videos.filter((v) => v.state === 'failed');
  if (bad.length > 0)
    return {
      ok: false,
      error: `${bad.length} video(s) failed: ${bad.map((v) => `${v.slug}: ${(v.error ?? '').split('\n')[0]}`).join('; ')}`,
      report: report(out),
    };
  if (files.length > 0) {
    await writeFile(join(ctx.worktree, VIDEO_RENDERS_PATH), sortedJson(renders));
    files.push(VIDEO_RENDERS_PATH);
  }
  return { ok: true, files, report: report(out) };
}

export const videosStep: DocsPrepStepSpec = {
  unlocked: ['render'],
  run: async (ctx) => {
    if (ctx.phase === 'plan') return plan(ctx);
    if (ctx.phase === 'render') return render(ctx);
    return { ok: false, error: `the videos step has no runner phase '${ctx.phase}'` };
  },
};
