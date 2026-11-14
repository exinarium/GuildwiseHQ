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
  // A superproject's status, diff, commit, stash, checkout and rebase otherwise start `git status` INSIDE every
  // submodule to see whether it is dirty, and that child reads the submodule's own configuration: a `filter.*.clean`
  // there is a program run on the workstation. A nested repository is agent-made content (`git init x && git add x`),
  // so its configuration cannot be protected. With `dirty` the superproject only compares the submodule's commit with
  // the pin (read in-process): a moved pin still shows, uncommitted content inside a submodule does not.
  // `git add` ignores this setting on purpose: see `excludeUntrustedGitlinks`.
  '-c',
  'diff.ignoreSubmodules=dirty',
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
  // The submodules' own repositories (`modules/<name>`): the runner runs git inside the ones it trusts, and git then
  // reads their `config` (a filter or a diff driver there is a program). Read-only for the agent like the rest.
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

/** What a submodule's `config` may hold and still start no program: section -> keys (lower case). */
const INERT_CONFIG: Record<string, ReadonlySet<string>> = {
  core: new Set([
    'repositoryformatversion',
    'filemode',
    'bare',
    'logallrefupdates',
    'worktree',
    'ignorecase',
    'precomposeunicode',
    'symlinks',
  ]),
  remote: new Set(['url', 'fetch']),
  branch: new Set(['remote', 'merge', 'rebase']),
  submodule: new Set(['url', 'active']),
  user: new Set(['name', 'email']),
};

/**
 * True when a repository configuration file holds only settings that cannot start a program: the handful git itself
 * writes when it clones a submodule (allowlist above). Anything else - a filter, a diff or merge driver, an alias, an
 * include, a credential helper, `core.sshCommand`, `submodule.<n>.update` - makes it not inert. Parsed here, never by
 * running git on it. A missing or oversized file is not inert.
 */
export function inertGitConfig(file: string): boolean {
  let text: string;
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > 65536) return false;
    text = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  let section: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.endsWith('\\')) return false; // a continued line: not something git writes for a submodule
    const head = /^\[\s*([A-Za-z0-9-]+)(?:\s+"(?:[^"\\]|\\.)*")?\s*\]$/.exec(line);
    if (head) {
      section = (head[1] as string).toLowerCase();
      if (!INERT_CONFIG[section]) return false;
      continue;
    }
    if (line.startsWith('[')) return false; // `[section.sub]`, a key on the header line, anything unusual
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=.*)?$/.exec(line);
    if (!section || !kv) return false;
    if (!INERT_CONFIG[section]?.has((kv[1] as string).toLowerCase())) return false;
  }
  return true;
}

/**
 * Submodule repositories the runner may run git inside, per worktree (real paths). Filled when a shift starts, before
 * the agent runs: every repository under the worktree's `modules/` whose configuration is inert. From then on the
 * sandbox keeps that configuration read-only (`protectedGitPaths`), so it stays inert for the whole shift. A repository
 * that appears later is the agent's own making and is never trusted; after a runner restart nothing is trusted until
 * the next shift starts (the callers then behave as for an unmanaged folder).
 */
const TRUSTED_SUBMODULES = new Map<string, Set<string>>();

/** Records the trusted submodule repositories of `cwd` (see `TRUSTED_SUBMODULES`); returns them. */
export function trustSubmodulesAtShiftStart(cwd: string): string[] {
  const trusted = submoduleGitDirs(cwd).filter((dir) => {
    if (!inertGitConfig(join(dir, 'config'))) return false;
    try {
      lstatSync(join(dir, 'config.worktree'));
      return inertGitConfig(join(dir, 'config.worktree'));
    } catch {
      return true; // no config.worktree
    }
  });
  TRUSTED_SUBMODULES.set(real(cwd), new Set(trusted.map(real)));
  return trusted;
}

/** True when `gitDir` is a submodule repository some shift start recorded as trusted (real path compare). */
export function trustedSubmoduleGitDir(gitDir: string): boolean {
  const r = real(gitDir);
  for (const set of TRUSTED_SUBMODULES.values()) if (set.has(r)) return true;
  return false;
}

/** For tests. */
export function forgetTrustedSubmodules(): void {
  TRUSTED_SUBMODULES.clear();
}

/** The gitdir a folder's `.git` FILE names, as a real path; null for a `.git` directory, a link or nothing. */
function gitFileTarget(dir: string): string | null {
  try {
    const dotGit = join(dir, '.git');
    if (!lstatSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+)$/m.exec(readSmall(dotGit) ?? '');
    return m?.[1] ? realpathSync(resolve(dir, m[1].trim())) : null;
  } catch {
    return null;
  }
}

/**
 * Pathspecs that keep `git add` away from submodules it must not look into. `git add -A` starts `git status` inside
 * every gitlink of the index that has a repository behind it, whatever `diff.ignoreSubmodules` says, and that child
 * honours the submodule's own configuration (a `clean` filter is a program on the workstation). A gitlink whose
 * repository is not a trusted one (`trustedSubmoduleGitDir`) is excluded: git skips it before it would start the
 * child. `gitlinkPaths` are the index's mode-160000 paths, relative to the top of `cwd`'s repository.
 */
export function untrustedGitlinkExcludes(top: string, gitlinkPaths: readonly string[]): string[] {
  return gitlinkPaths
    .filter((p) => {
      const target = gitFileTarget(join(top, p));
      return !(target && trustedSubmoduleGitDir(target));
    })
    .map((p) => `:(exclude,top,literal)${p}`);
}
