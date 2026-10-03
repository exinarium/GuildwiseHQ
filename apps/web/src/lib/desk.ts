import type { DeskItemDto, DeskLedgerChoice } from '@aom/shared';

/**
 * Desk order (docs/ARCHITECTURE.md section 15): pinned first, then blocking, then the number of cards the item holds
 * up, then oldest first. The server already sends items this way; the page re-applies it so live updates and
 * optimistic edits can never reorder the list.
 */
export function sortDeskItems<
  T extends Pick<DeskItemDto, 'pinned' | 'blocking' | 'affectedCount' | 'createdAt'>,
>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      Number(b.blocking) - Number(a.blocking) ||
      b.affectedCount - a.affectedCount ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

/** "Add to ledger as" choices on the answer form. */
export const LEDGER_CHOICES = [
  { key: 'decision', label: 'Decision (project log)', choice: { scope: 'decision' } },
  { key: 'feature', label: 'Requirement (this card)', choice: { scope: 'feature' } },
  { key: 'standing_project', label: 'Standing order (this project)', choice: { scope: 'standing_order' } },
  {
    key: 'standing_org',
    label: 'Standing order (every project)',
    choice: { scope: 'standing_order', orgWide: true },
  },
] as const satisfies ReadonlyArray<{ key: string; label: string; choice: DeskLedgerChoice }>;
export type LedgerChoiceKey = (typeof LEDGER_CHOICES)[number]['key'];

export const choiceFor = (key: LedgerChoiceKey): DeskLedgerChoice =>
  (LEDGER_CHOICES.find((c) => c.key === key)?.choice ?? { scope: 'decision' }) as DeskLedgerChoice;

/** The answer text sent: what the manager typed, else the label of the chosen option. */
export function answerText(
  typed: string,
  optionId: string | null,
  options: ReadonlyArray<{ id: string; label: string }>,
): string {
  const t = typed.trim();
  if (t) return t;
  return options.find((o) => o.id === optionId)?.label ?? '';
}

/** The option preselected on the form: the agent's recommendation when it gave one. */
export const defaultOption = (item: Pick<DeskItemDto, 'recommendation' | 'options'>): string | null =>
  item.recommendation && item.options.some((o) => o.id === item.recommendation) ? item.recommendation : null;
