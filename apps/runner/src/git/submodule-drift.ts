import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { git } from './git.ts';

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
 * Where this superproject keeps its submodules' repositories (`<git dir>/modules`; per worktree for a linked one), as a
 * real path. Null when git cannot say.
 */
export async function modulesRoot(worktree: string): Promise<string | null> {
  const r = await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'modules']);
  const dir = r.stdout.trim();
  if (r.exitCode !== 0 || !dir) return null;
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir); // not created yet: no submodule can live under it
  }
}

/**
 * The submodule's repository, read without running git inside it: `<path>/.git` must be a plain file naming a gitdir
 * that resolves (real path) under the superproject's `modules/` folder. A `.git` directory (a fresh `git init`), a
 * symbolic link, or a gitdir anywhere else is agent-owned content, not a submodule this runner manages: null.
 */
export function managedGitDir(abs: string, modules: string): string | null {
  const dotGit = join(abs, '.git');
  try {
    if (!lstatSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8').slice(0, 4096));
    if (!m?.[1]) return null;
    const real = realpathSync(resolve(abs, m[1].trim()));
    return real.startsWith(`${modules}${sep}`) ? real : null;
  } catch {
    return null;
  }
}

/**
 * Before the guard of an outcome report (BLOCKERS.md section 3): every initialised submodule whose checked-out commit
 * differs from the pin in the index, with nothing uncommitted inside, is reset to the pin (`git submodule update
 * --checkout --no-fetch`). Otherwise the leftovers commit (`git add -A`) would commit the drift as a pin change, or the
 * reviewers would see a pin change nobody made. Agent sandboxes cannot run `git submodule update` themselves, so
 * refusing a drift would only loop the card.
 *
 * This runs on the workstation, outside the sandbox, on content the agent can write (the index, `<path>/.git`), so it
 * never contacts a remote: no fetch, transports disabled (`protocol.allow=never`), no credentials. A pin the
 * submodule's clone does not have is refused with advice to ask (fetching it belongs to worktree preparation). No git
 * command runs inside a submodule whose `.git` does not lead under the superproject's `modules/` folder: refused.
 *
 * Refused (nothing reset for that submodule) when the submodule has uncommitted changes of its own (they would be lost
 * or committed by accident), the pin is not in its clone, or it is not a submodule this runner manages. A pin change
 * committed or staged on the card branch is the index entry itself, so it is never drift. A submodule that is not
 * initialised (no `.git`) is left alone.
 */
export async function resetSubmoduleDrift(worktree: string): Promise<SubmoduleDriftResult> {
  const result: SubmoduleDriftResult = { reset: [] };
  const problems: string[] = [];
  const links = await gitlinks(worktree);
  const modules = links.length ? await modulesRoot(worktree) : null;
  for (const { path, pin } of links) {
    const abs = join(worktree, path);
    // not initialised (no .git of its own): nothing is checked out, and git would answer for the superproject
    if (!existsSync(join(abs, '.git'))) continue;
    if (!modules || !managedGitDir(abs, modules)) {
      problems.push(
        `the submodule ${path} is not a checkout the runner manages (its .git does not lead to the repository's modules folder), so the runner will not touch it: remove what you put at ${path}, or ask with \`aom question --topic environment\``,
      );
      continue;
    }
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
        `the submodule ${path} is at ${short(head)} instead of its pinned ${short(pin)} and has uncommitted changes inside (${files.slice(0, 5).join(', ') || 'git status failed'}): you do not change a submodule; undo those changes, or commit a pin change if the card really needs one`,
      );
      continue;
    }
    const cannot = (why: string) =>
      problems.push(
        `the submodule ${path} is at ${short(head)} instead of its pinned ${short(pin)} and the runner could not reset it (${why}). You cannot fix this from your sandbox: ask with \`aom question --topic environment\` and name the submodule and the pinned commit`,
      );
    // only what the submodule's clone already has: nothing is fetched here
    if (
      (await git(abs, ['-c', 'protocol.allow=never', 'cat-file', '-e', `${pin}^{commit}`])).exitCode !== 0
    ) {
      cannot("the pinned commit is not in the submodule's clone");
      continue;
    }
    // --checkout: never the `update = rebase|merge|none` of .gitmodules, which would rewrite or skip the submodule
    const r = await git(worktree, [
      '-c',
      'protocol.allow=never',
      'submodule',
      'update',
      '--checkout',
      '--no-fetch',
      '--',
      path,
    ]);
    const now = (await git(abs, ['rev-parse', 'HEAD'])).stdout.trim();
    if (r.exitCode !== 0 || now !== pin) {
      cannot((r.stderr || r.stdout).trim().slice(0, 300) || `it is at ${short(now)}`);
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
