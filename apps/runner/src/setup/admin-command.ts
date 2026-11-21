import { userInfo } from 'node:os';

/**
 * The root half of the set-up (R20): `guildwise-runner setup` runs as the runner user and never does anything that
 * needs root. For those steps it prints the exact command for the person at the keyboard (or the installer) to run.
 */

/** Root-owned, read-only, installed by the installer from the verified package; never touched by a self-update. */
export const ADMIN_DIR = '/usr/local/lib/guildwise';
export const ADMIN_TOOL = `${ADMIN_DIR}/guildwise-admin`;
/** The dedicated runner user the installer creates on Linux and macOS. */
export const DEDICATED_USER = 'guildwise-runner';

/**
 * A named runner instance (`--instance <name>`: two or more runners on one machine, for example UAT and production): the
 * same rule as guildwise-admin's INSTANCE_RE, whose user is `guildwise-runner-<name>`.
 */
export const INSTANCE_RE = /^[a-z0-9](?:[a-z0-9-]{0,13}[a-z0-9])?$/;
/** Names already taken inside the admin folder: never an instance (its tools live in `<ADMIN_DIR>/<name>/`). */
export const RESERVED_INSTANCES: readonly string[] = ['node', 'guildwise-admin', 'deploy-compose'];

/** A valid instance name (INSTANCE_RE and not reserved). */
export function isInstanceName(name: string): boolean {
  return INSTANCE_RE.test(name) && !RESERVED_INSTANCES.includes(name);
}

/**
 * The root-owned tools of a runner: the top-level folder for the single runner, `<ADMIN_DIR>/<name>/` for an instance
 * (installed from that instance's own server's release, so the trust domains never cross).
 */
export function adminDirOf(instance: string | null | undefined): string {
  return instance ? `${ADMIN_DIR}/${instance}` : ADMIN_DIR;
}

/** The dedicated user of an instance (`guildwise-runner-<name>`), or the single `guildwise-runner` without one. */
export function dedicatedUserOf(instance: string | null | undefined): string {
  return instance ? `${DEDICATED_USER}-${instance}` : DEDICATED_USER;
}

/** The instance a dedicated runner user belongs to: `uat` for `guildwise-runner-uat`, null for anyone else. */
export function instanceOfUser(username: string): string | null {
  if (!username.startsWith(`${DEDICATED_USER}-`)) return null;
  const name = username.slice(DEDICATED_USER.length + 1);
  return isInstanceName(name) ? name : null;
}

/** Is this one of the installer's dedicated runner users (the single one or an instance's)? */
export function isDedicatedUser(username: string): boolean {
  return username === DEDICATED_USER || instanceOfUser(username) !== null;
}

/** The root-owned folder of an instance's CA copy and approved apps (`/etc/guildwise-runner[-<name>]`). */
export function instanceEtcDir(instance: string | null): string {
  return `/etc/${dedicatedUserOf(instance)}`;
}

/**
 * The start-up check's extra paths for a named instance (its root-owned `/etc/guildwise-runner-<name>` and its own tools
 * folder `<ADMIN_DIR>/<name>`); none for the
 * single runner or a person, so their check is exactly as before.
 */
export function instanceStartupPaths(username: string = currentUser()): string[] {
  const inst = instanceOfUser(username);
  return inst ? [instanceEtcDir(inst), adminDirOf(inst)] : [];
}

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

const PLAIN = /^[A-Za-z0-9._/=:,@+-]+$/;

/** POSIX shell quoting for one argument. */
export function shellQuote(arg: string): string {
  if (arg !== '' && PLAIN.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * `sudo /usr/local/lib/guildwise/guildwise-admin <args>`, quoted for a POSIX shell; for an instance its own copy,
 * `sudo /usr/local/lib/guildwise/<name>/guildwise-admin --instance <name> <args>`. Without an instance, exactly the
 * command of before.
 */
export function adminCommand(args: readonly string[], instance?: string | null): string {
  const inst = instance ? ['--instance', instance] : [];
  return ['sudo', `${adminDirOf(instance)}/guildwise-admin`, ...[...inst, ...args].map(shellQuote)].join(' ');
}
