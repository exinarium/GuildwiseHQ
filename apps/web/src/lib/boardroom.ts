import type {
  BoardCastDto,
  BoardDecisionDto,
  BoardRoundDto,
  BoardStateDto,
  ThreadMessageDto,
} from '@aom/shared';

export { formatUsd } from './discovery.ts';

/** Colour classes per seat (the cast order decides): a left border and a tinted name, readable in light and dark. */
export const SEAT_COLORS = [
  { border: 'border-l-brand', text: 'text-brand-soft-fg', dot: 'bg-brand' },
  { border: 'border-l-success-fill', text: 'text-success', dot: 'bg-success-fill' },
  { border: 'border-l-warning-fill', text: 'text-warning', dot: 'bg-warning-fill' },
  { border: 'border-l-danger-fill', text: 'text-danger', dot: 'bg-danger-fill' },
  { border: 'border-l-info-fill', text: 'text-info', dot: 'bg-info-fill' },
  { border: 'border-l-control', text: 'text-muted', dot: 'bg-control' },
  { border: 'border-l-brand', text: 'text-brand-soft-fg', dot: 'bg-brand' },
  { border: 'border-l-success-fill', text: 'text-success', dot: 'bg-success-fill' },
] as const;
export const seatColor = (index: number) =>
  SEAT_COLORS[((index % 8) + 8) % 8] as (typeof SEAT_COLORS)[number];

/** What the page tells the owner about whose turn it is. */
export function boardWaitingText(s: Pick<BoardStateDto, 'waitingFor' | 'chair' | 'config'>): string {
  switch (s.waitingFor) {
    case 'owner':
      return 'Your turn: interject or let it run';
    case 'speakers':
      return s.config.round === 1 ? 'Everyone is answering on their own' : 'The speakers are answering';
    case 'chair':
      return `${s.chair.displayName} is choosing the next speakers`;
    case 'cast':
      return s.config.stage === 'setup' ? 'Choosing the cast' : 'Waiting for the cast';
    case 'decision':
      return 'The Chair needs your decision';
    case 'minutes':
      return 'Writing the minutes';
    case 'budget':
      return 'Stopped: budget used up';
    case 'paused':
      return 'Paused';
    case 'ended':
      return 'Session over';
    default:
      return 'Waiting';
  }
}

/** Messages the page does not show as speech: the Chair's chatter (its picks are shown as status lines). */
const HIDDEN_PURPOSES = new Set(['board_chair', 'board_cast', 'board_minutes']);

export type BoardTimelineItem =
  | { kind: 'round'; at: string; key: string; round: BoardRoundDto }
  | { kind: 'message'; at: string; key: string; message: ThreadMessageDto }
  | { kind: 'sealed'; at: string; key: string; count: number; total: number }
  | { kind: 'decision'; at: string; key: string; decision: BoardDecisionDto };

const ORDER = { round: 0, message: 1, sealed: 2, decision: 3 } as const;

/**
 * The conversation in the order it happened: round separators (with the Chair's pick), the speakers' messages, the owner's,
 * the system notices, and the decision points. The messages of a sealed round are left out and replaced by one line that
 * counts the answers that are in.
 */
export function buildBoardTimeline(
  messages: readonly ThreadMessageDto[],
  s: BoardStateDto,
): BoardTimelineItem[] {
  const sealed = new Set(s.sealedMessageIds);
  const items: BoardTimelineItem[] = [];
  for (const m of messages) {
    if (sealed.has(m.id)) continue;
    const purpose = (m.data as { purpose?: string } | null)?.purpose;
    if (purpose && HIDDEN_PURPOSES.has(purpose)) continue;
    items.push({ kind: 'message', at: m.createdAt, key: `m-${m.id}`, message: m });
  }
  for (const r of s.rounds) items.push({ kind: 'round', at: r.plannedAt, key: `r-${r.round}`, round: r });
  if (s.sealedProgress && s.rounds[0])
    items.push({
      kind: 'sealed',
      at: s.rounds[0].plannedAt,
      key: 'sealed',
      count: s.sealedProgress.done,
      total: s.sealedProgress.total,
    });
  for (const d of s.decisions) items.push({ kind: 'decision', at: d.askedAt, key: `d-${d.id}`, decision: d });
  return items.sort(
    (a, b) => a.at.localeCompare(b.at) || ORDER[a.kind] - ORDER[b.kind] || a.key.localeCompare(b.key),
  );
}

/** The seat that wrote a message (by persona key or agent id), or null for the owner and the system. */
export function seatOf(m: ThreadMessageDto, cast: readonly BoardCastDto[]): BoardCastDto | null {
  const pid = (m.data as { participantId?: string } | null)?.participantId;
  if (pid) return cast.find((c) => c.participantId === pid) ?? null;
  return cast.find((c) => c.refId === m.authorPersonaKey || c.refId === m.authorAgentId) ?? null;
}

// ------------------------------------------------------------------------------------------------- @mentions

/** The partial `@handle` at the end of the text, if the writer is in the middle of one. */
export function mentionPartial(text: string): string | null {
  const m = /(?:^|[\s(])@([a-z0-9-]*)$/i.exec(text);
  return m ? (m[1] as string).toLowerCase() : null;
}

/** The seats whose handle starts with what was typed after `@` (everyone matches an empty partial). */
export function mentionMatches(
  partial: string,
  cast: readonly BoardCastDto[],
): Array<{ slug: string; name: string }> {
  const all = [
    { slug: 'all', name: 'Everyone' },
    ...cast.map((c) => ({ slug: c.slug, name: c.displayName })),
  ];
  return all.filter((c) => c.slug.startsWith(partial)).slice(0, 6);
}

/** Replaces the partial mention at the end of the text with the full handle and a space. */
export function completeMention(text: string, slug: string): string {
  return text.replace(/@[a-z0-9-]*$/i, `@${slug} `);
}

/** "Next round: about $0.03 (3 speakers)". */
export function estimateText(e: BoardStateDto['estimate']): string {
  const usd = e.usd < 0.01 ? '<$0.01' : `~$${e.usd.toFixed(2)}`;
  return `${usd} for ${e.speakers} speaker${e.speakers === 1 ? '' : 's'}${e.basis === 'default' ? ' (a first guess)' : ''}`;
}
