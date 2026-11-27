import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { git } from './git.ts';

/**
 * devops-box-access (A): install output the runner's own commits for an agent never add, even in a repository with no
 * .gitignore. Ignore-rule semantics (git's `core.excludesFile`): an untracked path is left out, a tracked one still commits,
 * and the repository's .gitignore stays in force. Never written to the repository (.gitignore, .git/info/exclude).
 *
 * `venv/` is not in the list: a folder named `venv` is ignored only when it is a virtualenv (it holds a `pyvenv.cfg`), found
 * per commit by `virtualenvDirs`, because a source package named `venv` (CPython's `Lib/venv/`) is real work.
 *
 * Left out on purpose: `.yarn/cache` and `.pnp.cjs` (Yarn zero-install tracks them), `vendor/` (Go tracks it), `dist/` and
 * `build/` (often tracked), `Pods/`.
 */
export const INSTALL_OUTPUT_IGNORE: readonly string[] = [
  // no slash: also a node_modules that is a symlink (to a shared store), which would be committed as a link to a host path
  'node_modules',
  'bower_components/',
  'jspm_packages/',
  '.pnpm-store/',
  '**/.yarn/unplugged/',
  '**/.yarn/install-state.gz',
  '.venv/',
  '__pycache__/',
  '*.py[cod]',
  '.eggs/',
  '*.egg-info/',
  '.tox/',
  '.nox/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  'target/',
  '**/vendor/bundle/',
  '.gradle/',
  '.terraform/',
  '.dart_tool/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.parcel-cache/',
  '**/.angular/cache/',
  '.cache/',
];

/**
 * Folders whose tracked content is install output for certain: a WIP commit that would add to or change files under one is
 * refused (`install_output`). `venv` counts only when it holds a `pyvenv.cfg` (checked by the caller): a source package named
 * `venv` (CPython's `Lib/venv/`) is real work.
 */
export const TRACKED_INSTALL_DIRS: readonly string[] = [
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pnpm-store',
];

/** A user excludes file larger than this is not copied (WARN), the runner's list still applies. */
export const MAX_USER_EXCLUDES_BYTES = 1024 * 1024;

/** The excludes file git would use for the user: `core.excludesFile`, else `$XDG_CONFIG_HOME/git/ignore`, else `~/.config/git/ignore`. */
async function userExcludesFile(worktree: string, env: Record<string, string>): Promise<string> {
  const r = await git(worktree, ['config', '--path', '--get', 'core.excludesFile'], { env });
  const configured = r.exitCode === 0 ? r.stdout.trim() : '';
  if (configured) return isAbsolute(configured) ? configured : resolve(worktree, configured);
  const xdg = env.XDG_CONFIG_HOME ?? process.env.XDG_CONFIG_HOME;
  return xdg
    ? join(xdg, 'git', 'ignore')
    : join(env.HOME ?? process.env.HOME ?? homedir(), '.config', 'git', 'ignore');
}

/** The user's own excludes, when that file is a regular file of at most `MAX_USER_EXCLUDES_BYTES`; '' otherwise. */
function readUserExcludes(file: string): string {
  let st: ReturnType<typeof statSync>;
  try {
    // follows a symlink, as git does (a dotfiles setup links ~/.config/git/ignore); a dangling link or a loop is no file
    st = statSync(file);
  } catch {
    return '';
  }
  if (!st.isFile() || st.size > MAX_USER_EXCLUDES_BYTES) {
    process.stderr.write(
      `WARN the git excludes file ${file} is not a regular file of at most 1 MiB: only the runner's install-output list applies to this commit\n`,
    );
    return '';
  }
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Runs `fn` with the git arguments (`-c core.excludesFile=<file>`) that leave install output out of a commit: a private file
 * (mode 0700 folder) holding `INSTALL_OUTPUT_IGNORE` plus the user's own effective excludes, removed afterwards.
 */
export async function withInstallOutputIgnored<T>(
  worktree: string,
  fn: (gitPrefix: string[]) => Promise<T>,
  env: Record<string, string> = {},
): Promise<T> {
  const user = readUserExcludes(await userExcludesFile(worktree, env));
  const dir = await mkdtemp(join(tmpdir(), 'aom-excludes-'));
  try {
    const file = join(dir, 'exclude');
    const body = `${user}${user && !user.endsWith('\n') ? '\n' : ''}# Guildwise runner: install output is never committed for an agent\n${INSTALL_OUTPUT_IGNORE.join('\n')}\n`;
    await writeFile(file, body, { mode: 0o600 });
    const prefix = ['-c', `core.excludesFile=${file}`];
    // untracked `venv` folders that are virtualenvs, each ignored by its own anchored rule
    const venvs = await virtualenvDirs(worktree, prefix, env);
    if (venvs.length)
      await writeFile(file, `${body}${venvs.map((d) => `/${d}/`).join('\n')}\n`, { mode: 0o600 });
    return await fn(prefix);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Untracked folders named `venv` that hold a `pyvenv.cfg` (git's own walk, with the other ignore rules applied). */
async function virtualenvDirs(
  worktree: string,
  prefix: string[],
  env: Record<string, string>,
): Promise<string[]> {
  const r = await git(
    worktree,
    [...prefix, 'ls-files', '-z', '--others', '--exclude-standard', '--', ':(glob)**/venv/pyvenv.cfg'],
    { env },
  );
  if (r.exitCode !== 0) return [];
  return [
    ...new Set(
      r.stdout
        .split('\0')
        .filter((f) => f.endsWith('venv/pyvenv.cfg'))
        .map((f) => f.slice(0, -'/pyvenv.cfg'.length))
        .filter((d) => !/[\n\\*?[\]!#]/.test(d)),
    ),
  ];
}

/** The candidate install folders in `path`: its prefix up to each `TRACKED_INSTALL_DIRS` component (the file itself excluded). */
export function installDirsOf(path: string): Array<{ dir: string; name: string }> {
  const parts = path.split('/');
  const out: Array<{ dir: string; name: string }> = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const name = parts[i] as string;
    if (TRACKED_INSTALL_DIRS.includes(name)) out.push({ dir: parts.slice(0, i + 1).join('/'), name });
  }
  return out;
}
