import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OWNER_BRIEF_FILE, OWNER_FLOOR_FILE, OWNER_MCP_FILE } from '../adapters/claude-code.ts';
import { ruleAbs } from '../adapters/claude-policy.ts';
import { selfCommand } from '../shims.ts';
import { GUARD_CONFIG_FILE, GUARD_ENV, type GuardClone, writeGuardState } from './guard-hook.ts';

const quote = (w: string): string => `'${w.replace(/'/g, `'\\''`)}'`;

export const turnDirOf = (runnerRoot: string, chatId: string): string =>
  join(runnerRoot, 'ceo-turns', chatId);

/** What lives in a runner's data dir that a model must never read through a shell: keys, tokens, queued payloads, logs. */
const PRIVATE_ENTRIES = [
  'secrets',
  'config.json',
  'config.json.bak',
  'deploy.json',
  'keys',
  'pairings.json',
  'sessions.json',
  'sync-targets.json',
  'toolchains.json',
  'vaults.json',
  'status.json',
  'outbox',
  'outbound',
  'active-shifts',
  'deploys',
  'logs',
];

/**
 * The deny floor of a full-power turn (docs/design/ceo-front-door.md section 3.3). Deny wins over the owner's own rules:
 * the runner restarts only through `aom runner restart` (a restart from inside a turn would kill it before its reply).
 * The runner's secrets and config are denied to Read and Edit, and to Bash commands that NAME them (the root, the data dir,
 * `~` and `$HOME` forms). That is a pattern floor, not a sandbox: a full-power turn runs unsandboxed as the Owner, so a
 * command that builds the path some other way (a variable, a glob, a script) is not caught here. The protection against
 * that is the Owner's own permission relay and the order turns' authorization, not these rules.
 */
export function floorDenies(opts: { runnerRoots: readonly string[]; pid: number; home?: string }): string[] {
  const out = [
    'Bash(systemctl * aom-runner*)',
    'Bash(systemctl:* aom-runner*)',
    'Bash(pkill *aom*)',
    'Bash(killall *aom*)',
    `Bash(kill ${opts.pid})`,
    `Bash(kill * ${opts.pid})`,
  ];
  const home = opts.home ?? homedir();
  const roots = new Set([...opts.runnerRoots, join(home, '.aom-runner')]);
  for (const root of roots) {
    for (const tool of ['Read', 'Edit'])
      out.push(
        `${tool}(${ruleAbs(join(root, 'secrets'))}/**)`,
        `${tool}(${ruleAbs(join(root, 'config.json'))})`,
      );
    // The same places as spelled in a shell command: absolute, `~/...` and `$HOME/...`.
    const spellings = new Set([root]);
    if (home.length > 1 && root.startsWith(`${home}/`)) {
      const rest = root.slice(home.length);
      spellings.add(`~${rest}`);
      spellings.add(`$HOME${rest}`);
      spellings.add(`\${HOME}${rest}`);
    }
    for (const spelling of spellings)
      for (const entry of PRIVATE_ENTRIES) out.push(`Bash(*${spelling}/${entry}*)`);
  }
  return out;
}

export interface TurnFilesInput {
  turnDir: string;
  /** The static brief (persona, routing rule, verbs, policy): written every turn, because a resumed session does not keep it. */
  brief: string;
  mode: 'owner' | 'order';
  /** The IPC variables the relay needs (AOM_IPC_URL, AOM_IPC_SOCKET, AOM_SHIFT_TOKEN). */
  ipcEnv: Record<string, string>;
  runnerRoots: readonly string[];
  pid: number;
  clones: GuardClone[];
  home?: string;
}

/** Creates `<turnDir>` (0700) with the brief, the permission relay's MCP config, the deny floor and the guard's inputs. */
export function writeTurnFiles(i: TurnFilesInput): void {
  mkdirSync(i.turnDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(i.turnDir, 0o700);
  } catch {
    // not supported on every platform
  }
  writeFileSync(join(i.turnDir, OWNER_BRIEF_FILE), i.brief, { mode: 0o600 });
  const aom = selfCommand('aom');
  const relay = {
    mcpServers: {
      aom_permission: {
        command: aom[0],
        args: [...aom.slice(1), 'ceo-permission-mcp'],
        env: { ...i.ipcEnv, AOM_PERMISSION_MODE: i.mode },
      },
    },
  };
  writeFileSync(join(i.turnDir, OWNER_MCP_FILE), `${JSON.stringify(relay)}\n`, { mode: 0o600 });
  const guard = `${[...aom, 'ceo', 'guard'].map(quote).join(' ')}`;
  const floor = {
    permissions: {
      deny: floorDenies({ runnerRoots: i.runnerRoots, pid: i.pid, ...(i.home ? { home: i.home } : {}) }),
    },
    hooks: {
      PreToolUse: [{ matcher: 'Edit|Write|NotebookEdit', hooks: [{ type: 'command', command: guard }] }],
    },
  };
  writeFileSync(join(i.turnDir, OWNER_FLOOR_FILE), `${JSON.stringify(floor, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(i.turnDir, GUARD_CONFIG_FILE), JSON.stringify({ clones: i.clones }), { mode: 0o600 });
  writeGuardState(i.turnDir, { jobStarted: false, nudged: false });
}

export function removeTurnDir(turnDir: string): void {
  rmSync(turnDir, { recursive: true, force: true });
}

export { GUARD_ENV };

/** The user message of an owner or order turn: the Guildwise context block, how long it waited, then the message. */
export function composeOwnerMessage(
  msg: { message: string; briefDelta?: string | undefined; queuedAt?: string | undefined },
  now: Date = new Date(),
): string {
  const parts: string[] = [];
  if (msg.briefDelta?.trim())
    parts.push(`<guildwise-context>\n${msg.briefDelta.trim()}\n</guildwise-context>`);
  if (msg.queuedAt) {
    const mins = Math.max(0, Math.round((now.getTime() - new Date(msg.queuedAt).getTime()) / 60_000));
    const waited =
      mins < 90
        ? `${mins} minute${mins === 1 ? '' : 's'}`
        : mins < 2880
          ? `${Math.round(mins / 60)} hours`
          : `${Math.round(mins / 1440)} days`;
    parts.push(`(This message waited ${waited} in the queue while the workstation was offline.)`);
  }
  parts.push(msg.message);
  return parts.join('\n\n');
}
