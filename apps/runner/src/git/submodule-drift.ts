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
 * symbolic link or a gitdir anywhere else is agent-owned content, not a submodule this runner manages: null.
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
 * The commit a submodule is checked out at, when it differs from the pin in the index; null when it is on its pin (or
 * is not checked out). Asked of the SUPERPROJECT (`git diff -- <path>` prints `+Subproject commit <sha>`): git resolves
 * the submodule's HEAD in-process, in whatever ref format it uses, and with `--ignore-submodules=dirty` (added by
 * `git()`) starts nothing inside it. So this agrees with what `git status` shows for the gitlink, by construction.
 */
export async function submoduleCommitOffPin(worktree: string, path: string): Promise<string | null> {
  const r = await git(worktree, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--', path]);
  if (r.exitCode !== 0) return null;
  return /^\+Subproject commit ([0-9a-f]{40,64})/m.exec(r.stdout)?.[1] ?? null;
}

/**
 * Before the guard of an outcome report (BLOCKERS.md section 3): a checked-out submodule whose commit differs from the
 * pin in the index is reported to the agent with the one command that puts it back. The agent can run that in its
 * sandbox; the runner cannot safely do it, because git inside a submodule reads that submodule's own configuration,
 * which the agent can write (a `clean` filter or a diff driver there would run on the workstation). So the commit is
 * asked of the superproject (`submoduleCommitOffPin`) and no git is run inside any submodule. The name and the result shape are kept
 * from the version that reset the drift itself: `reset` is always empty now.
 *
 * A pin change committed or staged on the card branch is the index entry itself, so it is never drift. A submodule
 * that is not initialised (no `.git`) is left alone. The leftovers commit never stages a gitlink (git.ts), so a
 * drift that is not put back is not committed as a pin change.
 */
export async function resetSubmoduleDrift(worktree: string): Promise<SubmoduleDriftResult> {
  const result: SubmoduleDriftResult = { reset: [] };
  const problems: string[] = [];
  const links = await gitlinks(worktree);
  const modules = links.length ? await modulesRoot(worktree) : null;
  for (const { path, pin } of links) {
    const abs = join(worktree, path);
    // not initialised (no .git of its own): nothing is checked out
    if (!existsSync(join(abs, '.git'))) continue;
    const gitDir = modules ? managedGitDir(abs, modules) : null;
    if (!gitDir) {
      problems.push(
        `the submodule ${path} is not a checkout the runner manages (its .git does not lead to the repository's modules folder): remove what you put at ${path}, or ask with \`aom question --topic environment\``,
      );
      continue;
    }
    // asked of the superproject: no git runs inside the submodule. On its pin: nothing to say.
    const at = await submoduleCommitOffPin(worktree, path);
    if (!at || at === pin) continue;
    problems.push(
      `the submodule ${path} is at ${short(at)} instead of its pinned ${short(pin)}. The runner does not run git inside a submodule, so put it back yourself: \`git -C ${path} checkout ${pin}\` (from your worktree), then report again. If that commit is not in the submodule's clone, ask with \`aom question --topic environment\` and name the submodule and the pinned commit. If the card really needs another commit of ${path}, commit the pin change (\`git add ${path}\` and commit) instead`,
    );
  }
  if (problems.length) result.refused = problems.join('; ');
  return result;
}

/** The card comment for submodules the runner reset to their pin at a handoff. */
export function submoduleResetNote(reset: readonly SubmoduleDrift[]): string {
  const list = reset.map((d) => `${d.path} (${short(d.from)} -> ${short(d.pin)})`).join(', ');
  return `The runner reset ${reset.length === 1 ? 'a submodule' : 'submodules'} that ${reset.length === 1 ? 'was' : 'were'} checked out off the pinned commit back to the pin before the handoff: ${list}. No pin change was committed for ${reset.length === 1 ? 'it' : 'them'}; the build and tests in the handoff evidence ran before this reset.`;
}
