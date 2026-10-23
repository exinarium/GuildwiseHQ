import type {
  AnswerQuestionRequest,
  DiscoveryStateDto,
  ResolveDiscoveryProposalRequest,
  ThreadMessageDto,
} from '@aom/shared';
import { Loader2 } from 'lucide-react';
import { useMemo, useRef } from 'react';
import { type ChatSegment, parseSegments } from '../../lib/chatSegments.ts';
import { buildTimeline } from '../../lib/discovery.ts';
import { AgentTurn, UserBubble } from '../chat/AgentTurn.tsx';
import { useStickToBottom } from '../chat/useStickToBottom.ts';
import { ProposalCard } from './ProposalCard.tsx';
import { QuestionCard } from './QuestionCard.tsx';

/** The turn being streamed (text arrives as `chat.delta`); `name` is the speaker of that turn. */
export interface LiveTurn {
  turnId: string | null;
  name: string;
  segments: ChatSegment[];
  startedAt: number;
}

function MessageRow({ m }: { m: ThreadMessageDto }) {
  if (m.authorKind === 'user') return <UserBubble body={m.body} at={m.createdAt} />;
  if (m.authorKind === 'system')
    return (
      <li
        data-testid="session-notice"
        className="self-center rounded-full bg-sunken px-3 py-1 text-center text-xs text-muted [overflow-wrap:anywhere]"
      >
        {m.body}
      </li>
    );
  return (
    <AgentTurn
      name={m.authorName ?? 'Analyst'}
      agentId={m.authorAgentId ?? m.authorPersonaKey ?? null}
      body={m.body}
      segments={parseSegments(m.data)}
      at={m.createdAt}
    />
  );
}

/** Messages, question cards, proposals and the streaming reply, in the order they happened. */
export function DiscoveryConversation({
  state,
  messages,
  live,
  onAnswer,
  onResolve,
  answerBusy,
  answerError,
  resolveBusy,
  resolveError,
}: {
  state: DiscoveryStateDto;
  messages: readonly ThreadMessageDto[];
  live: LiveTurn | null;
  onAnswer: (questionId: string, body: AnswerQuestionRequest) => void;
  onResolve: (proposalId: string, body: ResolveDiscoveryProposalRequest) => void;
  answerBusy: boolean;
  answerError: string | null;
  resolveBusy: boolean;
  resolveError: string | null;
}) {
  const items = useMemo(
    () => buildTimeline(messages, state.questions, state.proposals),
    [messages, state.questions, state.proposals],
  );
  const log = useRef<HTMLDivElement>(null);
  const streamSize = live
    ? live.segments.length + live.segments.reduce((n, s) => n + (s.type === 'text' ? s.text.length : 0), 0)
    : -1;
  useStickToBottom(log, `${items.length}:${streamSize}:${state.busy}`);
  const thinking = state.busy && !live;
  return (
    <div
      ref={log}
      className="min-h-0 flex-1 overflow-y-auto pr-1"
      role="log"
      aria-label="Discovery conversation"
      aria-live="polite"
      data-testid="discovery-log"
    >
      <ol className="flex flex-col gap-3 pb-2">
        {items.length === 0 && !thinking && !live && (
          <li className="py-8 text-center text-sm text-muted">
            The conversation starts when the analyst has its first turn.
          </li>
        )}
        {items.map((it) =>
          it.kind === 'message' ? (
            <MessageRow key={it.key} m={it.message} />
          ) : it.kind === 'question' ? (
            <QuestionCard
              key={it.key}
              q={it.question}
              ceoName={state.ceoName}
              busy={answerBusy}
              error={answerError}
              onAnswer={(b) => onAnswer(it.question.id, b)}
            />
          ) : (
            <ProposalCard
              key={it.key}
              p={it.proposal}
              busy={resolveBusy}
              error={resolveError}
              onResolve={(b) => onResolve(it.proposal.id, b)}
            />
          ),
        )}
        {live && (
          <AgentTurn
            name={live.name}
            body=""
            segments={live.segments}
            live={{ startedAt: live.startedAt }}
            testId="session-live-turn"
          />
        )}
        {thinking && (
          <li
            role="status"
            className="flex items-center gap-2 text-sm text-muted"
            data-testid="session-thinking"
          >
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            {state.waitingFor === 'ceo'
              ? `${state.ceoName ?? 'The CEO'} is thinking…`
              : `${state.facilitatorName} is thinking…`}
          </li>
        )}
      </ol>
    </div>
  );
}
