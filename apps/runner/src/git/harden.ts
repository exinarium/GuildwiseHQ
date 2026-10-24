import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The runner runs git in folders an agent could write to (a card's worktree), after the agent is gone. A repository's configuration
 * can start programs: `core.fsmonitor`, hooks, filters, an external diff. So the agent's sandbox must not be able to change that
 * configuration or to point the worktree at one it controls (`protectedGitPaths` below, applied by the sandboxes), and every git the
 * runner starts is told not to run those programs whatever the files say (`GIT_HARDEN_ARGS`, `GIT_HARDEN_ENV`), and refuses a
 * worktree whose `.git` file points somewhere it should not (`gitPointerProblem`). Defence in depth: each layer alone would do.
 */

/** Put before the subcommand of every git the runner starts. Command-line `-c` beats every config file. */
export const GIT_HARDEN_ARGS: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.ext.allow=never',
];

/** Environment of every git the runner starts: no system-wide configuration, no prompts. */
export const GIT_HARDEN_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

/** `git <hardening> <args>`. */
export const hardenedGitArgs = (args: readonly string[]): string[] => [...GIT_HARDEN_ARGS, ...args];

const inside = (parent: string, child: string): boolean => {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(`${p}/`);
};

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const readSmall = (p: string): string | undefined => {
  try {
    const s = readFileSync(p, 'utf8');
    return s.length <= 4096 ? s : undefined;
  } catch {
    return undefined;
  }
};

/** `<repo>/.git/worktrees/<name>` or a submodule's `<repo>/.git/modules/...`: the shapes `git worktree add` and `git submodule` make. */
const ADMIN_SHAPE = /[\\/](worktrees[\\/][^\\/]+|modules([\\/][^\\/]+)+)$/;

/**
 * Why git must not be run in `cwd`, or undefined. A linked worktree's `.git` file names its administrative folder; an agent that
 * could rewrite it (or `commondir` inside the folder) would make git read a configuration of its own making. The folder must be one
 * git itself makes (`.git/worktrees/<name>` of a repository, outside the working folder), must say it belongs to this repository
 * (`commondir`) and must point back at this working folder (`gitdir`). A plain clone (`.git` is a folder) is fine.
 */
export function gitPointerProblem(cwd: string): string | undefined {
  const dotGit = join(cwd, '.git');
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dotGit);
  } catch {
    return undefined; // no .git here: git looks in the parents, as it always did
  }
  if (st.isSymbolicLink()) return `${dotGit} is a symbolic link`;
  if (st.isDirectory()) return undefined;
  const text = readSmall(dotGit);
  const m = text ? /^gitdir:\s*(.+)$/m.exec(text) : null;
  if (!m?.[1]) return `${dotGit} does not name a git directory`;
  const admin = resolve(cwd, m[1].trim());
  if (!ADMIN_SHAPE.test(admin))
    return `${dotGit} points at ${admin}, which is not a worktree's administrative folder`;
  if (inside(real(cwd), real(admin))) return `${dotGit} points inside the working folder`;
  let adminSt: ReturnType<typeof lstatSync>;
  try {
    adminSt = lstatSync(admin);
  } catch {
    return `${dotGit} points at ${admin}, which does not exist`;
  }
  if (adminSt.isSymbolicLink() || !adminSt.isDirectory()) return `${admin} is not a plain folder`;
  const isWorktree = /[\\/]worktrees[\\/][^\\/]+$/.test(admin);
  const common = isWorktree ? resolve(admin, '..', '..') : admin;
  if (inside(real(cwd), real(common))) return `the repository of ${cwd} is inside the working folder`;
  const commondir = readSmall(join(admin, 'commondir'));
  if (isWorktree) {
    if (commondir === undefined || real(resolve(admin, commondir.trim())) !== real(common))
      return `${admin}/commondir does not lead to ${common}`;
    const back = readSmall(join(admin, 'gitdir'));
    if (back === undefined || real(resolve(admin, back.trim())) !== real(dotGit))
      return `${admin}/gitdir does not lead back to ${dotGit}`;
  }
  return undefined;
}

/**
 * Files and folders of a repository that a sandbox must make read-only for the agent, because git (run later by the runner or the
 * owner, outside the sandbox) reads them and some of what they hold starts programs: the worktree's `.git` file, the worktree's
 * administrative folder entries `commondir`, `gitdir`, `config` and `config.worktree`, and for a plain clone `.git/config`,
 * `.git/config.worktree` and `.git/hooks`. Only what exists now (a file that does not exist cannot be bound; the runner's own
 * `-c` flags cover a configuration file that appears later). The main repository's `config` and `hooks` are handled with the
 * common git dir (read-only already).
 */
export function protectedGitPaths(cwd: string): string[] {
  const dotGit = join(cwd, '.git');
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dotGit);
  } catch {
    return [];
  }
  const existing = (paths: string[]): string[] =>
    paths.filter((p) => {
      try {
        lstatSync(p);
        return true;
      } catch {
        return false;
      }
    });
  if (st.isDirectory())
    return existing([join(dotGit, 'config'), join(dotGit, 'config.worktree'), join(dotGit, 'hooks')]);
  const text = readSmall(dotGit);
  const m = text ? /^gitdir:\s*(.+)$/m.exec(text) : null;
  if (!m?.[1]) return [dotGit];
  const admin = resolve(cwd, m[1].trim());
  return [
    dotGit,
    ...existing(['commondir', 'gitdir', 'config', 'config.worktree', 'hooks'].map((f) => join(admin, f))),
  ];
}
