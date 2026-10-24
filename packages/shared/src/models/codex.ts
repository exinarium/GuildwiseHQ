import {
  CODEX_RUNTIME,
  HARNESS_REFUSED_ROLES,
  type RoleForRuntimeCheck,
  runtimeRoleProblem,
} from './runtimes.ts';

export { CODEX_RUNTIME };

/**
 * The Codex CLI runtime (docs/RUNNER.md, "Codex CLI runtime"): OpenAI's `codex exec` run by the workstation's runner for card
 * work and chats, inside Codex's own OS sandbox. The runner registers it only when it finds the `codex` binary.
 */

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
 * List prices in USD per million tokens by model id (prefix match, longest first): the Standard tier, short context
 * (up to 272K input tokens) of OpenAI's price list for the models the Codex CLI offers (developers.openai.com, checked
 * 2026-10-24). OpenAI bills cached input tokens at `cacheRead` and does not bill cache writes separately. A model not listed
 * here is "cost unknown" (costed 0 and flagged), never priced as another model. A ChatGPT plan login is not billed per token:
 * its turns carry the same API-equivalent figure the Claude Code subscription turns do.
 */
export const CODEX_MODEL_PRICES: Readonly<
  Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>
> = {
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1 },
  'gpt-6-sol': { input: 2, output: 10, cacheRead: 0.2 },
  'gpt-6-astra': { input: 10, output: 50, cacheRead: 1 },
};

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
export const CODEX_REFUSED_ROLES: readonly string[] = HARNESS_REFUSED_ROLES;

/**
 * Why an agent with this role and these permissions cannot run on the Codex runtime, or null when it can: the Codex case of
 * `runtimeRoleProblem` (the rule all harness runtimes share).
 */
export function codexRoleProblem(role: RoleForRuntimeCheck): string | null {
  return runtimeRoleProblem(CODEX_RUNTIME, role);
}
