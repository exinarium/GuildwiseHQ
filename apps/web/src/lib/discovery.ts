import type { DiscoveryProposalDto, DiscoveryStateDto, QuestionDto, ThreadMessageDto } from '@aom/shared';

export const formatUsd = (n: number): string => `$${n < 10 ? n.toFixed(2) : n.toFixed(n < 100 ? 1 : 0)}`;

export const STANCE_LABEL = {
  facilitator: 'Facilitator',
  partner: 'Partner',
  ideate_for_me: 'Ideate for me',
} as const;
export const STANCE_HELP = {
  facilitator: 'The analyst asks, you answer. It never fills in your answers.',
  partner: 'The analyst also brings ideas and opinions of its own, labelled as its own.',
  ideate_for_me: 'The analyst puts concrete ideas and drafts on the table; you choose.',
} as const;
export const CEO_MODE_LABEL = {
  owner_only: 'Just me',
  joint: 'With the CEO',
  ceo_prep: 'CEO prepares first',
} as const;
export const CEO_MODE_HELP = {
  owner_only: 'You answer every question.',
  joint: 'After each question the CEO proposes an answer. You confirm, edit or override it.',
  ceo_prep: 'The CEO and the analyst run the questions first; you then review every answer.',
} as const;
export const PLAYBOOK_LABEL = {
  brainstorm: 'Brainstorm ideas',
  'advanced-elicitation': 'Stress-test an idea',
  'product-brief': 'Write a product brief',
  prd: 'Write a PRD',
} as const;

/** What the page tells the owner about whose turn it is. */
export function waitingText(
  s: Pick<DiscoveryStateDto, 'waitingFor' | 'facilitatorName' | 'ceoName'>,
): string {
  switch (s.waitingFor) {
    case 'owner':
      return 'Your turn';
    case 'facilitator':
      return `${s.facilitatorName} is working`;
    case 'ceo':
      return `${s.ceoName ?? 'The CEO'} is working on a proposed answer`;
    case 'review':
      return "Review the CEO's answers";
    case 'paused':
      return 'Paused';
    case 'budget':
      return 'Stopped: budget used up';
    case 'time':
      return 'Time is up: waiting for the creator';
    default:
      return 'Waiting for your message';
  }
}

/** The answer of a question in words (the option label and/or the text), or what happened to it. */
export function answerText(q: QuestionDto): string {
  const a = q.answer;
  if (!a) return '';
  if (a.kind === 'skip') return 'Skipped';
  if (a.kind === 'park') return 'Parked for later';
  const label = a.optionId ? q.options.find((o) => o.id === a.optionId)?.label : undefined;
  return [label, a.text].filter(Boolean).join(': ');
}

export const SOURCE_LABEL = {
  owner: '',
  ceo_confirmed: "CEO's proposal, confirmed by you",
  ceo_edited: "CEO's proposal, edited by you",
  owner_override: 'You answered instead of the CEO',
} as const;

export type TimelineItem =
  | { kind: 'message'; at: string; key: string; message: ThreadMessageDto }
  | { kind: 'question'; at: string; key: string; question: QuestionDto }
  | { kind: 'proposal'; at: string; key: string; proposal: DiscoveryProposalDto };

const ORDER = { message: 0, question: 1, proposal: 2 } as const;

/** Messages, question cards and proposals in the order they happened. */
export function buildTimeline(
  messages: readonly ThreadMessageDto[],
  questions: readonly QuestionDto[],
  proposals: readonly DiscoveryProposalDto[],
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...messages.map((m) => ({ kind: 'message' as const, at: m.createdAt, key: `m-${m.id}`, message: m })),
    // withdrawn questions were replaced before the owner could answer them: they are noise
    ...questions
      .filter((q) => q.status !== 'withdrawn')
      .map((q) => ({ kind: 'question' as const, at: q.askedAt, key: `q-${q.id}`, question: q })),
    ...proposals.map((p) => ({ kind: 'proposal' as const, at: p.createdAt, key: `p-${p.id}`, proposal: p })),
  ];
  return items.sort(
    (a, b) => a.at.localeCompare(b.at) || ORDER[a.kind] - ORDER[b.kind] || a.key.localeCompare(b.key),
  );
}

/** Questions the CEO answered in the pre-draft that the owner has not reviewed yet. */
export const questionsToReview = (qs: readonly QuestionDto[]): QuestionDto[] =>
  qs.filter((q) => q.status === 'proposed');
