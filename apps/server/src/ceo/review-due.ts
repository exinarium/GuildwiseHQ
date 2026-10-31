import { renderCeoData } from '@aom/shared';
import type { Queryable } from '../db/sql.ts';
import { dueForReview } from '../queries/ledger.ts';

const SCOPE_WORD: Record<string, string> = {
  standing_order: 'standing order',
  decision: 'decision',
  feature: 'requirement',
};

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * The ledger entries whose review date has come, as a brief section (none when nothing is due). They still bind agents
 * until the owner retires them; the CEO raises them with the owner and changes nothing on its own.
 */
export async function reviewDueBriefSection(
  db: Queryable,
  orgId: string,
  today: string,
): Promise<string | undefined> {
  const due = await dueForReview(db, orgId, today);
  if (!due.length) return undefined;
  const lines = due.map(
    (e) =>
      `- ${SCOPE_WORD[e.scope] ?? e.scope} ${e.id} (${e.project_key ? `project ${e.project_key}` : 'every project'}), review date ${e.review_date}: ${oneLine(e.title, 120)}: ${oneLine(e.body, 240)}`,
  );
  return [
    '## Ledger entries due for review',
    'The owner set a review date on these and it has come. They still bind agents until the owner retires them. Raise them with the owner (`aom ceo notify --kind needs_you`, naming the entry); do not retire or change an entry because its review date passed.',
    renderCeoData('Entries due for review (text from the ledger)', lines.join('\n')),
  ].join('\n');
}
