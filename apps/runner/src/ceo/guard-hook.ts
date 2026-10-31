import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * The use-the-system hook (docs/design/ceo-front-door.md section 3.3): a PreToolUse hook on Edit, Write and NotebookEdit in
 * the CEO's full-power turns. The first edit inside a Guildwise project clone in a turn is blocked once with the routing
 * rule; after `aom ceo job start` (or the first block) edits pass. A nudge plus a log, not a security boundary.
 */
export interface GuardClone {
  path: string;
  /** The remote or project name, for the message. */
  name?: string;
}
export interface GuardConfig {
  clones: GuardClone[];
  /**
   * The runner's private data (docs/investigations/ceo-full-power.md): the places of its data folders as a shell spells them,
   * and the entries in them that hold keys, tokens, queued payloads and raw logs. The deny rules of `floor.json` are the
   * enforcement; this only lets the hook say WHY and what to use instead, which the rule's own refusal does not.
   */
  floor?: { spellings: string[]; entries: string[] };
}
export interface GuardState {
  jobStarted: boolean;
  nudged: boolean;
}

export const GUARD_CONFIG_FILE = 'guard.json';
export const GUARD_STATE_FILE = 'guard-state.json';
export const GUARD_ENV = 'AOM_CEO_TURN_DIR';

/** Why the deny floor refused a shell command, in words the model can act on; null when the floor does not apply to it. */
export function bashFloorMessage(command: string, floor: GuardConfig['floor']): string | null {
  const text = command.replace(/\s+/g, ' ');
  if (
    /\bsystemctl\b[^;&|]*\b(stop|restart|try-restart|reload-or-restart|kill|disable|mask|start|reenable|edit|revert)\b[^;&|]*aom-runner/.test(
      text,
    ) ||
    /\b(pkill|killall)\b[^;&|]*aom/.test(text)
  )
    return (
      'Blocked by the runner safety floor: stopping or restarting the runner from inside a turn would kill this reply. ' +
      'Reading is fine (`systemctl --user status aom-runner-*`, `journalctl --user -u aom-runner-*`, `aom runner status`, `aom runner logs`). ' +
      'To restart it run `aom runner restart --reason "<why>"` and then finish your reply.'
    );
  for (const spelling of floor?.spellings ?? [])
    for (const entry of floor?.entries ?? []) {
      if (!text.includes(`${spelling}/${entry}`)) continue;
      const logs = entry === 'logs' || entry === 'outbox' || entry === 'deploys' || entry === 'active-shifts';
      return logs
        ? `Blocked by the runner safety floor: ${entry} in the runner's data folder holds raw logs and queued payloads that can contain tokens, so a shell may not read it directly. ` +
            'Use `aom runner logs [--kind runner|service|shifts|env|audit] [--name <file>] [--lines N] [--grep text]` and `aom runner status`: ' +
            'the same text with secrets masked. For other workstations: `aom ceo diag workstation <name> --kind runner`.'
        : `Blocked by the runner safety floor: ${entry} in the runner's data folder holds keys, tokens or the runner's configuration, which a shell may not read or write. ` +
            '`aom runner status` shows the runner version, the connection and the switches that matter (secrets are never shown). Ask the owner if something there must change.';
    }
  return null;
}

export const guardMessage = (name: string): string =>
  `This is ${name}'s repository, which Guildwise manages. Route code work through the board (\`aom ceo intake\`). ` +
  `If the owner asked for a direct change, run \`aom ceo job start --kind direct-edit --why "<the owner's words>"\` and retry.`;

export function cloneOf(path: string, clones: readonly GuardClone[]): GuardClone | undefined {
  const p = resolve(path);
  return clones.find((c) => {
    const root = resolve(c.path);
    return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

/** The decision for one tool call; returns the next state. */
export function guardDecision(
  input: { path: string | undefined },
  cfg: GuardConfig,
  state: GuardState,
): { block: string | null; state: GuardState } {
  if (!input.path || state.jobStarted) return { block: null, state };
  const hit = cloneOf(input.path, cfg.clones);
  if (!hit || state.nudged) return { block: null, state };
  return { block: guardMessage(hit.name ?? hit.path), state: { ...state, nudged: true } };
}

export function readGuardState(turnDir: string): GuardState {
  try {
    const s = JSON.parse(readFileSync(join(turnDir, GUARD_STATE_FILE), 'utf8')) as Partial<GuardState>;
    return { jobStarted: s.jobStarted === true, nudged: s.nudged === true };
  } catch {
    return { jobStarted: false, nudged: false };
  }
}

export function writeGuardState(turnDir: string, state: GuardState): void {
  mkdirSync(turnDir, { recursive: true });
  writeFileSync(join(turnDir, GUARD_STATE_FILE), JSON.stringify(state));
}

/** `aom ceo job start` ran: every edit of this turn passes. */
export function markJobStarted(turnDir: string): void {
  writeGuardState(turnDir, { ...readGuardState(turnDir), jobStarted: true });
}

/** The hook process: stdin is the hook JSON; exit 2 with the reason on stderr blocks the call. Never throws. */
export function runGuardHook(
  stdin: string,
  turnDir: string | undefined,
): { exitCode: number; stderr: string } {
  if (!turnDir || !existsSync(join(turnDir, GUARD_CONFIG_FILE))) return { exitCode: 0, stderr: '' };
  try {
    const cfg = JSON.parse(readFileSync(join(turnDir, GUARD_CONFIG_FILE), 'utf8')) as GuardConfig;
    const hook = JSON.parse(stdin) as {
      tool_name?: unknown;
      tool_input?: { file_path?: unknown; notebook_path?: unknown; command?: unknown };
    };
    if (hook.tool_name === 'Bash') {
      const command = hook.tool_input?.command;
      const why = typeof command === 'string' ? bashFloorMessage(command, cfg.floor) : null;
      return why ? { exitCode: 2, stderr: `${why}\n` } : { exitCode: 0, stderr: '' };
    }
    const raw = hook.tool_input?.file_path ?? hook.tool_input?.notebook_path;
    const d = guardDecision(
      { path: typeof raw === 'string' ? raw : undefined },
      cfg,
      readGuardState(turnDir),
    );
    if (d.block === null) return { exitCode: 0, stderr: '' };
    writeGuardState(turnDir, d.state);
    return { exitCode: 2, stderr: `${d.block}\n` };
  } catch {
    return { exitCode: 0, stderr: '' };
  }
}
