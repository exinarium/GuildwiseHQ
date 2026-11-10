import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  killAndRemoveSync,
  killProcsUnder,
  ROOT_PREFIX,
  removeTree,
  sweepStaleRoots,
  useTmp,
} from './tmp-root.ts';

const VARS = ['TMPDIR', 'TMP', 'TEMP', 'AOM_AGENT_TMP_ROOT'] as const;

/*
 * Runs in vitest's main process before any test worker is forked: the workers inherit TMPDIR/AOM_AGENT_TMP_ROOT pointing
 * at a temp root of this run, so the run leaves nothing behind in the system temp dir (see test/tmp-root.ts).
 */
export default function setup(): () => Promise<void> {
  const base = tmpdir();
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  sweepStaleRoots(base);
  const root = mkdtempSync(join(base, `${ROOT_PREFIX}runner-`));
  useTmp(root);
  // vitest exits on SIGINT/SIGTERM with process.exit() and skips the teardown below; its test workers are still running
  const onExit = () => killAndRemoveSync(root);
  process.once('exit', onExit);
  return async () => {
    process.off('exit', onExit);
    await killProcsUnder(root);
    removeTree(root);
    // vitest's main process keeps going after the teardown (watch mode, reporters)
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}
