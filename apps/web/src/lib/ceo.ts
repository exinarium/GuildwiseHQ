import { ACTION_CLASSES, CLASS_LABEL } from '@aom/shared';

/** The plain-words label of an action class (unknown classes fall back to the key). */
export const classLabel = (c: string): string => (CLASS_LABEL as Record<string, string>)[c] ?? c;

/** Where a memory came from, in the owner's words. */
export const MEMORY_SOURCE_LABEL: Record<string, string> = {
  owner_statement: 'you said',
  owner_desk_answer: 'your desk answer',
  owner_override: 'your override',
  owner_undo: 'you undid an action',
  owner_edit: 'you edited it',
  owner_training: 'learned from your choices',
};
export const memorySourceLabel = (s: string): string => MEMORY_SOURCE_LABEL[s] ?? s;

export const MEMORY_KIND_LABEL: Record<string, string> = {
  rule: 'Rules',
  preference: 'Preferences',
  decision_pattern: 'Decision patterns',
  fact: 'Facts',
  correction: 'Corrections',
};

export const MODE_LABEL = { decided: 'Decided', recommended: 'Recommended', refused: 'Refused' } as const;

/** `agreed 18 of 23 recommendations` */
export const agreementText = (agreed: number, total: number): string =>
  `agreed ${agreed} of ${total} recommendation${total === 1 ? '' : 's'}`;

export const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** A micro-unit amount from a decimal text in the organization's currency (empty: 0). */
export const toMicros = (text: string): number => {
  const n = Number(text.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1_000_000) : 0;
};
export const fromMicros = (micros: number): string => (micros ? String(micros / 1_000_000) : '');

export { ACTION_CLASSES };
