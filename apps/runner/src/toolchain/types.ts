/**
 * The toolchain table (docs/RUNNER.md "Toolchain and environment"): which stacks a repository uses, which tools each
 * needs, how to prove a tool works and how to install it with each package manager. Everything is data in
 * `stacks.ts`; adding a stack means adding one object there (and a fixture test in `test/toolchain-detect.test.ts`).
 */

export type Platform = 'linux' | 'darwin' | 'win32';

/** `any`: the same steps whatever the package manager (corepack, rustup, dotnet-install). */
export type Manager = 'apt' | 'dnf' | 'brew' | 'winget' | 'choco' | 'any';

/** What a detector can see of a repository: its files (relative paths, depth-limited) and a reader. */
export interface RepoView {
  /** Relative paths with `/` separators. */
  files: string[];
  /** Text of a file (relative path), or null when missing or unreadable. First 256 KiB. */
  read(rel: string): string | null;
  platform: Platform;
}

/** Parameters a detector extracts (versions, package manager, targets); recipes and checks read them. */
export type Params = Record<string, string | undefined>;

export interface Detection {
  /** Stack id (`dotnet-maui`). */
  id: string;
  /** What the manager sees. */
  name: string;
  /** Why it matched, e.g. the file: shown in the report. */
  evidence: string;
  params: Params;
}

export interface Step {
  cmd: string;
  args: string[];
  /** Needs administrator rights (apt, dnf, system-wide installs). */
  root?: boolean;
}

export interface Check {
  cmd: string;
  args: string[];
  /** Captures the version from stdout+stderr (group 1). */
  version?: RegExp;
  /** Output must contain this (a dotnet workload id). */
  contains?: string;
}

export interface ToolSpec {
  /** Unique across the table: tools of two stacks with the same id are checked and installed once. */
  id: string;
  name: string;
  /** Tried in order; the first that exits 0 (and matches) proves the tool. */
  checks: (p: Params, platform: Platform) => Check[];
  /** Minimal version (dotted numbers, compared segment by segment) the repository asks for. */
  minVersion?: (p: Params) => string | undefined;
  /** Installers per package manager. A tool without any recipe can only be reported. */
  recipes: (p: Params, platform: Platform) => Partial<Record<Manager, Step[]>>;
  /** Tools (by id) that must be fine first; otherwise this one is skipped. */
  after?: string[];
  /** Needs the manager to have allowed Docker (`allowDocker`) in addition to installing. */
  docker?: boolean;
  /** What to tell the manager when nothing can install it. */
  manual?: (p: Params, platform: Platform) => string;
}

export interface StackSpec {
  id: string;
  name: string;
  /** Returns the detection or null. */
  detect: (repo: RepoView) => Detection | null;
  /** Tool ids, in install order (resolved against `TOOLS`). */
  tools: (d: Detection, platform: Platform) => string[];
}
