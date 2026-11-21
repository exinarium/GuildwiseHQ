/**
 * The non-interactive flags of `guildwise-runner setup` (R20 "Non-interactive"), each also readable as a `GUILDWISE_*`
 * environment variable. They come from the person or the installer's command line, never from the server or the
 * installer template. A flag beats its variable.
 */

import { isInstanceName } from './admin-command.ts';

export class SetupError extends Error {
  constructor(
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
  }
}

export interface RawSetupFlags {
  yes?: boolean;
  runnerUser?: string;
  wslDistro?: string;
  legacy?: string;
  acceptRootEquivalent?: boolean;
  devopsOrgs?: string;
  docker?: string;
  dockerFound?: string;
  dockerSocket?: string;
  acceptSharedDaemon?: boolean;
  deploy?: string;
  deployPinCommit?: boolean;
  allowUnsignedFrom?: string[];
  dataDir?: string;
  instance?: string;
}

export type DockerMode = 'rootless' | 'host' | 'shared' | 'none';
/** `rootful`: a root daemon; `desktop`: Docker Desktop (macOS); `own`: the runner's own rootless daemon; `shared`: another user's rootless daemon. */
export type DockerFound = 'rootful' | 'desktop' | 'own' | 'shared' | 'none';

export const DESKTOP_SOCKET_RE = /^\/Users\/[^/]+\/\.docker\/run\/docker\.sock$/;
export const SHARED_SOCKET_RE = /^\/(?:var\/)?run\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/docker\.sock$/;

export interface SetupOptions {
  yes: boolean;
  runnerUser?: 'dedicated' | 'current';
  /** Windows installer only (the dedicated WSL distro); accepted so the flags map one to one. */
  wslDistro?: 'dedicated' | 'default';
  /** Installer only (the old-install quarantine, R21); accepted so the flags map one to one. */
  legacy?: 'quarantine' | 'remove';
  acceptRootEquivalent: boolean;
  /** `none`, or the organization ids to grant (each must be offered by the server; no `owned` shortcut [rv6-6]). */
  devopsOrgs?: 'none' | string[];
  docker?: DockerMode;
  /** What the installer's `detect_docker` saw (a suggestion for the question, never a grant). */
  dockerFound?: DockerFound;
  /** `host` on macOS: the Docker Desktop socket; `shared`: the other daemon's socket. */
  dockerSocket?: string;
  /** Typed acceptance of a shared rootless daemon (owner 2026-11-21). */
  acceptSharedDaemon: boolean;
  deploy?: 'ask' | 'off';
  deployPinCommit?: boolean;
  allowUnsignedFrom?: string[];
  dataDir?: string;
  /** A named runner instance (`guildwise-runner-<name>`); absent: the single runner of before. */
  instance?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneOf<T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === '') return undefined;
  if (!(allowed as readonly string[]).includes(value))
    throw new SetupError(`--${name} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`);
  return value as T;
}

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** An exact origin (`https://host[:port]`), as policy.json `allowUnsignedUpdatesFrom` compares it. */
export function exactOrigin(v: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new SetupError(
      `--allow-unsigned-from needs an origin like https://hq.example.com (got ${JSON.stringify(v)})`,
    );
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== v.replace(/\/$/, ''))
    throw new SetupError(
      `--allow-unsigned-from needs an exact origin without a path (got ${JSON.stringify(v)})`,
    );
  return u.origin;
}

/** `--instance <name>`: lowercase letters, digits and inner dashes, at most 15 (INSTANCE_RE). */
export function parseInstance(v: string | undefined): string | undefined {
  if (v === undefined || v === '') return undefined;
  if (!isInstanceName(v))
    throw new SetupError(
      `--instance takes lowercase letters, digits and inner dashes, at most 15, not node, guildwise-admin, deploy-compose or docker (got ${JSON.stringify(v)})`,
    );
  return v;
}

export function parseSetupOptions(raw: RawSetupFlags, env: NodeJS.ProcessEnv = process.env): SetupOptions {
  const e = (k: string): string | undefined => {
    const v = env[`GUILDWISE_${k}`];
    return v === undefined || v === '' ? undefined : v;
  };
  const devopsRaw = raw.devopsOrgs ?? e('DEVOPS_ORGS');
  let devopsOrgs: SetupOptions['devopsOrgs'];
  if (devopsRaw !== undefined) {
    if (devopsRaw.trim() === 'none') devopsOrgs = 'none';
    else {
      const ids = list(devopsRaw);
      const bad = ids.filter((id) => !UUID_RE.test(id));
      if (ids.length === 0 || bad.length > 0)
        throw new SetupError(
          `--devops-orgs takes none or organization ids separated by commas (no shortcuts such as "owned"); not an id: ${bad.join(', ') || '(empty)'}`,
        );
      devopsOrgs = [...new Set(ids.map((id) => id.toLowerCase()))];
    }
  }
  const unsignedRaw = raw.allowUnsignedFrom?.length ? raw.allowUnsignedFrom : list(e('ALLOW_UNSIGNED_FROM'));
  const opts: SetupOptions = {
    yes: raw.yes === true || truthy(e('YES')),
    runnerUser: oneOf('runner-user', raw.runnerUser ?? e('RUNNER_USER'), ['dedicated', 'current'] as const),
    wslDistro: oneOf('wsl-distro', raw.wslDistro ?? e('WSL_DISTRO'), ['dedicated', 'default'] as const),
    legacy: oneOf('legacy', raw.legacy ?? e('LEGACY'), ['quarantine', 'remove'] as const),
    acceptRootEquivalent: raw.acceptRootEquivalent === true || truthy(e('ACCEPT_ROOT_EQUIVALENT')),
    devopsOrgs,
    docker: oneOf('docker', raw.docker ?? e('DOCKER'), ['rootless', 'host', 'shared', 'none'] as const),
    dockerFound: oneOf('docker-found', raw.dockerFound ?? e('DOCKER_FOUND'), [
      'rootful',
      'desktop',
      'own',
      'shared',
      'none',
    ] as const),
    dockerSocket: raw.dockerSocket ?? e('DOCKER_SOCKET'),
    acceptSharedDaemon: raw.acceptSharedDaemon === true || truthy(e('ACCEPT_SHARED_DAEMON')),
    deploy: oneOf('deploy', raw.deploy ?? e('DEPLOY'), ['ask', 'off'] as const),
    deployPinCommit: raw.deployPinCommit === true || truthy(e('DEPLOY_PIN_COMMIT')) ? true : undefined,
    allowUnsignedFrom: unsignedRaw.length > 0 ? [...new Set(unsignedRaw.map(exactOrigin))] : undefined,
    dataDir: raw.dataDir,
    instance: parseInstance(raw.instance ?? e('INSTANCE')),
  };
  if (opts.docker === 'host' && !opts.acceptRootEquivalent)
    throw new SetupError('--docker host makes the runner root-equivalent: it needs --accept-root-equivalent');
  if (opts.docker === 'shared' && !opts.acceptSharedDaemon)
    throw new SetupError(
      '--docker shared lets the runner control every container on that daemon: it needs --accept-shared-daemon',
    );
  if (
    opts.dockerSocket !== undefined &&
    !DESKTOP_SOCKET_RE.test(opts.dockerSocket) &&
    !SHARED_SOCKET_RE.test(opts.dockerSocket)
  )
    throw new SetupError(
      `--docker-socket takes /Users/<you>/.docker/run/docker.sock (macOS) or /run/<name>/docker.sock (got ${JSON.stringify(opts.dockerSocket)})`,
    );
  return opts;
}
