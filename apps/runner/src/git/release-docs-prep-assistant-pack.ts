import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ASSISTANT_PACK_DIR, ASSISTANT_PACK_GENERATOR_PATH, NO_ASSISTANT_PACK_NOTE } from '@aom/shared';
import { git } from './git.ts';
import type { DocsPrepStepHandler } from './release-docs-prep-steps.ts';

const tail = (s: string, n = 20): string => s.trim().split('\n').slice(-n).join('\n');

/**
 * Paths changed in the worktree (untracked files one by one). Read with `-z`, so a path with spaces or unusual characters
 * comes unquoted; a rename entry is followed by its old path, which is skipped.
 */
export async function changedPaths(wt: string): Promise<string[]> {
  const fields = (await git(wt, ['status', '--porcelain', '-z', '-uall'])).stdout.split('\0');
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] as string;
    if (f.length < 4) continue;
    out.push(f.slice(3));
    if (f[0] === 'R' || f[0] === 'C') i++;
  }
  return out;
}

/**
 * Release prep step 'assistant-pack': regenerates the assistant knowledge pack (`pnpm --filter @aom/server
 * assistant:pack`) in the throwaway worktree, after the Help articles step applied its edits, so a release whose Help
 * changed ships a pack that matches it. The generator is project code: it runs through `ctx.exec`, inside the runner's
 * sandbox (the worktree writable; the runner's data, credentials and secrets hidden; a scrubbed environment with the
 * toolchain PATH), never as the runner user, never in a writer shift and never on the server. No sandbox: the step
 * fails. The path check below limits what gets committed. A repository without the generator is skipped with a note.
 * Only files under the pack folder may change; the generator is byte-stable, so a retry on a branch that has the pack
 * already changes nothing.
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
