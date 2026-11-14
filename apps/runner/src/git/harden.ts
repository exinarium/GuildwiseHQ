import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
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
  // A superproject's status, diff, stash and checkout otherwise start `git status` INSIDE every submodule to see
  // whether it is dirty, and that child reads the nested repository's own configuration: a `filter.*.clean` there is a
  // program run on the workstation. A nested repository is agent-made content (`git init x && git add x`), and a
  // submodule's repository under `modules/` is agent-writable too, so neither configuration can be trusted. With
  // `dirty` the superproject only compares the submodule's commit with the pin (read in-process): a moved pin still
  // shows, uncommitted content inside a submodule does not. This is only the DEFAULT: an agent-written `.gitmodules`
  // (`submodule.<name>.ignore = none`) overrides it, and `git add` ignores it. `git()` therefore also passes
  // `--ignore-submodules=dirty` to status and diff, makes checkout quiet and excludes gitlinks from add (git.ts,
  // `withSubmoduleGuards`), and the runner never runs git inside a submodule of a worktree (submodule-drift.ts).
  '-c',
  'diff.ignoreSubmodules=dirty',
  // The other ways a superproject command goes into its submodules, each of which would run git (and so the nested
  // repository's configuration: a filter, `remote.<n>.uploadpack`, `core.sshCommand`) inside one: recursing checkout,
  // merge, rebase, reset and pull; fetching or pushing submodules; a submodule diff or summary in diff, show and status.
  '-c',
  'submodule.recurse=false',
  '-c',
  'fetch.recurseSubmodules=false',
  '-c',
  'push.recurseSubmodules=no',
  '-c',
  'diff.submodule=short',
  '-c',
  'status.submoduleSummary=false',
  // The workstation user's own ~/.gitconfig is read too. With `rebase.autoStash` or `merge.autoStash` there, a rebase or
  // merge of a dirty tree runs `git stash create`, `git stash apply` and a plain `git status` as children, none of which
  // carry the option forms `git()` adds: an agent-written `.gitmodules` then switches the looking-inside back on.
  '-c',
  'rebase.autoStash=false',
  '-c',
  'merge.autoStash=false',
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
 * `.git/config.worktree` and `.git/hooks`, and the `config`, `config.worktree` and `hooks` of every submodule repository under
 * `modules/`. Only what exists now (a file that does not exist cannot be bound; the runner's own
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
  // The submodules' own repositories (`modules/<name>`): the runner never runs git inside them, but the owner or a
  // DevOps engineer may, and git then reads their `config` (a filter or a diff driver there is a program). Read-only
  // for the agent like the rest; a repository made later cannot be covered (only what exists can be bound).
  const submodules = existing(
    submoduleGitDirs(cwd).flatMap((d) => ['config', 'config.worktree', 'hooks'].map((f) => join(d, f))),
  );
  if (st.isDirectory())
    return [
      ...existing([join(dotGit, 'config'), join(dotGit, 'config.worktree'), join(dotGit, 'hooks')]),
      ...submodules,
    ];
  const text = readSmall(dotGit);
  const m = text ? /^gitdir:\s*(.+)$/m.exec(text) : null;
  if (!m?.[1]) return [dotGit];
  const admin = resolve(cwd, m[1].trim());
  return [
    dotGit,
    ...existing(['commondir', 'gitdir', 'config', 'config.worktree', 'hooks'].map((f) => join(admin, f))),
    ...submodules,
  ];
}

/**
 * The repositories of a worktree's submodules, where git keeps them: `<git dir>/modules/<name>` (per worktree for a
 * linked one: `<repo>/.git/worktrees/<wt>/modules/<name>`), nested ones under their own `modules/`. Found by reading
 * the folders, without running git. Only plain folders that look like a repository (`HEAD` and `config`).
 */
export function submoduleGitDirs(cwd: string): string[] {
  const dotGit = join(cwd, '.git');
  let admin: string;
  try {
    const st = lstatSync(dotGit);
    if (st.isSymbolicLink()) return [];
    if (st.isDirectory()) admin = dotGit;
    else {
      const m = /^gitdir:\s*(.+)$/m.exec(readSmall(dotGit) ?? '');
      if (!m?.[1]) return [];
      admin = resolve(cwd, m[1].trim());
    }
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (modules: string, depth: number): void => {
    if (depth > 4) return;
    let names: string[];
    try {
      if (lstatSync(modules).isSymbolicLink()) return;
      names = readdirSync(modules);
    } catch {
      return;
    }
    for (const name of names) {
      const dir = join(modules, name);
      try {
        const st = lstatSync(dir);
        if (st.isSymbolicLink() || !st.isDirectory()) continue;
      } catch {
        continue;
      }
      const isRepo = (() => {
        try {
          return lstatSync(join(dir, 'HEAD')).isFile() && lstatSync(join(dir, 'config')).isFile();
        } catch {
          return false;
        }
      })();
      if (isRepo) {
        out.push(dir);
        walk(join(dir, 'modules'), depth + 1);
      } else walk(dir, depth + 1); // a submodule name with a slash: `modules/a/b`
    }
  };
  walk(join(admin, 'modules'), 0);
  return out;
}

/**
 * Exclude pathspecs that keep `git add` away from every gitlink. `git add -A` starts `git status` inside each gitlink
 * of the index that has a repository behind it, whatever `diff.ignoreSubmodules` or `--ignore-submodules` says, and
 * that child honours the nested repository's own configuration (a `clean` filter is a program on the workstation).
 * With the path excluded git skips it before it would start the child. So the runner never stages a submodule's pin:
 * an agent that changes a pin commits it itself, inside its sandbox.
 */
export function gitlinkExcludes(gitlinkPaths: readonly string[]): string[] {
  return gitlinkPaths.map((p) => `:(exclude,top,literal)${p}`);
}
