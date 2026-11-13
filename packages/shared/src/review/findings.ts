import { z } from 'zod';

/**
 * How many findings of one review are posted to the pull request: one per 100 changed lines, rounded up, at least 1
 * and at most 5. The rest are held back (stored, shown on request, never posted).
 */
export const FINDINGS_LINES_PER_FINDING = 100;
export const FINDINGS_CAP_MIN = 1;
export const FINDINGS_CAP_MAX = 5;

/** The number of findings to post. An unknown line count (null/undefined) gives the maximum. */
export function findingsCap(changedLines: number | null | undefined): number {
  if (changedLines == null || !Number.isFinite(changedLines)) return FINDINGS_CAP_MAX;
  const n = Math.ceil(Math.max(0, Math.floor(changedLines)) / FINDINGS_LINES_PER_FINDING);
  return Math.min(FINDINGS_CAP_MAX, Math.max(FINDINGS_CAP_MIN, n));
}

export const FindingDispositionSchema = z.enum(['posted', 'held_back']);
export type FindingDisposition = z.infer<typeof FindingDispositionSchema>;

export type FindingSeverity = 'high' | 'medium' | 'low';

const WEIGHT: Record<FindingSeverity, number> = { high: 2, medium: 1, low: 0 };

/** Most important first (severity, then the reviewer's own order), rank 1..n, split at the cap. Pure. */
export function applyFindingsCap<T extends { severity: FindingSeverity }>(
  findings: readonly T[],
  changedLines: number | null | undefined,
): {
  cap: number;
  heldBackCount: number;
  ordered: Array<T & { rank: number; disposition: FindingDisposition }>;
} {
  const cap = findingsCap(changedLines);
  const ordered = findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (WEIGHT[b.f.severity] ?? 0) - (WEIGHT[a.f.severity] ?? 0) || a.i - b.i)
    .map(({ f }, k) => ({
      ...f,
      rank: k + 1,
      disposition: (k < cap ? 'posted' : 'held_back') as FindingDisposition,
    }));
  return { cap, heldBackCount: Math.max(0, ordered.length - cap), ordered };
}

/** Added + removed lines of `git diff --numstat` output; a binary entry ("-\t-\tpath") counts 0. */
export function changedLinesFromNumstat(numstat: string): number {
  let total = 0;
  for (const line of numstat.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    total += (m[1] === '-' ? 0 : Number(m[1])) + (m[2] === '-' ? 0 : Number(m[2]));
  }
  return total;
}

/** Model output: an unknown or missing severity is `low`; `critical`/`blocker` are `high`. Never drops a finding. */
export function normaliseSeverity(v: unknown): FindingSeverity {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s === 'high' || s === 'critical' || s === 'blocker') return 'high';
  if (s === 'medium') return 'medium';
  return 'low';
}

/** One held-back finding as the owner sees it on request. No reviewer name (blind marking). */
export const HeldBackFindingDtoSchema = z.object({
  id: z.uuid(),
  rank: z.number().int().positive().nullable(),
  severity: z.enum(['high', 'medium', 'low']),
  path: z.string(),
  line: z.number().int().positive().nullable(),
  title: z.string(),
  body: z.string(),
});
export type HeldBackFindingDto = z.infer<typeof HeldBackFindingDtoSchema>;

export const HeldBackFindingsResponseSchema = z.object({
  runId: z.uuid().nullable(),
  findings: z.array(HeldBackFindingDtoSchema),
});
export type HeldBackFindingsResponse = z.infer<typeof HeldBackFindingsResponseSchema>;
