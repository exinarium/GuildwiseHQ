import { readFileSync } from 'node:fs';

/**
 * The allow-list for Claude Code's `Skill` tool (a PreToolUse hook, `aom skill-guard`). An agent that has granted skills
 * gets Claude Code's native skill loading, but the account's own synced skills and plugins must not reach it: Claude Code
 * lists them and lets the model call them whatever the permission mode says (verified with claude 2.1.309). The hook refuses
 * every `Skill` call whose name is not in the agent's granted set, so the allow-list holds for names we cannot enumerate.
 */
export interface SkillGuardConfig {
  /** The folder names of the materialised skills. */
  allowed: string[];
}

export function loadSkillGuardConfig(file: string | undefined): SkillGuardConfig {
  try {
    const j = JSON.parse(readFileSync(file ?? '', 'utf8')) as SkillGuardConfig;
    return { allowed: Array.isArray(j.allowed) ? j.allowed.filter((x) => typeof x === 'string') : [] };
  } catch {
    // an unreadable configuration allows nothing
    return { allowed: [] };
  }
}

export function runSkillGuard(opts: { stdin: string; cfg: SkillGuardConfig }): {
  stdout: string;
  code: number;
} {
  let input: { tool_name?: string; tool_input?: Record<string, unknown> };
  try {
    input = JSON.parse(opts.stdin);
  } catch {
    return deny('the hook input could not be read');
  }
  if (input.tool_name !== undefined && input.tool_name !== 'Skill') return { stdout: '', code: 0 };
  const raw = input.tool_input?.skill ?? input.tool_input?.name ?? input.tool_input?.command;
  const name = typeof raw === 'string' ? raw.trim().replace(/^\//, '') : '';
  if (name && opts.cfg.allowed.includes(name)) return { stdout: '', code: 0 };
  return deny(`the skill "${name || '?'}" is not granted to this agent`);
}

const deny = (reason: string): { stdout: string; code: number } => ({
  stdout: JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Refused by the skill guard: ${reason}. Use \`aom skill list\` for what you may load.`,
    },
  }),
  code: 0,
});
