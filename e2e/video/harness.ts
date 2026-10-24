import { copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, type Browser, expect, type Page } from '@playwright/test';
import { E2E_DIR, ROOT } from '../support/env.ts';
import { caption, installOverlays, sleep } from './captions.ts';
import type { Cue, NarratedChapter } from './narration/types.ts';
import { mux, type Spoken, speak, toMp4, VOICE_LABEL, vtt } from './voice.ts';

/**
 * The recording harness shared by every `e2e/video/<slug>.spec.ts`: it speaks the narration (Kokoro, offline), films
 * the real UI with Playwright's `recordVideo`, waits for every passage to finish, mixes the voice into the recording
 * and writes the four output files. A spec only keeps what is its own: its seeding and the clicks of each passage.
 *
 * Output (served by the app as static files, read by the Help page, the tour and the "Watch the video" button):
 *   <OUT_DIR>/<slug>.webm  .mp4  .vtt  .json     OUT_DIR is media/videos, or AOM_VIDEO_OUT
 */
export const OUT_DIR = process.env.AOM_VIDEO_OUT ?? join(ROOT, 'media/videos');
const RAW_DIR = join(E2E_DIR, 'video-raw');
const PACE = Number(process.env.AOM_VIDEO_PACE ?? 1); // pauses between actions; 0.5 is twice as fast (the voice sets the pace)
/** A pause between actions, scaled by AOM_VIDEO_PACE. */
export const pause = (ms: number) => sleep(ms * PACE);
const GAP = 0.7; // seconds of quiet after every passage
const MAX_BYTES = 20 * 1024 * 1024;

export interface VideoScript {
  /** File name stem: `media/videos/<slug>.*`. Must match the key in apps/web/src/lib/videos.ts. */
  slug: string;
  /** Shown above the player and written to the chapters JSON. */
  title: string;
  /** Every passage, in order (intro, the cues of the chapters, outro). */
  cues: Cue[];
  /** The chapter list shown under the video. `chapter(n)` marks chapter n and shows its banner. */
  chapters: NarratedChapter[];
}

export interface Prepared {
  script: VideoScript;
  spoken: Map<string, Spoken>;
}

/**
 * Before the camera rolls (and before the runner starts): speaks all the narration, and, when the video needs the
 * BA to answer a scripted question, writes the reply map the recording-only mock runtime reads. Call it before
 * `pairWorkstation`, because the runner reads AOM_MOCK_REPLIES_FILE when it starts.
 */
export function prepareVideo(script: VideoScript, replies?: Record<string, string>): Prepared {
  const spoken = new Map(speak(script.cues).map((s) => [s.id, s]));
  mkdirSync(E2E_DIR, { recursive: true });
  if (replies) {
    const file = join(E2E_DIR, 'video-replies.json');
    writeFileSync(file, JSON.stringify(replies));
    process.env.AOM_MOCK_REPLIES_FILE = file;
  }
  return { script, spoken };
}

/** Recording only: the follow-up "Full E2E suite after ..." cards are noise for a viewer, so the page hides them. */
const HIDE_FULL_E2E = `(() => {
    const hide = () => {
      const walker = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!(n.nodeValue || '').includes('Full E2E suite')) continue;
        // a board tile, else the short "spawned card" row on the card page (never anything bigger)
        const el = n.parentElement && (n.parentElement.closest('[data-testid^="card-tile-"]') || n.parentElement);
        if (el && el !== document.body && (el.textContent || '').length < 160) el.style.display = 'none';
      }
    };
    new MutationObserver(hide).observe(document, { childList: true, subtree: true, characterData: true });
    setInterval(hide, 200);
  })();`;

export interface Recording {
  page: Page;
  /** Speaks the passage while `actions` run on screen; then waits until the voice has finished (and a breath more). */
  narrate: (id: string, actions?: () => Promise<void>) => Promise<void>;
  /** Marks chapter `n` (1-based) at this moment and shows its banner. */
  chapter: (n: number) => Promise<void>;
  /** Seconds since the camera started. */
  now: () => number;
  /** Closes the page, mixes the voice in and writes the .webm, .mp4, .vtt and .json. Returns the length in seconds. */
  finish: () => Promise<number>;
}

/** Opens the recorded page, logged in as `api`'s user, and starts the clock. */
export async function startRecording(
  prepared: Prepared,
  browser: Browser,
  api: APIRequestContext,
): Promise<Recording> {
  const { script, spoken } = prepared;
  rmSync(RAW_DIR, { recursive: true, force: true });
  const ctx = await browser.newContext({
    storageState: await api.storageState(),
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: RAW_DIR, size: { width: 1280, height: 720 } },
  });
  await installOverlays(ctx);
  await ctx.addInitScript(HIDE_FULL_E2E);
  const t0 = Date.now();
  const page = await ctx.newPage();
  const now = () => (Date.now() - t0) / 1000;
  const chapters: Array<{ t: number; title: string }> = [];
  const timeline: Array<{ id: string; text: string; start: number; end: number; file: string }> = [];
  const textOf = new Map(script.cues.map((c) => [c.id, c.text]));

  const narrate: Recording['narrate'] = async (id, actions) => {
    const s = spoken.get(id);
    if (!s) throw new Error(`no audio for ${id}`);
    const start = now();
    const end = start + s.duration;
    timeline.push({ id, text: textOf.get(id) ?? '', start, end, file: s.file });
    if (actions) await actions();
    const rest = end + GAP - now();
    if (rest > 0) await sleep(rest * 1000);
  };
  const chapter: Recording['chapter'] = async (n) => {
    const c = script.chapters[n - 1];
    if (!c) throw new Error(`no chapter ${n}`);
    chapters.push({ t: Math.max(0, Math.round(now() * 10) / 10), title: c.title });
    await caption(page, c.banner, n);
  };

  const finish = async () => {
    const duration = Math.round(now() * 10) / 10;
    const video = page.video();
    await ctx.close();
    const raw = await video?.path();
    expect(raw).toBeTruthy();
    mkdirSync(OUT_DIR, { recursive: true });
    const base = join(OUT_DIR, script.slug);
    const dest = `${base}.webm`;
    try {
      mux(
        raw as string,
        timeline.map((c) => ({ file: c.file, start: c.start })),
        dest,
      );
    } catch (e) {
      copyFileSync(raw as string, dest);
      throw new Error(`the narration could not be mixed in (is ffmpeg set up? see setup-voice.sh): ${e}`);
    }
    const bytes = statSync(dest).size;
    expect(bytes, 'the video must stay under 20 MB').toBeLessThan(MAX_BYTES);
    toMp4(dest, `${base}.mp4`);
    expect(statSync(`${base}.mp4`).size, 'the MP4 must stay under 20 MB').toBeLessThan(MAX_BYTES);
    writeFileSync(`${base}.vtt`, vtt(timeline));
    writeFileSync(
      `${base}.json`,
      `${JSON.stringify(
        {
          title: script.title,
          src: `/videos/${script.slug}.webm`,
          type: 'video/webm',
          sources: [
            { src: `/videos/${script.slug}.mp4`, type: 'video/mp4' },
            { src: `/videos/${script.slug}.webm`, type: 'video/webm' },
          ],
          captions: `/videos/${script.slug}.vtt`,
          voice: VOICE_LABEL,
          duration,
          chapters,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`video: ${dest} ${(bytes / 1024 / 1024).toFixed(1)} MB, ${duration}s`);
    return duration;
  };

  return { page, narrate, chapter, now, finish };
}
