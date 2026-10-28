import { parseArgs } from 'node:util';
import { clipCatalogForPrompt, loadClipCatalog } from './video/clips.ts';
import { renderScriptFile } from './video/renders.ts';

/**
 * The video worker entry (`node dist/video-worker.mjs`). For now a CLI that renders one script file:
 *   node dist/video-worker.mjs --render script.json --out dir [--silent] [--cover name]
 *   node dist/video-worker.mjs --list-clips
 * The queue loop (claim a render, heartbeat, upload) arrives with the review flow.
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
    },
  });
  if (values['list-clips']) {
    console.log(JSON.stringify(clipCatalogForPrompt(loadClipCatalog()), null, 2));
    return;
  }
  if (values.loop)
    throw new Error('the render queue loop is not built yet; use --render <script.json> --out <dir>');
  if (!values.render || !values.out) {
    console.error(
      'usage: video-worker --render <script.json> --out <dir> [--silent] [--cover <name>] | --list-clips',
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
