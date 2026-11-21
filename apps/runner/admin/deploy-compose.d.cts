// Types for deploy-compose.cjs (the root-owned Docker helper). Used by its tests; guildwise-admin may use them too.

export interface DeployOptions {
  confDir?: string;
  stateDir?: string;
  /** Absolute docker binary; the CLI finds a root-owned one in /usr/bin or /usr/local/bin. */
  docker?: string;
  /** The uid that must own the config and state files (0 in production). */
  rootUid: number;
  /** Read the source folder as readerUid/readerGid (production) or as the current user (tests). */
  dropPrivileges: boolean;
  /** With dropPrivileges: the uid/gid fixed at approval (the folder owner). deploy() takes them from the conf. */
  readerUid?: number;
  readerGid?: number;
  /** Test hook: replaces child_process.spawn for the reader. */
  spawn?: typeof import('node:child_process').spawn;
  homeDir: string;
  /** How to start the unprivileged reader: [node, deploy-compose file]. */
  readerCommand: string[];
  path?: string;
  adminCommand?: string;
  /** A named runner instance: the compose project is `<projectPrefix><app>` (default `guildwise-`). */
  projectPrefix?: string;
  /** A named runner instance: deploy() runs only an approval whose owner is this uid. */
  callerUid?: number;
  /** Test hook: runs after the freeze, before the checks. */
  afterFreeze?: (snap: { dir: string; hash: string }) => void | Promise<void>;
}

export interface Prepared {
  project: string;
  snapshotDir: string;
  snapshotHash: string;
  appDir: string;
  resolved: Record<string, unknown>;
  pinned: Record<string, unknown>;
  hash: string;
}

export interface DeployResult extends Prepared {
  approvedHash: string;
  approved: boolean;
  resolvedFile?: string;
}

export declare class DeployError extends Error {
  exitCode: number;
  problems: string[];
}

export declare const EXIT: {
  OK: 0;
  DOCKER: 1;
  USAGE: 2;
  HELD: 3;
  REFUSED: 4;
  ENV: 5;
};
export declare const PLACEHOLDER: '$APP';
export declare const DEFAULTS: Readonly<{
  nodeBin: string;
  confDir: string;
  stateDir: string;
  dockerCandidates: string[];
  path: string;
  adminCommand: string;
}>;

export declare function checkAppName(app: string): void;
export declare function parseAppConf(text: string): {
  source: string;
  hash: string;
  owner: number | null;
  group: number | null;
};
export declare function formatAppConf(conf: {
  source: string;
  hash: string;
  owner: number;
  group: number;
}): string;
export declare function hashTree(root: string, rootUid: number): string | null;
export declare function preflight(
  opts: { nodeBin: string },
  proc?: {
    execPath: string;
    execArgv: string[];
    env: Record<string, string | undefined>;
    getuid?: () => number;
    geteuid: () => number;
  },
): void;
export declare function parseYaml(
  text: string,
  label: string,
): { value: unknown; spans: [number, number][]; text: string };
export declare function unsafeRelPath(p: unknown): string | null;
export declare function composeFiles(root: string): string[];
export declare function prescan(root: string, files: string[]): void;
export declare function validateResolved(cfg: unknown, ctx: { root: string; project: string }): string[];
export declare function pinResolved(
  resolved: unknown,
  root: string,
): { pinned: Record<string, unknown>; hash: string };
export declare function cleanEnv(opts: { path: string; homeDir: string }): Record<string, string>;
export declare function prepare(app: string, sourceDir: string, options: DeployOptions): Promise<Prepared>;
export declare function deploy(
  app: string,
  action: 'up' | 'pull' | 'down' | 'resolve',
  options: DeployOptions,
): Promise<DeployResult>;
export declare const INSTANCE_RE: RegExp;
export declare function instanceOptions(
  env: Record<string, string | undefined>,
): Partial<DeployOptions> & { toolsDir?: string };
export declare function cliOptions(
  env: Record<string, string | undefined>,
  file: string,
): Partial<DeployOptions> & { nodeBin: string };
export declare function main(argv: string[]): Promise<number>;
