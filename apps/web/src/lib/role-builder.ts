import type { OrgCatalogueResponse, RoleDraftInput } from '@aom/shared';

type Claim = RoleDraftInput['claimableStages'][number];

/** A step of a custom workflow a role can take, for the "Steps it can take" checklist. */
export interface ClaimableStep {
  id: string;
  label: string;
  /** The role that works it now, when the workflow names one. */
  claimRole: string | null;
}
export interface ClaimableWorkflow {
  key: string;
  name: string;
  /** `draft` and `pending_approval` workflows can be picked too, so a role and its workflow are made together. */
  status: 'active' | 'draft' | 'pending_approval';
  steps: ClaimableStep[];
}

const USABLE = new Set(['active', 'draft', 'pending_approval']);

/**
 * The custom workflows and their agent steps, from the organization catalogue: for each workflow its newest active,
 * draft or waiting version. Built-in workflows are left out (custom roles do not take their steps).
 */
export function claimableWorkflows(workflows: OrgCatalogueResponse['workflows']): ClaimableWorkflow[] {
  const out: ClaimableWorkflow[] = [];
  for (const wf of workflows) {
    if (wf.builtIn) continue;
    // Versions are newest first; prefer the newest version that is usable.
    const v = wf.versions.find((x) => USABLE.has(x.status));
    if (!v) continue;
    const def = v.definition;
    out.push({
      key: wf.key,
      name: def.name || wf.key,
      status: v.status as ClaimableWorkflow['status'],
      steps: def.stages
        .filter((s) => s.kind === 'agent')
        .map((s) => ({ id: s.id, label: s.label || s.id, claimRole: s.claimRole })),
    });
  }
  return out;
}

export const claimsAny = (claims: readonly Claim[], workflowKey: string): boolean =>
  claims.some((c) => c.workflowKey === workflowKey && c.stageId === '*');

export const claimsStep = (claims: readonly Claim[], workflowKey: string, stageId: string): boolean =>
  claims.some((c) => c.workflowKey === workflowKey && (c.stageId === stageId || c.stageId === '*'));

/** Ticks or unticks one step. Unticking a step under an "any step" claim expands it to the other steps. */
export function toggleStep(
  claims: readonly Claim[],
  wf: ClaimableWorkflow,
  stageId: string,
  on: boolean,
): Claim[] {
  const rest = claims.filter(
    (c) => !(c.workflowKey === wf.key && (c.stageId === stageId || c.stageId === '*')),
  );
  if (on) return [...rest, { workflowKey: wf.key, stageId }];
  if (claimsAny(claims, wf.key))
    return [
      ...rest,
      ...wf.steps.filter((s) => s.id !== stageId).map((s) => ({ workflowKey: wf.key, stageId: s.id })),
    ];
  return rest;
}

/** "Any step of this workflow": one wildcard claim instead of one per step. */
export function toggleAnyStep(claims: readonly Claim[], workflowKey: string, on: boolean): Claim[] {
  const rest = claims.filter((c) => c.workflowKey !== workflowKey);
  return on ? [...rest, { workflowKey, stageId: '*' }] : rest;
}

/** Claims that point at no step of the listed workflows (old free-text claims, deleted steps). */
export function unknownClaims(claims: readonly Claim[], workflows: readonly ClaimableWorkflow[]): Claim[] {
  return claims.filter((c) => {
    const wf = workflows.find((w) => w.key === c.workflowKey);
    if (!wf) return true;
    if (c.stageId === '*') return false;
    // A prefix claim (`triage*`) is fine when it matches a step.
    if (c.stageId.endsWith('*')) return !wf.steps.some((s) => s.id.startsWith(c.stageId.slice(0, -1)));
    return !wf.steps.some((s) => s.id === c.stageId);
  });
}

/** A short name for a role from its display name: lowercase letters, digits and dashes, starting with a letter. */
export function keyFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '');
}

export const KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Runtimes and models offered in the model picker; a value outside the list is kept and shown as it is. */
export const RUNTIME_OPTIONS = [{ id: 'claude-code', label: 'Claude Code' }] as const;
export const MODEL_OPTIONS = [
  { id: 'haiku', label: 'Haiku: fastest and cheapest, for simple routine steps' },
  { id: 'sonnet', label: 'Sonnet: balanced, a good default' },
  { id: 'opus', label: 'Opus: most capable and most expensive, for hard steps' },
] as const;
export const EFFORT_OPTIONS = [
  { id: '', label: 'Default' },
  { id: 'low', label: 'Low: quick answers, lowest cost' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High: thinks longer, costs more' },
] as const;
