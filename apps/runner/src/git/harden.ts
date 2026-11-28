import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

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
  // gate-fixes-2 B1: an agent session can write `refs/replace`, `info/grafts` and a commit-graph file in the shared
  // `.git`; none of them may change what the runner sees as a commit's parents or content.
  '-c',
  'core.useReplaceRefs=false',
  '-c',
  'core.commitGraph=false',
];

/** Environment of every git the runner starts: no system-wide configuration, no prompts. */
export const GIT_HARDEN_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  // gate-fixes-2 B1: no replace objects and no graft file, whatever the shared `.git` holds
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_GRAFT_FILE: '/nonexistent',
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

/** A linked worktree's admin dir (`<common>/worktrees/<name>`) and its common dir, from its `.git` file; else undefined. */
function linkedAdmin(cwd: string): { admin: string; common: string } | undefined {
  try {
    const st = lstatSync(join(cwd, '.git'));
    if (!st.isFile()) return undefined;
  } catch {
    return undefined;
  }
  const m = /^gitdir:\s*(.+)$/m.exec(readSmall(join(cwd, '.git')) ?? '');
  if (!m?.[1]) return undefined;
  const admin = resolve(cwd, m[1].trim());
  if (!/[\\/]worktrees[\\/][^\\/]+$/.test(admin)) return undefined;
  return { admin, common: resolve(admin, '..', '..') };
}

/**
 * gate-fixes-2 B1: the parts of the shared `.git` a session that may commit writes: per common git dir, this worktree's
 * own admin dir, `objects`, `refs` and `logs`. Everything else there (`shallow`, `info/`, `FETCH_HEAD`, `packed-refs`,
 * the main checkout's `index`, `rebase-merge/`, config, hooks) stays read-only. Not a linked worktree: nothing.
 */
export function gitWriteScope(cwd: string, gitDirs: readonly string[]): string[] {
  const l = linkedAdmin(cwd);
  if (!l) return [];
  return gitDirs.flatMap((g) =>
    resolve(g) === resolve(l.common)
      ? [l.admin, join(g, 'objects'), join(g, 'refs'), join(g, 'logs')]
      : [join(g, 'objects'), join(g, 'refs'), join(g, 'logs')],
  );
}

/** The siblings along the path from `root` down to `keep` (claude-policy `denyAround`, for files and folders). */
function aroundPath(root: string, keep: string): string[] {
  const parts = relative(root, keep).split(sep).filter(Boolean);
  const out: string[] = [];
  let dir = root;
  try {
    for (const next of parts) {
      for (const e of readdirSync(dir)) if (e !== next) out.push(join(dir, e));
      dir = join(dir, next);
    }
  } catch {
    return [root];
  }
  return out;
}

/**
 * gate-fixes-2 S7: the existing ref paths a session must not write, for every writer's sandbox: `packed-refs`,
 * `refs/remotes`, `refs/guildwise`, `refs/tags`, `refs/replace`, `refs/heads/conflict`, and every branch file and folder
 * under `refs/heads` except the path to this worktree's own branch. Only what exists (a branch made later is not
 * covered; reftable clones have no files): Rules A-D are the protection, this is the fence in front of them.
 */
export function refFence(cwd: string): string[] {
  const l = linkedAdmin(cwd);
  if (!l) return [];
  return fenceOf(l.common, l.admin);
}

/**
 * gate-fixes-2 Rework 1 (D5): the file the runner writes in a clone's common `.git` before its first writer starts.
 * A clone that has it but no TipStore entry had a writer the store does not know about: it is never seeded (fail closed).
 * Writers cannot remove it (the common dir itself is outside every writer's write scope, and the fence lists it).
 */
export const WRITER_MARK = 'guildwise-writers';

/** The fence of a common dir, sparing the branch the checkout at `adminOrCommon` (its `HEAD`) is on. */
function fenceOf(c: string, adminOrCommon: string): string[] {
  const own = /^ref:\s*refs\/heads\/(.+)$/m.exec(readSmall(join(adminOrCommon, 'HEAD')) ?? '')?.[1]?.trim();
  const fixed = [
    join(c, WRITER_MARK),
    join(c, 'packed-refs'),
    join(c, 'refs', 'remotes'),
    join(c, 'refs', 'guildwise'),
    join(c, 'refs', 'tags'),
    join(c, 'refs', 'replace'),
    join(c, 'refs', 'heads', 'conflict'),
  ];
  const heads = join(c, 'refs', 'heads');
  const branches = own ? aroundPath(heads, join(heads, own)) : [heads];
  return [...new Set([...fixed, ...branches])].filter((p) => existsSync(p));
}

/**
 * gate-fixes-2 Rework 1 (S7 for S13): the fence for a folder a DevOps outer box binds writable: every clone at the folder
 * or up to two levels below it (`<folder>/.git`, `<folder>/*\/.git`, `<folder>/*\/*\/.git`), linked worktrees and plain
 * clones alike, keeping only paths inside the folder that are not links (the box binds them read-only by path after the
 * folder's fd bind). A clone whose `.git` lies outside the folder is not in the box at all.
 */
export function folderRefFence(folder: string): string[] {
  const out = new Set<string>();
  for (const r of clonesUnder(folder)) {
    let paths: string[] = [];
    try {
      const st = lstatSync(join(r, '.git'));
      if (st.isFile()) paths = refFence(r);
      else if (st.isDirectory())
        paths = fenceOf(join(r, '.git'), join(r, '.git')).filter((p) => existsSync(p));
    } catch {}
    for (const p of paths)
      try {
        if (inside(real(folder), p) && !lstatSync(p).isSymbolicLink()) out.add(p);
      } catch {}
  }
  return [...out];
}

/**
 * gate-fixes-2 Rework 2: the clones at `folder` or up to two levels below it (a `.git` file or folder there), the same set
 * `folderRefFence` fences and `holdWriters` counts (S13).
 */
export function clonesUnder(folder: string): string[] {
  const roots: string[] = [];
  const look = (dir: string, depth: number) => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(join(dir, '.git'));
      roots.push(dir);
      if (st.isFile() || st.isDirectory()) return;
    } catch {
      // not a clone here
    }
    if (depth >= 2) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const d = join(dir, n);
      try {
        if (lstatSync(d).isDirectory()) look(d, depth + 1);
      } catch {}
    }
  };
  look(folder, 0);
  return roots;
}

/**
 * gate-fixes-2 S7: before a writer starts, every local branch that is only in `packed-refs` gets its loose ref file, so
 * the fence can bind it (a session could otherwise create a loose file that overrides the packed one), and `refs/replace`
 * exists (empty) so it can be bound too. Atomic writes; a name whose path is taken by a folder or file is skipped.
 */
export function materializeLooseRefs(commonDir: string, tips: Record<string, string>): void {
  try {
    mkdirSync(join(commonDir, 'refs', 'replace'), { recursive: true });
  } catch {}
  for (const [ref, sha] of Object.entries(tips)) {
    if (!ref.startsWith('refs/heads/') || ref.includes('..')) continue;
    const file = join(commonDir, ...ref.split('/'));
    if (existsSync(file)) continue;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.gw-${process.pid}.tmp`;
      writeFileSync(tmp, `${sha}\n`, { mode: 0o644 });
      renameSync(tmp, file);
    } catch {
      // the fence then just does not cover this one branch (Rules A-D still do)
    }
  }
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
