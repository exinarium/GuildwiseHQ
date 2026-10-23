import type { AgentPermissions } from '../roles/schema.ts';

/**
 * The Codex CLI runtime (docs/RUNNER.md, "Codex CLI runtime"): OpenAI's `codex exec` run by the workstation's runner for card
 * work and chats, inside Codex's own OS sandbox. The runner registers it only when it finds the `codex` binary.
 */
export const CODEX_RUNTIME = 'codex';

/** Usage and cost of a Codex turn name the model as `codex:<model>` so the price lookup never falls back to a Claude price. */
export const CODEX_MODEL_PREFIX = 'codex:';

export const codexUsageModel = (model: string): string =>
  model.startsWith(CODEX_MODEL_PREFIX) ? model : `${CODEX_MODEL_PREFIX}${model}`;

/**
 * A model of the Codex runtime: `codex:<model>` (what the runner reports in usage) or a bare OpenAI model id as the agent
 * record holds it (`gpt-6-sol`). Neither has a Claude price.
 */
export const isCodexModel = (model: string): boolean =>
  model.startsWith(CODEX_MODEL_PREFIX) || /^(gpt-\d|o\d|codex-)/i.test(model);

/**
 * List prices in USD per million tokens by model id (prefix match, longest first). Empty on purpose: the prices of the models
 * the Codex CLI offers were not published where this table could be checked, so a Codex turn is "cost unknown" (costed 0 and
 * flagged), never priced as another model. Add an entry here to price one.
 */
export const CODEX_MODEL_PRICES: Readonly<
  Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>
> = {};

export function codexPrice(
  model: string,
): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null {
  const m = (
    model.startsWith(CODEX_MODEL_PREFIX) ? model.slice(CODEX_MODEL_PREFIX.length) : model
  ).toLowerCase();
  const hit = Object.keys(CODEX_MODEL_PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => m === k || m.startsWith(`${k}-`));
  return hit ? (CODEX_MODEL_PRICES[hit] ?? null) : null;
}

/** Roles that never run on Codex whatever their permissions (the runtime has no equivalent of their guard). */
export const CODEX_REFUSED_ROLES: readonly string[] = ['devops', 'ceo'];

/**
 * Why an agent with this role and these permissions cannot run on the Codex runtime, or null when it can. The Codex sandbox
 * gives a private home, a worktree-only write area, no network and a read allow-list, but it cannot: remove the shell tool,
 * limit writes to globs that do not exist yet (a tester's e2e folder), open the Unix sockets a browser needs, or host the
 * DevOps guard. A role that depends on one of those stays on Claude Code. The runner applies the same rule at start.
 */
export function codexRoleProblem(role: {
  roleKey: string;
  isDevops?: boolean;
  permissions: Pick<AgentPermissions, 'allowedTools' | 'writableGlobs' | 'browser'>;
}): string | null {
  if (role.isDevops || CODEX_REFUSED_ROLES.includes(role.roleKey))
    return `the ${role.roleKey} role needs its own guard and full workstation access, which the Codex sandbox cannot provide: use Claude Code`;
  const p = role.permissions;
  if (!p.allowedTools.includes('shell'))
    return 'this role has no shell, and Codex always has one: use Claude Code (the shell-less roles are not offered on Codex)';
  if (p.browser)
    return 'this role runs browsers, which need Unix sockets the Codex sandbox does not open: use Claude Code';
  if (p.allowedTools.includes('edit') && p.writableGlobs !== null)
    return 'this role may write only certain paths, which the Codex sandbox cannot limit to files that do not exist yet: use Claude Code';
  return null;
}
