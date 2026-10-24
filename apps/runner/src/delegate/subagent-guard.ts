import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withGuardDeadline } from '../capabilities/skill-guard.ts';

/**
 * The allow-list for Claude Code's `Agent` tool (a PreToolUse hook, `aom subagent-guard`; docs/ARCHITECTURE.md section 38.9).
 * An agent without delegation targets has the tool removed altogether (a deny rule); one with targets gets exactly those as
 * native subagents, and this hook refuses every other subagent type (Claude Code's own `general-purpose`, `Explore`, ... run
 * on the parent's model and are not part of any grant) and, for a granted one, asks the runner, which asks the server
 * (`delegate.begin`): the per-target count, the budgets and the provider caps are checked before each native subagent starts.
 * Every failure of the guard is a refusal (fail closed).
 */
export interface SubagentGuardConfig {
  /** The subagent type name to the grant's handle. */
  allowed: Record<string, string>;
  /** R3c: the grant's time limit for one call of each type, in seconds. */
  limits?: Record<string, number>;
  /** R3c: where the running calls leave their start marker (`<tool use id>.json`); absent: no time limit is enforced. */
  stateDir?: string;
}

export function loadSubagentGuardConfig(file: string | undefined): SubagentGuardConfig {
  try {
    const j = JSON.parse(readFileSync(file ?? '', 'utf8')) as SubagentGuardConfig;
    const allowed: Record<string, string> = {};
    if (j && typeof j.allowed === 'object' && j.allowed)
      for (const [k, v] of Object.entries(j.allowed)) if (typeof v === 'string') allowed[k] = v;
    const limits: Record<string, number> = {};
    if (j && typeof j.limits === 'object' && j.limits)
      for (const [k, v] of Object.entries(j.limits)) if (typeof v === 'number' && v > 0) limits[k] = v;
    return {
      allowed,
      ...(Object.keys(limits).length ? { limits } : {}),
      ...(typeof j.stateDir === 'string' && j.stateDir ? { stateDir: j.stateDir } : {}),
    };
  } catch {
    // an unreadable configuration allows nothing
    return { allowed: {} };
  }
}

export const denyHook = (reason: string): { stdout: string; code: number } => ({
  stdout: JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Refused by the subagent guard: ${reason}`,
    },
  }),
  code: 0,
});

export type SubagentGuardAsk = (
  name: string,
  handle: string,
  toolUseId: string,
) => Promise<{ ok: boolean; error?: string }>;

export async function runSubagentGuard(opts: {
  stdin: string;
  cfg: SubagentGuardConfig;
  ask: SubagentGuardAsk;
  now?: () => number;
}): Promise<{ stdout: string; code: number }> {
  let input: { tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: unknown };
  try {
    input = JSON.parse(opts.stdin);
  } catch {
    return denyHook('the hook input could not be read');
  }
  if (input.tool_name !== undefined && input.tool_name !== 'Agent' && input.tool_name !== 'Task')
    return { stdout: '', code: 0 };
  const raw = input.tool_input?.subagent_type;
  const name = typeof raw === 'string' ? raw.trim() : '';
  const handle = name ? opts.cfg.allowed[name] : undefined;
  const granted = Object.keys(opts.cfg.allowed);
  if (!name || !handle)
    return denyHook(
      `the subagent "${name || 'general-purpose'}" is not one of your delegation targets${granted.length ? ` (yours: ${granted.join(', ')})` : ''}.`,
    );
  const toolUseId = typeof input.tool_use_id === 'string' ? input.tool_use_id : '';
  if (!toolUseId) return denyHook('the call has no id');
  const r = await opts.ask(name, handle, toolUseId);
  if (!r.ok) return denyHook(r.error ?? 'the server refused the delegate');
  // R3c: the call's clock starts now; `runSubagentDeadline` refuses the subagent's tool calls once it has run out
  const limit = opts.cfg.limits?.[name];
  if (opts.cfg.stateDir && limit) {
    // The marker is the time limit's clock. Without it the call would run unlimited, so a call that cannot leave one is refused
    // (fail closed). Written whole and renamed into place, so the deadline hook never reads half a marker.
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(toolUseId))
      return denyHook('the call has an id the time limit cannot track');
    try {
      mkdirSync(opts.cfg.stateDir, { recursive: true, mode: 0o700 });
      const file = join(opts.cfg.stateDir, `${toolUseId}.json`);
      const tmp = `${file}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ name, startedAt: (opts.now ?? Date.now)(), limitMs: limit * 1000 }),
        {
          mode: 0o600,
        },
      );
      renameSync(tmp, file);
    } catch {
      return denyHook('the time limit of this call could not be started');
    }
  }
  return { stdout: '', code: 0 };
}

/** How long a marker whose end was never seen (a crash) keeps counting, beyond the limit itself. */
export const SUBAGENT_MARKER_GRACE_MS = 5 * 60_000;

interface Marker {
  name: string;
  startedAt: number;
  limitMs: number;
}

/** The markers, and whether every one could be read: a marker that cannot be read is a clock nobody can see (the caller refuses). */
function readMarkers(dir: string): { markers: Array<{ file: string; m: Marker }>; unreadable: boolean } {
  const markers: Array<{ file: string; m: Marker }> = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return { markers, unreadable: true };
  }
  let unreadable = false;
  for (const f of names) {
    try {
      const m = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Marker;
      if (typeof m.startedAt === 'number' && typeof m.limitMs === 'number')
        markers.push({ file: join(dir, f), m });
      else unreadable = true;
    } catch {
      unreadable = true;
    }
  }
  return { markers, unreadable };
}

/**
 * The time limit of a native subagent's call (R3c; `aom subagent-deadline`, a PreToolUse hook on every tool). Claude Code has no
 * per-call limit for a subagent, so the guard keeps the start of each call (`runSubagentGuard`) and, once a call has run past
 * the grant's limit, refuses every further tool call of the session until the call ends (its `Agent` call returns, which removes
 * the marker: `runSubagentDone`): the subagent can only answer with what it has, and the parent, which waits in the foreground,
 * gets that answer. A marker whose end was never seen (a crash) stops counting after the limit plus five minutes. Failing closed
 * (security review, finding 14): a hook that cannot read its markers refuses the call, because a clock nobody can read cannot
 * hold the limit. The markers live in the runner's own folder (the Claude config dir), which the agent's shell cannot write.
 */
export function runSubagentDeadline(opts: { stdin: string; cfg: SubagentGuardConfig; now?: () => number }): {
  stdout: string;
  code: number;
} {
  if (!opts.cfg.stateDir) return { stdout: '', code: 0 };
  const now = (opts.now ?? Date.now)();
  let toolName = '';
  try {
    toolName = String((JSON.parse(opts.stdin) as { tool_name?: unknown }).tool_name ?? '');
  } catch {
    // an unreadable input is not this hook's business
  }
  const { markers, unreadable } = readMarkers(opts.cfg.stateDir);
  if (unreadable)
    return denyHook('the time limit of the running subagent could not be read, so no tool is allowed');
  for (const { file, m } of markers) {
    if (now > m.startedAt + m.limitMs + SUBAGENT_MARKER_GRACE_MS) {
      rmSync(file, { force: true });
      continue;
    }
    if (now > m.startedAt + m.limitMs) {
      const secs = Math.round(m.limitMs / 1000);
      return denyHook(
        `the subagent "${m.name}" has used its time limit of ${secs} seconds for this call${
          toolName === 'Agent' || toolName === 'Task'
            ? ''
            : ': stop using tools and answer with what you have'
        }.`,
      );
    }
  }
  return { stdout: '', code: 0 };
}

/** The end of a native subagent's call (`aom subagent-done`, a PostToolUse hook on the `Agent` tool): its marker goes. */
export function runSubagentDone(opts: { stdin: string; cfg: SubagentGuardConfig }): {
  stdout: string;
  code: number;
} {
  try {
    const id = (JSON.parse(opts.stdin) as { tool_use_id?: unknown }).tool_use_id;
    if (opts.cfg.stateDir && typeof id === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(id))
      rmSync(join(opts.cfg.stateDir, `${id}.json`), { force: true });
  } catch {
    // nothing to remove
  }
  return { stdout: '', code: 0 };
}

export { withGuardDeadline };
