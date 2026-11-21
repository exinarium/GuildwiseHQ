import { homedir, userInfo } from 'node:os';
import type { Command } from 'commander';
import { resolveDataDir } from '../paths.ts';
import { realExecutor } from '../toolchain/exec.ts';
import { parseSetupOptions, type RawSetupFlags, SetupError } from './options.ts';
import { terminalPrompter } from './prompt.ts';
import { runSetup } from './setup.ts';

const collect = (v: string, prev: string[] = []) => [...prev, v];

async function readStdin(): Promise<string> {
  let s = '';
  for await (const chunk of process.stdin) s += String(chunk);
  return s;
}

/** Registers `guildwise-runner setup` (R20) on the runner CLI. */
export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description(
      'set the local permissions of this workstation (DevOps organizations, sudo, Docker for deploys, deploy approvals); writes only policy.json and prints the root steps for guildwise-admin',
    )
    .option('--yes', 'no questions: every step not given by a flag takes the safest value')
    .option('--runner-user <mode>', 'dedicated|current (Linux and macOS)')
    .option('--wsl-distro <mode>', 'dedicated|default (Windows installer only)')
    .option('--legacy <mode>', 'quarantine|remove (installer only)')
    .option(
      '--accept-root-equivalent',
      'let a root-equivalent runner user start, with a warning (needed by --docker group)',
    )
    .option(
      '--devops-orgs <ids>',
      'none, or organization ids separated by commas (each must be offered by the server)',
    )
    .option('--sudo <mode>', 'on|off')
    .option(
      '--sudo-password-stdin',
      'with the current user and --sudo on: read your sudo password from stdin',
    )
    .option('--docker <mode>', 'none|narrow|group (group needs --accept-root-equivalent)')
    .option('--approve-app <app=folder>', 'a compose app for the narrow Docker helper (repeatable)', collect)
    .option('--deploy <mode>', 'ask|off')
    .option('--deploy-pin-commit', 'bind approved redeploys to the commit')
    .option(
      '--allow-unsigned-from <origin>',
      'accept unsigned runner updates from this exact origin (test machines only; repeatable)',
      collect,
    )
    .option('--data-dir <path>', 'runner data directory (default: $AOM_RUNNER_HOME or ~/.aom-runner)')
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
            prompter: process.stdin.isTTY && !opts.yes && !opts.sudoPasswordStdin ? terminalPrompter : null,
            out: (line) => console.log(line),
            readStdin,
            exec: realExecutor,
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
