import { userInfo } from 'node:os';
import { join } from 'node:path';
import { localCliOk, localCommandOk } from '@aom/shared';
import { isDedicatedUser } from '../setup/admin-command.ts';

/**
 * The one renderer of copy-paste commands for local approvals (easy-runner-setup). The runner builds every command
 * itself and sends it with each held item and local step; the server and the web only show it after checking it against
 * the shared grammar (`localCommandOk`). The same line is printed in the runner log.
 *
 * - Dedicated runner user: `sudo -u <user> -H <passwd home>/.local/bin/guildwise-runner` (sudo's `secure_path` never
 *   finds a bare `guildwise-runner`, so the path is always absolute).
 * - The person's own account: the absolute bin path.
 * - WSL: `wsl -d <distro> [-u <runner user>] -- <path>` so it can be pasted into a Windows terminal.
 *
 * A CLI part that fails the grammar falls back to the bare `guildwise-runner`.
 */

export interface LocalCliContext {
  /** The account the runner runs as. */
  username: string;
  /** That account's home from the passwd database (not $HOME). */
  home: string;
  /** Set under WSL (the distro name, from `runnerUser.wslDistro` or `WSL_DISTRO_NAME`). */
  wslDistro?: string;
}

export const BARE_CLI = 'guildwise-runner';

/** The path the installer links the runner command to. */
export function localBinPath(home: string): string {
  return join(home, '.local', 'bin', 'guildwise-runner').replaceAll('\\', '/');
}

/** The CLI part of every local command for this runner. */
export function localCli(ctx: LocalCliContext): string {
  const bin = localBinPath(ctx.home);
  let cli: string;
  // WSL: pasted into a Windows terminal; the dedicated runner user is named, so the command runs as it (not as the
  // distro's default user, who could not read the runner's home or policy)
  if (ctx.wslDistro)
    cli = isDedicatedUser(ctx.username)
      ? `wsl -d ${ctx.wslDistro} -u ${ctx.username} -- ${bin}`
      : `wsl -d ${ctx.wslDistro} -- ${bin}`;
  else if (isDedicatedUser(ctx.username)) cli = `sudo -u ${ctx.username} -H ${bin}`;
  else cli = bin;
  return localCliOk(cli) ? cli : BARE_CLI;
}

/** The distro this runner lives in when it runs under WSL (`WSL_DISTRO_NAME`); undefined elsewhere. */
export function detectWslDistro(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const name = env.WSL_DISTRO_NAME;
  return name && /^[A-Za-z0-9._-]{1,64}$/.test(name) ? name : undefined;
}

/** The context of the running process (the runner, or the CLI run as the runner user). */
export function currentCliContext(env: NodeJS.ProcessEnv = process.env): LocalCliContext {
  const u = userInfo();
  const wsl = detectWslDistro(env);
  return { username: u.username, home: u.homedir, ...(wsl ? { wslDistro: wsl } : {}) };
}

/**
 * A full local command: `<cli> <verb words> <args>`. Returns null when the result does not match the shared grammar
 * (an argument that would need quoting, an option-looking value, a wrong type): nothing unsafe is ever shown.
 */
export function localCommand(cli: string, verb: string, args: readonly string[] = []): string | null {
  const cmd = [cli, verb, ...args].join(' ');
  return localCommandOk(cmd) ? cmd : null;
}

/**
 * The CLI part for this runner as setup recorded it: under WSL the distro stored in `runnerUser.wslDistro` (systemd
 * services have no WSL_DISTRO_NAME), so every command, the approvals page's own included, has the `wsl -d` shape.
 */
export function runnerCli(
  policy: { runnerUser?: { wslDistro?: string } | undefined } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // demos and help videos only (the mock runtime): show a demo runner user, never the recording person's own home
  const demo = env.AOM_RUNNER_MOCK === '1' && env.AOM_MOCK_RUNNER_USER;
  const ctx =
    demo && isDedicatedUser(demo) ? { username: demo, home: `/home/${demo}` } : currentCliContext(env);
  const wsl = policy?.runnerUser?.wslDistro;
  return localCli(wsl ? { ...ctx, wslDistro: wsl } : ctx);
}
