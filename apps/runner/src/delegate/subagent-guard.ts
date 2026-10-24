import { readFileSync } from 'node:fs';
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
}

export function loadSubagentGuardConfig(file: string | undefined): SubagentGuardConfig {
  try {
    const j = JSON.parse(readFileSync(file ?? '', 'utf8')) as SubagentGuardConfig;
    const allowed: Record<string, string> = {};
    if (j && typeof j.allowed === 'object' && j.allowed)
      for (const [k, v] of Object.entries(j.allowed)) if (typeof v === 'string') allowed[k] = v;
    return { allowed };
  } catch {
    // an unreadable configuration allows nothing
    return { allowed: {} };
  }
}

const deny = (reason: string): { stdout: string; code: number } => ({
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
}): Promise<{ stdout: string; code: number }> {
  let input: { tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: unknown };
  try {
    input = JSON.parse(opts.stdin);
  } catch {
    return deny('the hook input could not be read');
  }
  if (input.tool_name !== undefined && input.tool_name !== 'Agent' && input.tool_name !== 'Task')
    return { stdout: '', code: 0 };
  const raw = input.tool_input?.subagent_type;
  const name = typeof raw === 'string' ? raw.trim() : '';
  const handle = name ? opts.cfg.allowed[name] : undefined;
  const granted = Object.keys(opts.cfg.allowed);
  if (!name || !handle)
    return deny(
      `the subagent "${name || 'general-purpose'}" is not one of your delegation targets${granted.length ? ` (yours: ${granted.join(', ')})` : ''}.`,
    );
  const toolUseId = typeof input.tool_use_id === 'string' ? input.tool_use_id : '';
  if (!toolUseId) return deny('the call has no id');
  const r = await opts.ask(name, handle, toolUseId);
  return r.ok ? { stdout: '', code: 0 } : deny(r.error ?? 'the server refused the delegate');
}

export { withGuardDeadline };
