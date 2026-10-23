import {
  DIRECT_RUNTIME,
  directProvider,
  isKnownChoice,
  type ModelChoice,
  type ReportedProvider,
  splitDirectModel,
} from '@aom/shared';
import { one, type Queryable } from '../db/sql.ts';

/** What a workstation's runner last reported about one runtime (`workstations.runtimes`). */
export interface RuntimeReport {
  id: string;
  available?: boolean;
  providers?: ReportedProvider[];
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

/**
 * Why this choice cannot run on a workstation, in words for the owner, or null when it can (or when nothing is known about the
 * workstation yet). A runtime the runner does not report is not installed; a direct model needs its provider's key stored there
 * and, except on an OpenAI-compatible endpoint, a model the provider offers. A Claude Code that is limited or logged out is not
 * reported here: the runner says so in its own words when the turn arrives.
 */
export function runtimeProblem(reports: readonly RuntimeReport[], choice: ModelChoice): string | null {
  if (reports.length === 0) return null;
  // Only the direct-model runtime is judged here. Another runtime the workstation does not have is reported by its runner in its own
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
  return null;
}
