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

const KIND_LABEL: Record<string, string> = {
  question: 'Question',
  approval: 'Approval',
  escalation: 'Escalation',
  alert: 'Alert',
  rating: 'Rating',
};

/** Specific labels, keyed by subkind (the more specific the better: a `devops` approval is a "DevOps approval"). */
const SUBKIND_LABEL: Record<string, string> = {
  devops: 'DevOps approval',
  digest: 'Digest to rate',
  outbound: 'Outbound update',
  outbound_failed: 'Posting failed',
  unmapped_ticket: 'Unmapped ticket',
  definition: 'Role or workflow',
  large_merge: 'Merge approval',
  repo_create: 'Create repository',
  repo_create_failed: 'Repository not created',
  budget_warning: 'Budget warning',
  budget_paused: 'Budget paused',
  tester_bottleneck: 'Tester bottleneck',
  test_environment: 'Test environment',
  bug_reported: 'Bug reported',
  finalize_failed: 'Finalize failed',
  pr_notice: 'Pull request notice',
  taste_rule: 'Taste rule',
  standing_order: 'Standing order',
  schedule_failed: 'Schedule failed',
  vault_conflict: 'Vault conflict',
  phase_proposal: 'Phase proposal',
  phase_done: 'Phase done',
  phase_results: 'Phase results',
  ba_report: 'BA report',
  floor_report: 'Floor report',
  loop_backoff: 'Card keeps failing',
  working_branch: 'Working branch',
  main_merge_skipped: 'Main not merged',
  no_architect: 'No architect hired',
  ceo_recommendation: 'CEO recommendation',
  ceo_report: 'CEO report',
  ceo_notice: 'CEO notice',
  ledger_conflict: 'Ledger conflict',
  worktree_rejections: 'Card keeps being rejected',
};

const titleCase = (raw: string) => {
  const t = raw.replaceAll('_', ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
};

/** The human label of a desk item's kind: shown on the badge in the list and in the item detail. */
export function deskKindLabel(item: Pick<DeskItemDto, 'kind' | 'subkind'>): string {
  if (item.subkind && SUBKIND_LABEL[item.subkind]) return SUBKIND_LABEL[item.subkind] as string;
  if (item.subkind) return titleCase(item.subkind);
  return KIND_LABEL[item.kind] ?? titleCase(item.kind);
}
