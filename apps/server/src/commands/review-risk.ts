import { QA_FOCUS_MAX, type ReviewRiskDto, RISK_ANALYSIS_MAX, type StoredReviewRisk } from '@aom/shared';
import type { Row } from '../db/sql.ts';

/** The reviewer's risk call stored on the card (`cards.review_risk`, backlog #70). */
export interface StoredRisk {
  level: StoredReviewRisk;
  analysis: string;
  qaFocus: string;
}

const RANK: Record<StoredReviewRisk, number> = { unknown: 0, low: 1, medium: 2, high: 3 };

export const SEPARATOR = '\n\n---\n\n';

/** Folds one more approval into the round's risk: the highest level wins, the texts are kept in order. */
export function mergeRisk(
  existing: StoredRisk | null | undefined,
  next: { risk?: StoredReviewRisk; riskAnalysis?: string; qaFocus?: string },
): StoredRisk {
  const level = next.risk ?? 'unknown';
  const analysis = (next.riskAnalysis ?? '').trim();
  const qaFocus = (next.qaFocus ?? '').trim();
  if (!existing) return { level, analysis, qaFocus };
  const join = (a: string, b: string, max: number) =>
    (a && b && a !== b ? `${a}${SEPARATOR}${b}` : a || b).slice(0, max);
  return {
    level: RANK[level] > RANK[existing.level] ? level : existing.level,
    analysis: join(existing.analysis, analysis, RISK_ANALYSIS_MAX * 2),
    qaFocus: join(existing.qaFocus, qaFocus, QA_FOCUS_MAX * 2),
  };
}

/** The risk fields of a review report's data for the event; a report without them (an older runner) is `unknown`. */
export function riskFields(data: Record<string, any>): {
  risk: StoredReviewRisk;
  riskAnalysis: string;
  qaFocus: string;
} {
  const risk = ['low', 'medium', 'high'].includes(data.risk) ? (data.risk as StoredReviewRisk) : 'unknown';
  return {
    risk,
    riskAnalysis: typeof data.riskAnalysis === 'string' ? data.riskAnalysis.slice(0, RISK_ANALYSIS_MAX) : '',
    qaFocus: typeof data.qaFocus === 'string' ? data.qaFocus.slice(0, QA_FOCUS_MAX) : '',
  };
}

export const riskOf = (card: Row): StoredRisk | null => {
  const r = (card.review_risk as StoredRisk | null) ?? null;
  return r && (r.level !== 'unknown' || r.analysis) ? r : null;
};

/** A high risk always sends the merge to the manager, whatever the project's "merge large changes" setting says. */
export const isHighRisk = (card: Row): boolean => riskOf(card)?.level === 'high';

export const HIGH_RISK_MERGE_REASON =
  'the reviewer rated the change HIGH risk, so the merge needs the manager approval (the project setting that waives approval of large merges does not apply)';

export function reviewRiskDto(card: Row): ReviewRiskDto | null {
  const r = riskOf(card);
  if (!r) return null;
  return {
    level: r.level,
    analysis: r.analysis,
    qaFocus: r.qaFocus,
    mergeApprovalReason: r.level === 'high' ? HIGH_RISK_MERGE_REASON : null,
  };
}
