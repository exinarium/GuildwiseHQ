import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ASSISTANT_PACK_DIR, ASSISTANT_PACK_GENERATOR_PATH, NO_ASSISTANT_PACK_NOTE } from '@aom/shared';
import { git } from './git.ts';
import type { DocsPrepStepHandler } from './release-docs-prep-steps.ts';

const tail = (s: string, n = 20): string => s.trim().split('\n').slice(-n).join('\n');

/** Paths changed in the worktree (untracked files one by one). */
async function changedPaths(wt: string): Promise<string[]> {
  return (await git(wt, ['status', '--porcelain', '-uall'])).stdout
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .map((p) => (p.includes(' -> ') ? (p.split(' -> ')[1] as string) : p));
}

/**
 * Release prep step 'assistant-pack': regenerates the assistant knowledge pack (`pnpm --filter @aom/server
 * assistant:pack`) in the throwaway worktree, after the Help articles step applied its edits, so a release whose Help
 * changed ships a pack that matches it. The generator is project code: it runs here, through `ctx.exec` (the runner's
 * own process with the toolchain PATH, the way the guide step builds the PDF), never in a writer shift and never on the
 * server. A repository without the generator is skipped with a note. Only files under the pack folder may change; the
 * generator is byte-stable, so a retry on a branch that has the pack already changes nothing.
 */
export const assistantPackStep: DocsPrepStepHandler = async (ctx) => {
  const wt = ctx.worktree;
  if (!existsSync(join(wt, ASSISTANT_PACK_GENERATOR_PATH)))
    return { ok: true, files: [], state: 'skipped', note: NO_ASSISTANT_PACK_NOTE };
  const steps: Array<[string, string[], number]> = [
    ['corepack', ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'], 10 * 60_000],
    ['corepack', ['pnpm', '--filter', '@aom/server', 'assistant:pack'], 5 * 60_000],
  ];
  for (const [cmd, args, timeoutMs] of steps) {
    const r = await ctx.exec(cmd, args, { cwd: wt, timeoutMs });
    if (r.exitCode !== 0 || r.timedOut)
      return {
        ok: false,
        error: `the assistant knowledge pack could not be regenerated: ${r.timedOut ? 'timed out' : tail(`${r.stdout}\n${r.stderr}`)}`,
      };
  }
  const changed = await changedPaths(wt);
  const outside = changed.filter((p) => relative(ASSISTANT_PACK_DIR, p).startsWith('..'));
  if (outside.length > 0)
    return { ok: false, error: `regenerating the assistant knowledge pack changed ${outside.join(', ')}` };
  return { ok: true, files: changed, report: { regenerated: changed.length } };
};
