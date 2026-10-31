import { type BriefPlaybook, BUSINESS_DUE_FIELDS, type BusinessCardType } from '@aom/shared';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';

const DAY = 86_400_000;
const LINES_MAX = 15;
const CONTEXT_MAX = 12_000;

const ymdIn = (at: Date, tz: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at);

/** "Fri 31 Oct 07:00 (Africa/Johannesburg)" */
function stamp(at: Date, tz: string): string {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  return `${f.replace(',', '')} (${tz})`;
}

/**
 * The period of a brief: from the last run of the schedule that made a card (at most `periodDays` back, plus two days
 * for a plan that follows a weekend) to `now`, and never less than one day.
 */
export async function briefPeriod(
  db: Queryable,
  a: { scheduleId: string; playbook: BriefPlaybook | undefined; now: Date },
): Promise<{ from: Date; to: Date }> {
  const last = await one(
    db,
    `SELECT started_at FROM schedule_runs
      WHERE schedule_id=$1 AND status='ok' AND jsonb_array_length(COALESCE(result->'cardIds','[]'::jsonb)) > 0
      ORDER BY started_at DESC LIMIT 1`,
    [a.scheduleId],
  );
  const days = a.playbook?.periodDays ?? 7;
  const maxBack = new Date(a.now.getTime() - (days + (days === 1 ? 2 : 0)) * DAY);
  const minBack = new Date(a.now.getTime() - DAY);
  let from = last ? new Date(last.started_at as Date) : new Date(a.now.getTime() - days * DAY);
  if (from < maxBack) from = maxBack;
  if (from > minBack) from = minBack;
  return { from, to: a.now };
}

interface Line {
  text: string;
}

const cardLine = (r: Row, origin: string, extra = ''): Line => ({
  text: `- ${r.ref} ${r.title} (${r.card_type}, ${r.status}/${r.stage}${extra}): ${origin}/cards/${r.ref}`,
});

function section(title: string, lines: Line[]): { title: string; lines: Line[] } {
  return { title, lines: lines.slice(0, LINES_MAX) };
}

/**
 * The snapshot of what changed, written into the card's `context` at run time. It reads only the organization's own
 * cards (of the schedule's project), rules and decisions, and manager desk titles, with links for every item.
 */
export async function buildBriefContext(
  db: Queryable,
  a: {
    orgId: string;
    projectId: string;
    scheduleId: string;
    playbook: BriefPlaybook | undefined;
    now: Date;
    timezone: string;
    origin: string;
  },
): Promise<{ context: string; period: string }> {
  const { from, to } = await briefPeriod(db, a);
  const today = ymdIn(a.now, a.timezone);
  const origin = a.origin.replace(/\/$/, '');
  const own = 'AND schedule_id IS DISTINCT FROM $2::uuid';

  const open = await rows(
    db,
    `SELECT ref, title, card_type, status, stage, fields, priority, created_at FROM cards
      WHERE project_id=$1 AND status NOT IN ('done','cancelled','draft') ${own}
      ORDER BY priority, created_at`,
    [a.projectId, a.scheduleId],
  );
  const due: Line[] = [];
  const overdue: Line[] = [];
  for (const r of open) {
    const key = BUSINESS_DUE_FIELDS[r.card_type as BusinessCardType];
    const raw = key ? (r.fields as Record<string, unknown>)?.[key] : undefined;
    const date = typeof raw === 'string' ? raw.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (date === today) due.push(cardLine(r, origin, `, due ${date}`));
    else if (date < today) {
      const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY);
      overdue.push({ text: `${cardLine(r, origin, `, due ${date}`).text} [overdue ${days} d]` });
    }
  }
  const priorities = open.slice(0, LINES_MAX).map((r) => cardLine(r, origin));

  const done = (
    await rows(
      db,
      `SELECT ref, title, card_type, status, stage FROM cards
        WHERE project_id=$1 AND status='done' AND finalized_at >= $3 AND finalized_at <= $4 ${own}
        ORDER BY finalized_at DESC`,
      [a.projectId, a.scheduleId, from, to],
    )
  ).map((r) => cardLine(r, origin));

  const blocked = (
    await rows(
      db,
      `SELECT ref, title, card_type, status, stage,
              extract(epoch FROM ($3::timestamptz - COALESCE(blocked_since, updated_at))) / 86400.0 AS days
         FROM cards WHERE project_id=$1 AND status='blocked' ${own}
        ORDER BY COALESCE(blocked_since, updated_at)`,
      [a.projectId, a.scheduleId, a.now],
    )
  ).map((r) => cardLine(r, origin, `, blocked ${Math.max(0, Math.floor(Number(r.days)))} d`));

  const created = (
    await rows(
      db,
      `SELECT ref, title, card_type, status, stage FROM cards
        WHERE project_id=$1 AND created_at >= $3 AND created_at <= $4 AND status <> 'draft' ${own}
        ORDER BY created_at DESC`,
      [a.projectId, a.scheduleId, from, to],
    )
  ).map((r) => cardLine(r, origin));

  const rules: Line[] = (
    await rows(
      db,
      `SELECT id, title, scope FROM ledger_entries
        WHERE org_id=$1 AND (project_id IS NULL OR project_id=$2) AND superseded_by IS NULL AND retired_at IS NULL
          AND created_at >= $3 AND created_at <= $4
        ORDER BY created_at DESC`,
      [a.orgId, a.projectId, from, to],
    )
  ).map((r) => ({
    text: `- [rule ${String(r.id).slice(0, 8)}] ${r.title}: ${origin}/ledger?entry=${r.id}`,
  }));

  const owner: Line[] = (
    await rows(
      db,
      `SELECT d.title FROM desk_items d
        WHERE d.org_id=$1 AND d.status='open' AND d.routed_to='manager' AND d.kind <> 'rating'
          AND (d.project_id IS NULL OR d.project_id=$2)
        ORDER BY d.created_at LIMIT ${LINES_MAX}`,
      [a.orgId, a.projectId],
    )
  ).map((r) => ({ text: `- ${r.title}` }));

  const secs = [
    section('Due today', due),
    section('Overdue', overdue),
    section('Priorities', priorities),
    section('Done in the period', done),
    section('Stuck', blocked),
    section('New in the period', created),
    section('Decisions and rules in the period', rules),
    section('Needs the owner', owner),
  ];
  const render = () =>
    [
      ...secs.map((s) => `## ${s.title}\n${s.lines.length ? s.lines.map((l) => l.text).join('\n') : 'none'}`),
      'Knowledge notes: check your knowledge folder for notes changed in this period.',
    ].join('\n\n');
  let context = render();
  // Over the cap: drop lines from the end of the longest list first.
  while (context.length > CONTEXT_MAX) {
    const longest = secs.reduce((m, s) => (s.lines.length > m.lines.length ? s : m));
    if (!longest.lines.length) break;
    longest.lines.pop();
    context = render();
  }
  if (context.length > CONTEXT_MAX) context = context.slice(0, CONTEXT_MAX);
  return { context, period: `since ${stamp(from, a.timezone)}` };
}
