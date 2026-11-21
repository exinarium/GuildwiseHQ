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
  sudo?: string;
  sudoPasswordStdin?: boolean;
  docker?: string;
  approveApp?: string[];
  deploy?: string;
  deployPinCommit?: boolean;
  allowUnsignedFrom?: string[];
  dataDir?: string;
  instance?: string;
}

export interface ApproveApp {
  app: string;
  folder: string;
}

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
  sudo?: 'on' | 'off';
  sudoPasswordStdin: boolean;
  docker?: 'none' | 'narrow' | 'group';
  approveApps: ApproveApp[];
  deploy?: 'ask' | 'off';
  deployPinCommit?: boolean;
  allowUnsignedFrom?: string[];
  dataDir?: string;
  /** A named runner instance (`guildwise-runner-<name>`); absent: the single runner of before. */
  instance?: string;
}

const APP_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
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
      `--instance takes lowercase letters, digits and inner dashes, at most 15, not node, guildwise-admin or deploy-compose (got ${JSON.stringify(v)})`,
    );
  return v;
}

export function parseApproveApp(spec: string): ApproveApp {
  const i = spec.indexOf('=');
  const app = i > 0 ? spec.slice(0, i) : '';
  const folder = i > 0 ? spec.slice(i + 1) : '';
  if (!APP_RE.test(app) || !folder.startsWith('/'))
    throw new SetupError(
      `--approve-app takes <app>=<absolute folder> (app: a-z, 0-9, -), got ${JSON.stringify(spec)}`,
    );
  return { app, folder };
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
    sudo: oneOf('sudo', raw.sudo ?? e('SUDO'), ['on', 'off'] as const),
    sudoPasswordStdin: raw.sudoPasswordStdin === true || truthy(e('SUDO_PASSWORD_STDIN')),
    docker: oneOf('docker', raw.docker ?? e('DOCKER'), ['none', 'narrow', 'group'] as const),
    approveApps: (raw.approveApp?.length ? raw.approveApp : list(e('APPROVE_APP'))).map(parseApproveApp),
    deploy: oneOf('deploy', raw.deploy ?? e('DEPLOY'), ['ask', 'off'] as const),
    deployPinCommit: raw.deployPinCommit === true || truthy(e('DEPLOY_PIN_COMMIT')) ? true : undefined,
    allowUnsignedFrom: unsignedRaw.length > 0 ? [...new Set(unsignedRaw.map(exactOrigin))] : undefined,
    dataDir: raw.dataDir,
    instance: parseInstance(raw.instance ?? e('INSTANCE')),
  };
  if (opts.docker === 'group' && !opts.acceptRootEquivalent)
    throw new SetupError(
      '--docker group makes the runner root-equivalent: it needs --accept-root-equivalent',
    );
  if (opts.approveApps.length > 0 && opts.docker !== undefined && opts.docker !== 'narrow')
    throw new SetupError('--approve-app needs --docker narrow');
  if (opts.sudoPasswordStdin && opts.sudo !== 'on')
    throw new SetupError('--sudo-password-stdin goes with --sudo on');
  return opts;
}
