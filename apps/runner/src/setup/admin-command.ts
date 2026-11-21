/**
 * The root half of the set-up (R20): `guildwise-runner setup` runs as the runner user and never does anything that
 * needs root. For those steps it prints the exact command for the person at the keyboard (or the installer) to run.
 */

/** Root-owned, read-only, installed by the installer from the verified package; never touched by a self-update. */
export const ADMIN_DIR = '/usr/local/lib/guildwise';
export const ADMIN_TOOL = `${ADMIN_DIR}/guildwise-admin`;
/** The dedicated runner user the installer creates on Linux and macOS. */
export const DEDICATED_USER = 'guildwise-runner';

const PLAIN = /^[A-Za-z0-9._/=:,@+-]+$/;

/** POSIX shell quoting for one argument. */
export function shellQuote(arg: string): string {
  if (arg !== '' && PLAIN.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** `sudo /usr/local/lib/guildwise/guildwise-admin <args>`, quoted for a POSIX shell. */
export function adminCommand(args: readonly string[]): string {
  return ['sudo', ADMIN_TOOL, ...args.map(shellQuote)].join(' ');
}
