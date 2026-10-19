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
}
export interface GuardState {
  jobStarted: boolean;
  nudged: boolean;
}

export const GUARD_CONFIG_FILE = 'guard.json';
export const GUARD_STATE_FILE = 'guard-state.json';
export const GUARD_ENV = 'AOM_CEO_TURN_DIR';

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
    const hook = JSON.parse(stdin) as { tool_input?: { file_path?: unknown; notebook_path?: unknown } };
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
