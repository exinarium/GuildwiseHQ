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

/**
 * The hook's own deadline. Claude Code counts a hook that is killed at its time limit as failed (the call goes through), so the
 * guard answers "deny" itself before that. It must stay below the hook `timeout` in the agent's settings (10 s).
 */
export const SKILL_GUARD_HOOK_TIMEOUT_S = 10;
export const SKILL_GUARD_DEADLINE_MS = 7_000;

export function skillGuardDeadlineMs(env: Record<string, string | undefined>): number {
  const n = Number(env.AOM_SKILL_GUARD_DEADLINE_MS);
  return Number.isFinite(n) && n > 0 && n < SKILL_GUARD_HOOK_TIMEOUT_S * 1000 ? n : SKILL_GUARD_DEADLINE_MS;
}

/** Runs `work`; if it has not finished by the deadline the answer is a refusal (never an allow). */
export async function withGuardDeadline(
  work: () => Promise<{ stdout: string; code: number }> | { stdout: string; code: number },
  ms: number,
): Promise<{ stdout: string; code: number }> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<{ stdout: string; code: number }>((resolve) => {
    timer = setTimeout(() => resolve(deny('the guard timed out')), ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(work), late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
