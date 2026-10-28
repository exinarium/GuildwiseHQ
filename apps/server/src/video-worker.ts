import { parseArgs } from 'node:util';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { clipCatalogForPrompt, loadClipCatalog } from './video/clips.ts';
import { renderScriptFile } from './video/renders.ts';
import { videoTick } from './video/sweep.ts';

async function runLoop(intervalSeconds: number): Promise<void> {
  const app = await createApp(loadConfig(), { background: false });
  const ctx = app.ctx;
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stopping = true));
  console.log(`video worker started (videos in ${ctx.config.videoDir})`);
  while (!stopping) {
    let busy = false;
    try {
      const r = await videoTick(ctx);
      busy = r.rendered || r.uploaded;
      if (busy) console.log(JSON.stringify({ at: new Date().toISOString(), ...r }));
    } catch (err) {
      console.error('video tick failed:', err instanceof Error ? err.message : err);
    }
    // after work, look again at once (more may be queued); idle, wait
    if (!busy) await new Promise((res) => setTimeout(res, intervalSeconds * 1000));
  }
  await app.close();
}

/**
 * The video worker entry (`node dist/video-worker.mjs`). A CLI that renders one script file, and the queue loop:
 *   node dist/video-worker.mjs --render script.json --out dir [--silent] [--cover name]
 *   node dist/video-worker.mjs --list-clips
 *   node dist/video-worker.mjs --loop [--interval 15]
 * `--loop` is the container's command: every few seconds a heartbeat, and (only when a YouTube channel is connected and
 * `videoPosts.enabled`) claim one queued render, upload one approved video a day, clean up old files (video/sweep.ts).
 * It shares the database, config and AOM_SECRET_KEY with the app and writes to AOM_VIDEO_DIR.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      render: { type: 'string' },
      out: { type: 'string' },
      silent: { type: 'boolean', default: false },
      cover: { type: 'string' },
      'list-clips': { type: 'boolean', default: false },
      loop: { type: 'boolean', default: false },
      interval: { type: 'string', default: '15' },
    },
  });
  if (values['list-clips']) {
    console.log(JSON.stringify(clipCatalogForPrompt(loadClipCatalog()), null, 2));
    return;
  }
  if (values.loop) return runLoop(Math.max(1, Number(values.interval) || 15));
  if (!values.render || !values.out) {
    console.error(
      'usage: video-worker --render <script.json> --out <dir> [--silent] [--cover <name>] | --list-clips | --loop',
    );
    process.exit(2);
  }
  const r = await renderScriptFile(values.render, {
    outDir: values.out,
    silentFallback: values.silent,
    coverName: values.cover,
    log: (l) => console.log(l),
  });
  console.log(
    JSON.stringify(
      {
        artifacts: r.artifacts,
        durationSeconds: r.durationSeconds,
        bytes: r.bytes,
        size: `${r.width}x${r.height}`,
        voice: r.voice,
        renderSeconds: r.renderSeconds,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
