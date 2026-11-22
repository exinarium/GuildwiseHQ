import { homedir, userInfo } from 'node:os';
import type { Command } from 'commander';
import { resolveDataDir } from '../paths.ts';
import { realExecutor } from '../toolchain/exec.ts';
import { installExtra } from '../toolchain/extras.ts';
import { parseSetupOptions, type RawSetupFlags, SetupError } from './options.ts';
import { terminalPrompter } from './prompt.ts';
import { runSetup } from './setup.ts';

const collect = (v: string, prev: string[] = []) => [...prev, v];

/** Registers `guildwise-runner setup` (R20) on the runner CLI. */
export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description(
      'set the local permissions of this workstation (DevOps organizations, Docker, deploy approvals); writes only policy.json and prints the root steps for guildwise-admin',
    )
    .option('--yes', 'no questions: every step not given by a flag takes the safest value')
    .option('--runner-user <mode>', 'dedicated|current (Linux and macOS)')
    .option('--wsl-distro <mode>', 'dedicated|default (Windows installer only)')
    .option('--legacy <mode>', 'quarantine|remove (installer only)')
    .option(
      '--accept-root-equivalent',
      'let a root-equivalent runner user start, with a warning (needed by --docker host)',
    )
    .option(
      '--devops-orgs <names>',
      'none, or organization names (exact) or ids separated by commas (each must be offered by the server)',
    )
    .option(
      '--devops-requests <mode>',
      'ask|auto: DevOps tasks from the website wait for your yes (default ask)',
    )
    .option(
      '--allow-scripts <repos>',
      'repository URLs or names, separated by commas, whose installs may run their scripts (each must be offered)',
    )
    .option('--with-ytdlp', "install yt-dlp (video transcripts) into the runner's own folder (the default)")
    .option('--no-ytdlp', 'do not install yt-dlp')
    .option('--wsl-distro-name <name>', 'Windows: the WSL distro the runner lives in (installer only)')
    .option(
      '--docker <mode>',
      "rootless|host|shared|none (default: the runner's own rootless Docker; host needs --accept-root-equivalent, shared needs --accept-shared-daemon)",
    )
    .option('--docker-found <what>', 'rootful|desktop|own|shared|none (installer only: what it detected)')
    .option('--docker-socket <path>', "macOS: your Docker Desktop socket; shared: the other daemon's socket")
    .option(
      '--accept-shared-daemon',
      'let the runner use a rootless Docker daemon of another user (it can control every container on it)',
    )
    .option('--deploy <mode>', 'ask|off')
    .option('--deploy-pin-commit', 'bind approved redeploys to the commit')
    .option(
      '--allow-unsigned-from <origin>',
      'accept unsigned runner updates from this exact origin (test machines only; repeatable)',
      collect,
    )
    .option('--data-dir <path>', 'runner data directory (default: $AOM_RUNNER_HOME or ~/.aom-runner)')
    .option(
      '--instance <name>',
      'a named runner instance (its own user guildwise-runner-<name>, for example uat or prod); default: the single runner',
    )
    .action(async (raw: RawSetupFlags) => {
      try {
        const opts = parseSetupOptions(raw);
        const r = await runSetup(
          {
            home: homedir(),
            uid: typeof process.getuid === 'function' ? process.getuid() : -1,
            username: userInfo().username,
            platform: process.platform,
            dataRoot: resolveDataDir(opts.dataDir),
            prompter: process.stdin.isTTY && !opts.yes ? terminalPrompter : null,
            out: (line) => console.log(line),
            exec: realExecutor,
            installExtra: (name) => installExtra(name, { log: (l) => console.log(`    ${l}`) }),
          },
          opts,
        );
        process.exitCode = r.exitCode;
      } catch (e) {
        if (!(e instanceof SetupError)) throw e;
        console.error(`setup: ${e.message}`);
        process.exitCode = e.exitCode;
      }
    });
}
