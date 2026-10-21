import { BACKLOG_PRIORITY_LABEL, type BacklogPriority } from '@aom/shared';
import { type Queryable, rows } from '../db/sql.ts';

export interface SuggestionRow {
  id: string;
  projectKey: string;
  title: string;
  priority: BacklogPriority;
  agentName: string;
  cardRef: string | null;
}

/** Agent suggestions no daily report has listed yet (the marker is `BacklogSuggestionsReported`), oldest first. */
export async function unreportedSuggestions(
  db: Queryable,
  orgId: string,
  limit = 50,
): Promise<{ rows: SuggestionRow[]; more: number }> {
  const found = await rows(
    db,
    `SELECT b.id, b.title, b.priority, b.source_agent_name, b.source_card_ref, p.key
       FROM backlog_items b JOIN projects p ON p.id = b.project_id
      WHERE b.org_id=$1 AND b.source_kind='agent' AND b.reported_at IS NULL
      ORDER BY b.created_at, b.id LIMIT $2`,
    [orgId, limit + 1],
  );
  return {
    rows: found.slice(0, limit).map((r) => ({
      id: r.id,
      projectKey: r.key,
      title: r.title,
      priority: r.priority,
      agentName: r.source_agent_name ?? 'An agent',
      cardRef: r.source_card_ref ?? null,
    })),
    more: Math.max(0, found.length - limit),
  };
}

/** The notice section of the daily report; no lines at all when there are no new suggestions. */
export function backlogNoticeLines(found: SuggestionRow[], more: number): string[] {
  if (found.length === 0) return [];
  return [
    '',
    '## New backlog suggestions from agents',
    ...found.map(
      (s) =>
        `- ${s.projectKey}: ${s.title} (${BACKLOG_PRIORITY_LABEL[s.priority]}), suggested by ${s.agentName}${s.cardRef ? ` on ${s.cardRef}` : ''}`,
    ),
    ...(more > 0 ? [`- and ${more} more on the Backlog pages`] : []),
  ];
}
