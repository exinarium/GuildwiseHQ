import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git, type RemoteAuth } from './git.ts';

/** A submodule checked out at another commit than the one the card branch pins (its index entry). */
export interface SubmoduleDrift {
  path: string;
  /** The commit the submodule was checked out at. */
  from: string;
  /** The pinned commit it was reset to. */
  pin: string;
}

export interface SubmoduleDriftResult {
  /** Submodules that were reset to their pin. */
  reset: SubmoduleDrift[];
  /** Set when a drifted submodule could not be reset: the builder's handoff is refused with this text. */
  refused?: string;
}

const GITLINK = '160000';
const FETCH_TIMEOUT_MS = 5 * 60_000;

/** The submodules of the worktree's index: `{ path, pin }` for every gitlink (mode 160000, stage 0). */
async function gitlinks(worktree: string): Promise<Array<{ path: string; pin: string }>> {
  const r = await git(worktree, ['ls-files', '-s', '-z']);
  if (r.exitCode !== 0) return [];
  const out: Array<{ path: string; pin: string }> = [];
  for (const entry of r.stdout.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [mode, sha, stage] = entry.slice(0, tab).split(' ');
    if (mode === GITLINK && sha && stage === '0') out.push({ path: entry.slice(tab + 1), pin: sha });
  }
  return out;
}

const short = (sha: string): string => sha.slice(0, 10);

/**
 * At a builder's handoff (BLOCKERS.md section 3): every initialised submodule whose checked-out commit differs from the
 * pin in the index, with nothing uncommitted inside, is reset to the pin (`git submodule update --no-fetch`; when the pin
 * is not in the submodule's clone, once more after a fetch with the runner's credentials). Otherwise the leftovers commit
 * (`git add -A`) would commit the drift as a pin change, or the reviewers would see a pin change nobody made. Agent
 * sandboxes cannot run `git submodule update` themselves, so refusing a drift would only loop the card.
 *
 * Refused (nothing reset for that submodule) only when the submodule has uncommitted changes of its own (they would be
 * lost or committed by accident) or the pin cannot be checked out. A pin change committed or staged on the card branch
 * is the index entry itself, so it is never drift. A submodule that is not initialised is left alone.
 */
export async function resetSubmoduleDrift(
  worktree: string,
  opts: { auth?: RemoteAuth; fetchTimeoutMs?: number } = {},
): Promise<SubmoduleDriftResult> {
  const result: SubmoduleDriftResult = { reset: [] };
  const problems: string[] = [];
  for (const { path, pin } of await gitlinks(worktree)) {
    const abs = join(worktree, path);
    // not initialised (no .git of its own): nothing is checked out, and git would answer for the superproject
    if (!existsSync(join(abs, '.git'))) continue;
    const headR = await git(abs, ['rev-parse', 'HEAD']);
    const head = headR.stdout.trim();
    if (headR.exitCode !== 0 || !head || head === pin) continue;
    const status = await git(abs, ['status', '--porcelain', '--untracked-files=all']);
    if (status.exitCode !== 0 || status.stdout.trim()) {
      const files = status.stdout
        .split('\n')
        .map((l) => l.slice(3).trim())
        .filter(Boolean);
      problems.push(
        `the submodule ${path} is at ${short(head)} instead of its pinned ${short(pin)} and has uncommitted changes inside (${files.slice(0, 5).join(', ') || 'git status failed'}): a builder does not change a submodule; undo those changes, or commit a pin change if the card really needs one`,
      );
      continue;
    }
    const update = () =>
      // --checkout: never the `update = rebase|merge|none` of .gitmodules, which would rewrite or skip the submodule
      git(worktree, [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'update',
        '--checkout',
        '--no-fetch',
        '--',
        path,
      ]);
    let r = await update();
    if (r.exitCode !== 0) {
      // the pin is not in the submodule's clone: fetch it once, with the runner's credentials
      const url = (await git(abs, ['remote', 'get-url', 'origin'])).stdout.trim();
      let a: { args: string[]; env: Record<string, string> } = { args: [], env: {} };
      try {
        if (opts.auth && url) a = await opts.auth(url);
      } catch {
        // no credentials: the fetch below tries without them
      }
      const timeoutMs = opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
      await git(abs, [...a.args, '-c', 'protocol.file.allow=always', 'fetch', 'origin'], {
        env: a.env,
        timeoutMs,
      });
      if ((await git(abs, ['cat-file', '-e', `${pin}^{commit}`])).exitCode !== 0)
        await git(abs, [...a.args, '-c', 'protocol.file.allow=always', 'fetch', 'origin', pin], {
          env: a.env,
          timeoutMs,
        });
      r = await update();
    }
    const now = (await git(abs, ['rev-parse', 'HEAD'])).stdout.trim();
    if (r.exitCode !== 0 || now !== pin) {
      problems.push(
        `the submodule ${path} is at ${short(now || head)} instead of its pinned ${short(pin)} and the runner could not reset it (${(r.stderr || r.stdout).trim().slice(0, 300) || 'the pinned commit is not available'}). You cannot fix this from your sandbox: ask with \`aom question --topic environment\` and name the submodule and the pinned commit`,
      );
      continue;
    }
    result.reset.push({ path, from: head, pin });
  }
  if (problems.length) result.refused = problems.join('; ');
  return result;
}

/** The card comment for submodules the runner reset to their pin at a handoff. */
export function submoduleResetNote(reset: readonly SubmoduleDrift[]): string {
  const list = reset.map((d) => `${d.path} (${short(d.from)} -> ${short(d.pin)})`).join(', ');
  return `The runner reset ${reset.length === 1 ? 'a submodule' : 'submodules'} that ${reset.length === 1 ? 'was' : 'were'} checked out off the pinned commit back to the pin before the handoff: ${list}. No pin change was committed for ${reset.length === 1 ? 'it' : 'them'}; the build and tests in the handoff evidence ran before this reset.`;
}
