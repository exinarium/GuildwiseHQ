import type { FindingSeverity } from './findings.ts';
import type { PrReviewer } from './pr-review.ts';

/**
 * Merging the findings of the two reviewers of one review round into one list (GWP-204). Pure and deterministic: no
 * model call. Two findings of different reviewers are the same issue when they are about the same file and the same
 * line, or about lines a few apart with similar titles.
 */

/** Findings this many lines apart (or fewer) in one file may be the same issue when their titles are similar. */
export const DUPLICATE_LINE_WINDOW = 5;
/** Share of title words in common (|A ∩ B| / |A ∪ B|) that two findings a few lines apart need. */
export const DUPLICATE_TITLE_SIMILARITY = 0.3;
/** The same, for two findings that are both about the file and not about a line. */
export const DUPLICATE_FILE_TITLE_SIMILARITY = 0.5;

export interface MergeInput {
  id: string;
  reviewer: PrReviewer;
  /** Position in its run's list (the run's own order). */
  idx: number;
  path: string;
  line: number | null;
  severity: FindingSeverity;
  anchored: boolean;
  title: string;
  body: string;
}

export interface MergedFinding<T extends MergeInput> {
  /** The row that is posted (its text) and marked. */
  canonical: T;
  /** Rows of the other run that say the same; stored with `merged_into = canonical.id`. */
  duplicates: T[];
  /** Every reviewer that produced it, in reviewer order. */
  reviewers: PrReviewer[];
  /** The highest severity of the canonical row and its duplicates. */
  severity: FindingSeverity;
}

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'not',
  'are',
  'can',
  'may',
  'does',
  'from',
]);
const WEIGHT: Record<FindingSeverity, number> = { high: 2, medium: 1, low: 0 };
const REVIEWER_ORDER: PrReviewer[] = ['first', 'second'];

const normPath = (p: string): string => p.replace(/^(\.\/)+/, '').replace(/^\/+/, '');

export function findingTitleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOP.has(t)),
  );
}

/** |A ∩ B| / |A ∪ B| of the title words; 0 when both are empty. */
export function titleSimilarity(a: string, b: string): number {
  const x = findingTitleTokens(a);
  const y = findingTitleTokens(b);
  if (x.size === 0 && y.size === 0) return 0;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both);
}

export function isDuplicate(a: MergeInput, b: MergeInput): boolean {
  if (a.reviewer === b.reviewer || normPath(a.path) !== normPath(b.path)) return false;
  if (a.line !== null && b.line !== null) {
    if (a.line === b.line) return true;
    return (
      Math.abs(a.line - b.line) <= DUPLICATE_LINE_WINDOW &&
      titleSimilarity(a.title, b.title) >= DUPLICATE_TITLE_SIMILARITY
    );
  }
  if (a.line === null && b.line === null)
    return titleSimilarity(a.title, b.title) >= DUPLICATE_FILE_TITLE_SIMILARITY;
  return false; // one is about a line, the other about the file: kept apart
}

const reviewerRank = (r: PrReviewer): number => {
  const i = REVIEWER_ORDER.indexOf(r);
  return i < 0 ? REVIEWER_ORDER.length : i;
};

/** The canonical row of a pair: higher severity; then anchored; then lower idx; then the first reviewer. */
function pickCanonical<T extends MergeInput>(a: T, b: T): T {
  if (WEIGHT[a.severity] !== WEIGHT[b.severity]) return WEIGHT[a.severity] > WEIGHT[b.severity] ? a : b;
  if (a.anchored !== b.anchored) return a.anchored ? a : b;
  if (a.idx !== b.idx) return a.idx < b.idx ? a : b;
  return reviewerRank(a.reviewer) <= reviewerRank(b.reviewer) ? a : b;
}

/**
 * Merges one round's runs into one list, ready for `applyFindingsCap` (which sorts stably by severity). One-to-one:
 * every duplicate pair is scored (same line first, then higher title similarity, then a smaller distance, then a lower
 * idx sum, then the ids) and taken greedily, so no finding is matched twice. Never within one run. Order of the result:
 * found by both first; then the best relative position in its run; then the first reviewer; then the id. With one run
 * the findings come back unchanged, in idx order. Inputs are not mutated.
 */
export function mergeFindings<T extends MergeInput>(
  runs: ReadonlyArray<ReadonlyArray<T>>,
): MergedFinding<T>[] {
  const lengths = new Map<T, number>();
  for (const run of runs) for (const f of run) lengths.set(f, Math.max(1, run.length));
  const all = runs.flatMap((r) => [...r]);

  const pairs: Array<{ a: T; b: T; same: boolean; sim: number; dist: number; sum: number }> = [];
  for (let i = 0; i < runs.length; i++)
    for (let j = i + 1; j < runs.length; j++)
      for (const a of runs[i] ?? [])
        for (const b of runs[j] ?? [])
          if (isDuplicate(a, b))
            pairs.push({
              a,
              b,
              same: a.line !== null && a.line === b.line,
              sim: titleSimilarity(a.title, b.title),
              dist: a.line !== null && b.line !== null ? Math.abs(a.line - b.line) : 0,
              sum: a.idx + b.idx,
            });
  pairs.sort(
    (p, q) =>
      Number(q.same) - Number(p.same) ||
      q.sim - p.sim ||
      p.dist - q.dist ||
      p.sum - q.sum ||
      (p.a.id + p.b.id < q.a.id + q.b.id ? -1 : p.a.id + p.b.id > q.a.id + q.b.id ? 1 : 0),
  );

  const used = new Set<T>();
  const groups: MergedFinding<T>[] = [];
  for (const p of pairs) {
    if (used.has(p.a) || used.has(p.b)) continue;
    used.add(p.a);
    used.add(p.b);
    const canonical = pickCanonical(p.a, p.b);
    const other = canonical === p.a ? p.b : p.a;
    groups.push({
      canonical,
      duplicates: [other],
      reviewers: [...new Set([canonical.reviewer, other.reviewer])].sort(
        (x, y) => reviewerRank(x) - reviewerRank(y),
      ),
      severity: WEIGHT[canonical.severity] >= WEIGHT[other.severity] ? canonical.severity : other.severity,
    });
  }
  for (const f of all)
    if (!used.has(f))
      groups.push({ canonical: f, duplicates: [], reviewers: [f.reviewer], severity: f.severity });

  const position = (g: MergedFinding<T>) => g.canonical.idx / (lengths.get(g.canonical) ?? 1);
  return groups.sort(
    (g, h) =>
      h.duplicates.length - g.duplicates.length ||
      position(g) - position(h) ||
      reviewerRank(g.canonical.reviewer) - reviewerRank(h.canonical.reviewer) ||
      (g.canonical.id < h.canonical.id ? -1 : g.canonical.id > h.canonical.id ? 1 : 0),
  );
}
