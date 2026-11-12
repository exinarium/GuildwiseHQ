import { DESIGN_GATE_STAGE } from './builtin/code-v7.ts';
import { isHighRiskPath } from './high-risk.ts';
import type { WorkflowDefinition } from './schema.ts';

/**
 * The design gate (`code` version 7): the rules the server applies at the design hand-off. Pure, so the server, the web
 * app and the tests agree on why a card stops at the gate.
 */

export type DesignGateReason = 'high_risk' | 'card' | 'project' | 'off';

export const DESIGN_GATE_REASONS: readonly DesignGateReason[] = ['high_risk', 'card', 'project', 'off'];

export const DESIGN_GATE_REASON_TEXT: Record<DesignGateReason, string> = {
  high_risk:
    'the design touches high-risk paths (authentication, permissions or secrets, data and migrations, tenancy or billing)',
  card: 'the design gate is switched on for this card',
  project: 'the project asks for the owner approval of every design',
  off: 'the design gate is off and the design touches no high-risk paths',
};

/** Most high-risk paths kept on a decision (the event and the card column). */
export const DESIGN_GATE_MAX_PATHS = 50;

// A path-like token: word characters, dots, dashes, `@`, `*` and at least one `/` between segments.
const PATH_TOKEN = /[A-Za-z0-9_.@*-]+(?:\/[A-Za-z0-9_.@*-]*)+/g;

/** Path-like tokens (at least one `/`) in free text: `apps/server/src/db/x.ts`, `packages/shared/src/orgs/`. */
export function pathsInText(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(PATH_TOKEN)) {
    let token = m[0].replace(/[.,:;)]+$/, '');
    // A URL is not a repository path.
    if (m.index > 0 && text.charAt(m.index - 1) === '/') continue;
    token = token
      .replace(/^\.\/+/, '')
      .replace(/\/\*\*?$/, '/')
      .replace(/\*+/g, 'x');
    if (!token.includes('/') || token.startsWith('/')) continue;
    if (!/[A-Za-z]/.test(token)) continue;
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/** The last segment has no extension: also test the token as a folder. */
function asCandidates(token: string): string[] {
  const trimmed = token.replace(/\/+$/, '');
  const last = trimmed.split('/').pop() ?? '';
  if (token.endsWith('/') || !last.includes('.')) return [trimmed, `${trimmed}/x`];
  return [trimmed];
}

export interface DesignRiskSources {
  affectedAreas?: string | null;
  planningNote?: string | null;
  designSummary?: string | null;
  cardBrief?: string | null;
}

/**
 * High-risk paths a design touches, derived before any code exists: the path tokens of the card's Affected areas, the
 * planner's note, the design summary and the Card Brief. A token without an extension also counts as a folder
 * (`apps/server/src/db` is tested as `apps/server/src/db/x`). Derived from paths, never from a declared risk: a source can
 * only add paths. `isHighRisk` is injectable so a per-project path-to-risk map can replace the built-in rules.
 */
export function designRiskPaths(
  sources: DesignRiskSources,
  isHighRisk: (path: string) => boolean = isHighRiskPath,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const text of [
    sources.affectedAreas,
    sources.planningNote,
    sources.designSummary,
    sources.cardBrief,
  ]) {
    for (const token of pathsInText(text)) {
      const key = token.replace(/\/+$/, '');
      if (seen.has(key)) continue;
      if (asCandidates(token).some((p) => isHighRisk(p))) {
        seen.add(key);
        out.push(key);
        if (out.length >= DESIGN_GATE_MAX_PATHS) return out;
      }
    }
  }
  return out;
}

/** Does the card stop at the design gate, and why? High risk wins over the card switch, the card over the project. */
export function designGateDecision(i: {
  projectGate: boolean;
  cardGate: boolean;
  highRiskPaths: readonly string[];
}): { required: boolean; reason: DesignGateReason } {
  if (i.highRiskPaths.length > 0) return { required: true, reason: 'high_risk' };
  if (i.cardGate) return { required: true, reason: 'card' };
  if (i.projectGate) return { required: true, reason: 'project' };
  return { required: false, reason: 'off' };
}

/** Does the workflow have the design gate stage? */
export const workflowHasDesignGate = (def: Pick<WorkflowDefinition, 'stages'>): boolean =>
  def.stages.some((s) => s.id === DESIGN_GATE_STAGE);
