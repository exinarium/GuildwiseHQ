import {
  itemConfidence,
  type ProposalConfidence,
  type ProposalEvidence,
  type RunPlan,
  type RunService,
  type RunSetupStep,
  type SetupProposal,
} from '@aom/shared';

/**
 * The guided editor works on a list of entries (one per setup step or part of the app) instead of the plan itself, so each
 * card keeps its identity while it is edited, moved or removed, and a scan can mark what DevOps found, guessed or could not
 * tell (docs/design/deploy-run-ux-design.md sections 3.1 and 5). `entriesToPlan` turns the list back into the same
 * `RunPlan` the runner replays.
 */

export type PlanEntry =
  | { key: string; kind: 'step'; item: RunSetupStep; review?: EntryReview }
  | { key: string; kind: 'service'; item: RunService; review?: EntryReview };

export interface EntryReview {
  confidence: ProposalConfidence;
  /** DevOps's remarks about this part, in its own words. */
  notes: string[];
  evidence: ProposalEvidence[];
  /** The person looked at it (edited it, or said it looks right). */
  confirmed: boolean;
}

let counter = 0;
export const newKey = (): string => `e${++counter}`;

const baseOf = (kind: 'step' | 'service', i: number) => (kind === 'step' ? `/setup/${i}` : `/services/${i}`);

function reviewOf(
  proposal: SetupProposal | undefined,
  kind: 'step' | 'service',
  i: number,
): EntryReview | undefined {
  if (!proposal) return undefined;
  const base = baseOf(kind, i);
  const confidence = itemConfidence(proposal, base);
  const mine = proposal.items.filter((it) => it.path === base || it.path.startsWith(`${base}/`));
  return {
    // An item DevOps said nothing about is a guess: it is not marked "found" without a source.
    confidence: confidence ?? 'guessed',
    notes: mine.map((it) => it.note).filter((n): n is string => !!n),
    evidence: mine.flatMap((it) => it.evidence ?? []),
    confirmed: confidence === 'found',
  };
}

export function planToEntries(plan: RunPlan, proposal?: SetupProposal): PlanEntry[] {
  return [
    ...plan.setup.map((item, i): PlanEntry => {
      const review = reviewOf(proposal, 'step', i);
      return { key: newKey(), kind: 'step', item, ...(review ? { review } : {}) };
    }),
    ...plan.services.map((item, i): PlanEntry => {
      const review = reviewOf(proposal, 'service', i);
      return { key: newKey(), kind: 'service', item, ...(review ? { review } : {}) };
    }),
  ];
}

export function entriesToPlan(base: Pick<RunPlan, 'repos' | 'notes'>, entries: PlanEntry[]): RunPlan {
  const setup = entries
    .filter((e): e is Extract<PlanEntry, { kind: 'step' }> => e.kind === 'step')
    .map((e) => e.item);
  const services = entries
    .filter((e): e is Extract<PlanEntry, { kind: 'service' }> => e.kind === 'service')
    .map((e) => e.item);
  const repoIds = [...new Set([...setup, ...services].map((x) => x.repoId))];
  return {
    version: 1,
    repos: repoIds.map((repoId) => base.repos.find((r) => r.repoId === repoId) ?? { repoId }),
    setup,
    services,
    notes: base.notes,
  };
}

/** Moves the entry one place within its own section (steps with steps, parts with parts). */
export function moveEntry(entries: PlanEntry[], key: string, dir: -1 | 1): PlanEntry[] {
  const i = entries.findIndex((e) => e.key === key);
  const entry = entries[i];
  if (!entry) return entries;
  let j = i + dir;
  while (entries[j] && entries[j]?.kind !== entry.kind) j += dir;
  if (!entries[j]) return entries;
  const next = [...entries];
  next[i] = entries[j] as PlanEntry;
  next[j] = entry;
  return next;
}

/** How many entries DevOps could not tell and nobody answered yet: they block "Use these steps". */
export const unansweredCount = (entries: PlanEntry[]): number =>
  entries.filter((e) => e.review?.confidence === 'unknown' && !e.review.confirmed).length;
