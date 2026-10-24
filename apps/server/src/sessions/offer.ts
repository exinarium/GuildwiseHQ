import {
  choiceKeyUse,
  DIRECT_RUNTIME,
  directProvider,
  GEMINI_RUNTIME,
  isKnownChoice,
  type ModelChoice,
  OPENCODE_RUNTIME,
  PROVIDER_KEY_LABEL,
  providerOfChoice,
  type ReportedBackend,
  type ReportedKey,
  type ReportedModel,
  type ReportedProvider,
  RUNTIME_GUARANTEES,
  splitBackendModel,
  splitDirectModel,
} from '@aom/shared';
import { one, type Queryable } from '../db/sql.ts';

/** What a workstation's runner last reported about one runtime (`workstations.runtimes`). */
export interface RuntimeReport {
  id: string;
  available?: boolean;
  providers?: ReportedProvider[];
  keys?: ReportedKey[];
  backends?: ReportedBackend[];
  models?: ReportedModel[];
  authVia?: 'login' | 'key';
  sandbox?: string;
  sandboxReason?: string;
  auth?: string;
}

/** The runtimes a workstation reported at its last hello or re-probe (empty: unknown, so nothing is refused for it). */
export async function runtimeReports(
  db: Queryable,
  workstationId: string | null | undefined,
): Promise<RuntimeReport[]> {
  if (!workstationId) return [];
  const w = await one(db, 'SELECT runtimes FROM workstations WHERE id=$1', [workstationId]);
  return Array.isArray(w?.runtimes) ? (w?.runtimes as RuntimeReport[]) : [];
}

/** The direct-model providers a workstation offers (names and models). */
export const providersOf = (reports: readonly RuntimeReport[]): ReportedProvider[] =>
  reports.find((r) => r.id === DIRECT_RUNTIME && r.available !== false)?.providers ?? [];

/** What the pickers need beyond the direct-model providers: the Claude Code backends and the data-driven model lists. */
export function extrasOf(reports: readonly RuntimeReport[]): {
  backends?: ReportedBackend[];
  models?: Record<string, ReportedModel[]>;
} {
  const backends = reports.find((r) => r.id === 'claude-code')?.backends;
  const models: Record<string, ReportedModel[]> = {};
  for (const r of reports) if (r.models?.length) models[r.id] = r.models;
  return { ...(backends?.length ? { backends } : {}), ...(Object.keys(models).length ? { models } : {}) };
}

/** Words for a runtime that is installed but cannot take work (signed out, no key, no sandbox). */
function harnessProblem(rt: RuntimeReport, runtime: string): string | null {
  const short = RUNTIME_GUARANTEES[runtime]?.short ?? runtime;
  if (rt.available !== false) return null;
  if (rt.auth === 'expired')
    return runtime === OPENCODE_RUNTIME
      ? 'opencode has no provider key on this workstation: add one under Workstations > Model providers (or ask an Owner or Admin to share the organization’s)'
      : runtime === GEMINI_RUNTIME
        ? 'the Gemini CLI is not signed in on this workstation (sign in with Google as the runner user, or add a Google Gemini key under Model providers)'
        : `${short} is not signed in on this workstation: run \`codex login\` as the runner user`;
  return `${short} cannot run on this workstation: ${rt.sandboxReason ?? 'it is unavailable'}`;
}

/**
 * Why this choice cannot run on a workstation, in words for the owner, or null when it can (or when nothing is known about the
 * workstation yet). A runtime the runner does not report is not installed; a direct model needs its provider's key stored there
 * and, except on an OpenAI-compatible endpoint, a model the provider offers. A CLI harness (Codex, Gemini CLI, opencode) reports
 * itself unavailable with the reason when its sandbox does not run or nobody is signed in. A Claude Code model behind Bedrock,
 * Vertex or a gateway needs that credential there. `orgId`: the key in effect must be the workstation's own or that organization's.
 * A Claude Code that is limited or logged out is not reported here: the runner says so in its own words when the turn arrives.
 */
export function runtimeProblem(
  reports: readonly RuntimeReport[],
  choice: ModelChoice,
  orgId?: string,
): string | null {
  if (reports.length === 0) return null;
  const keyProblem = (): string | null => {
    const provider = providerOfChoice(choice.runtime, choice.model);
    if (!provider) return null;
    // Gemini spends the `google` key only in key mode; its login needs none.
    if (choice.runtime === GEMINI_RUNTIME && reports.find((r) => r.id === GEMINI_RUNTIME)?.authVia !== 'key')
      return null;
    if (choiceKeyUse(reports, choice, orgId)) return null;
    const keys = reports.find((r) => r.id === DIRECT_RUNTIME)?.keys;
    if (!keys) return null; // an older runner does not report its keys: the runner says it itself
    const label = PROVIDER_KEY_LABEL[provider] ?? provider;
    return `${label} is not set up on this workstation${orgId ? ' for this organization' : ''}: add its key under Workstations > Model providers (or ask an Owner or Admin to share the organization’s)`;
  };
  if (RUNTIME_GUARANTEES[choice.runtime]) {
    const rt = reports.find((r) => r.id === choice.runtime);
    const short = RUNTIME_GUARANTEES[choice.runtime]?.short ?? choice.runtime;
    if (!rt)
      return `${short} is not installed on this workstation (or its runner has to be restarted to find it)`;
    const bad = harnessProblem(rt, choice.runtime);
    if (bad) return bad;
    return choice.runtime === OPENCODE_RUNTIME ? keyProblem() : null;
  }
  if (choice.runtime === 'claude-code') {
    const q = splitBackendModel(choice.model);
    if (!q) return null;
    const rt = reports.find((r) => r.id === 'claude-code');
    if (rt && !rt.backends?.some((b) => b.id === q.backend))
      return `${PROVIDER_KEY_LABEL[q.backend] ?? q.backend} is not set up on this workstation: add its credentials under Workstations > Model providers (or ask an Owner or Admin to share the organization’s)`;
    return keyProblem();
  }
  // Only the direct-model runtime is judged below. Another runtime the workstation does not have is reported by its runner in its own
  // words when the turn arrives (the same `runtime ... is not available` it always gave), and a workstation that reports no Claude
  // Code (a mock-only one) must keep running the turns it ran before.
  if (choice.runtime !== DIRECT_RUNTIME) return null;
  const rt = reports.find((r) => r.id === choice.runtime);
  if (!rt) return `the ${choice.runtime} runtime is not available on this workstation (update its runner)`;
  const d = splitDirectModel(choice.model);
  if (!d) return `"${choice.model}" is not a provider:model id`;
  const label = directProvider(d.provider)?.label ?? d.provider;
  const providers = rt.available === false ? [] : (rt.providers ?? []);
  if (!providers.some((p) => p.id === d.provider))
    return `${label} is not set up on this workstation: add its API key under Workstations > Model providers`;
  if (!isKnownChoice(choice, providers))
    return `${label} does not offer the model "${d.model}" on this workstation`;
  return keyProblem();
}
