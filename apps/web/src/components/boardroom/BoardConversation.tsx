import type {
  BoardCastDto,
  BoardDecisionDto,
  BoardRoundDto,
  BoardStateDto,
  ThreadMessageDto,
} from '@aom/shared';
import { Gavel, Loader2, Lock } from 'lucide-react';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import { type BoardTimelineItem, buildBoardTimeline, seatColor, seatOf } from '../../lib/boardroom.ts';
import { type ChatSegment, parseSegments } from '../../lib/chatSegments.ts';
import { UserBubble } from '../chat/AgentTurn.tsx';
import { Markdown } from '../chat/Markdown.tsx';
import { useStickToBottom } from '../chat/useStickToBottom.ts';
import { Avatar, Badge, Button, cx, ErrorBox } from '../ui.tsx';

/** A turn being streamed (text arrives as `chat.delta`); several can run at once outside the sealed first round. */
export interface LiveBoardTurn {
  turnId: string | null;
  name: string;
  participantId: string | null;
  segments: ChatSegment[];
  startedAt: number;
}

const KIND_LABEL = {
  independent: 'Everyone answers on their own',
  discussion: 'Discussion',
  dissent: 'Dissent round',
} as const;

function RoundSeparator({ r, cap }: { r: BoardRoundDto; cap: number }) {
  return (
    <li
      data-testid="round-separator"
      data-round={r.round}
      className="flex flex-col items-center gap-1 pt-2 text-center"
    >
      <div className="flex w-full items-center gap-3 text-xs font-medium text-muted">
        <span className="h-px flex-1 bg-line" />
        <span>
          Round {r.round} of {cap} · {KIND_LABEL[r.kind]}
        </span>
        <span className="h-px flex-1 bg-line" />
      </div>
      {r.source !== 'independent' && (
        <p className="max-w-prose text-xs text-subtle [overflow-wrap:anywhere]" data-testid="chair-picks">
          <Gavel aria-hidden="true" className="mr-1 inline size-3.5 align-text-bottom" />
          Chair picks: {r.speakers.map((s) => s.name).join(', ')}
          {r.reason ? ` — ${r.reason}` : ''}
          {r.source === 'fallback' ? ' (chosen by the server)' : ''}
        </p>
      )}
      {r.instruction && <p className="max-w-prose text-xs text-subtle">Focus: {r.instruction}</p>}
    </li>
  );
}

function SeatTurn({
  name,
  seat,
  body,
  segments,
  at,
  live,
  truncated,
}: {
  name: string;
  seat: BoardCastDto | null;
  body: string;
  segments?: ChatSegment[];
  at?: string;
  live?: boolean;
  truncated?: boolean;
}) {
  const c = seatColor(seat?.index ?? 0);
  const text =
    segments && segments.length
      ? segments
          .filter((s): s is Extract<ChatSegment, { type: 'text' }> => s.type === 'text')
          .map((s) => s.text)
          .join('')
      : body;
  return (
    <li
      data-testid="board-turn"
      data-seat={seat?.slug ?? ''}
      className={cx(
        'flex w-full min-w-0 flex-col gap-1 self-stretch rounded-card border border-line border-l-4 bg-surface px-3 py-2',
        c.border,
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
        <Avatar name={name} size={22} />
        <span className={cx('truncate', c.text)}>{name}</span>
        {seat && (
          <span className="rounded-full bg-sunken px-2 py-px text-[11px] font-normal text-subtle">
            {seat.seat}
          </span>
        )}
        {at && (
          <time className="ml-auto text-[11px] font-normal text-subtle" dateTime={at}>
            {new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </time>
        )}
      </div>
      <div className="min-w-0 text-fg">
        {text.trim() ? (
          <Markdown text={text} />
        ) : live ? (
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin text-muted" />
        ) : null}
        {live && text.trim() && (
          <Loader2 aria-hidden="true" className="mt-1 size-3.5 animate-spin text-muted" />
        )}
        {truncated && <p className="text-xs text-subtle">Cut at the length limit.</p>}
      </div>
    </li>
  );
}

function MessageRow({ m, cast }: { m: ThreadMessageDto; cast: readonly BoardCastDto[] }) {
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
  const seat = seatOf(m, cast);
  return (
    <SeatTurn
      name={m.authorName ?? seat?.displayName ?? 'Participant'}
      seat={seat}
      body={m.body}
      segments={(m.data as { truncated?: boolean } | null)?.truncated ? [] : (parseSegments(m.data) ?? [])}
      at={m.createdAt}
      truncated={!!(m.data as { truncated?: boolean } | null)?.truncated}
    />
  );
}

function SealedRow({ count, total, cast }: { count: number; total: number; cast: readonly BoardCastDto[] }) {
  return (
    <li
      data-testid="sealed-round"
      className="flex flex-col items-center gap-1.5 rounded-card border border-dashed border-control bg-sunken px-4 py-3 text-center"
    >
      <p className="flex items-center gap-2 text-sm font-medium text-fg">
        <Lock aria-hidden="true" className="size-4" />
        {count} of {total} answers are in
      </p>
      <p className="max-w-prose text-xs text-muted">
        Every seat answers without seeing the others. The answers are revealed together once the last one is
        in.
      </p>
      <span className="flex gap-1" aria-hidden="true">
        {cast.slice(0, total).map((c, i) => (
          <span
            key={c.participantId}
            className={cx('size-2 rounded-full', i < count ? seatColor(c.index).dot : 'bg-line')}
          />
        ))}
      </span>
    </li>
  );
}

function DecisionCard({
  d,
  busy,
  error,
  onResolve,
  readOnly,
}: {
  d: BoardDecisionDto;
  readOnly?: boolean;
  busy: boolean;
  error: string | null;
  onResolve: (v: { decisionId: string; answer: string; optionId?: string }) => void;
}) {
  const [text, setText] = useState('');
  const [option, setOption] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!option && !text.trim()) return;
    onResolve({ decisionId: d.id, answer: text.trim(), ...(option ? { optionId: option } : {}) });
  };
  if (d.status !== 'open')
    return (
      <li
        data-testid="decision-card"
        className="flex flex-col gap-1 rounded-card border border-line bg-surface px-3 py-2 text-sm"
      >
        <p className="flex items-center gap-2 font-medium text-fg">
          <Gavel aria-hidden="true" className="size-4 text-muted" />
          {d.question}
        </p>
        {d.status === 'resolved' ? (
          <p className="text-muted">
            You decided: <span className="text-fg">{d.answer}</span>
          </p>
        ) : (
          <p className="text-muted">Withdrawn.</p>
        )}
      </li>
    );
  if (readOnly)
    return (
      <li
        data-testid="decision-card"
        data-open="true"
        className="flex flex-col gap-1 rounded-card border border-warning-fill/60 bg-warning-soft px-3 py-3 text-sm text-warning-soft-fg"
      >
        <p className="flex items-center gap-2 font-semibold">
          <Gavel aria-hidden="true" className="size-4" />
          The Chair needs the creator's decision
        </p>
        <p className="font-medium [overflow-wrap:anywhere]">{d.question}</p>
      </li>
    );
  return (
    <li data-testid="decision-card" data-open="true">
      <form
        onSubmit={submit}
        aria-label="Decision needed"
        className="flex flex-col gap-2 rounded-card border border-warning-fill/60 bg-warning-soft px-3 py-3 text-sm text-warning-soft-fg"
      >
        <p className="flex items-center gap-2 font-semibold">
          <Gavel aria-hidden="true" className="size-4" />
          The Chair needs your decision
        </p>
        <p className="font-medium [overflow-wrap:anywhere]">{d.question}</p>
        {d.options.length > 0 && (
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Options">
            {d.options.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={option === o.id}
                data-testid={`decision-option-${o.id}`}
                onClick={() => setOption(option === o.id ? null : o.id)}
                className={cx(
                  'min-h-9 rounded-full border px-3 text-sm [@media(pointer:coarse)]:min-h-11',
                  option === o.id
                    ? 'border-brand bg-brand text-brand-fg'
                    : 'border-control bg-surface text-fg hover:bg-sunken',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
        <input
          aria-label="Your decision"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={d.options.length ? 'Add a note (optional)' : 'What do you decide?'}
          className="min-h-9 rounded-control border border-control bg-surface px-2 text-sm text-fg"
        />
        <ErrorBox error={error ? new Error(error) : null} />
        <div>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={busy}
            disabled={!option && !text.trim()}
            data-testid="decide"
          >
            Decide
          </Button>
        </div>
      </form>
    </li>
  );
}

/** The group conversation: round separators with the Chair's pick, every seat in its colour, sealed round 1, decision points. */
export function BoardConversation({
  state,
  messages,
  live,
  onResolve,
  resolveBusy,
  resolveError,
  readOnly,
}: {
  state: BoardStateDto;
  messages: readonly ThreadMessageDto[];
  live: LiveBoardTurn[];
  onResolve: (v: { decisionId: string; answer: string; optionId?: string }) => void;
  resolveBusy: boolean;
  resolveError: string | null;
  readOnly?: boolean;
}) {
  const items: BoardTimelineItem[] = useMemo(() => buildBoardTimeline(messages, state), [messages, state]);
  const log = useRef<HTMLDivElement>(null);
  const streamSize = live.reduce(
    (n, l) =>
      n + l.segments.length + l.segments.reduce((k, s) => k + (s.type === 'text' ? s.text.length : 0), 0),
    0,
  );
  useStickToBottom(log, `${items.length}:${streamSize}:${state.busy}`);
  const sealed = !!state.sealedProgress;
  const shown = sealed ? [] : live;
  return (
    <div
      ref={log}
      className="min-h-0 flex-1 overflow-y-auto pr-1"
      role="log"
      aria-label="Boardroom conversation"
      aria-live="polite"
      data-testid="board-log"
    >
      <ol className="flex flex-col gap-3 pb-2">
        {items.length === 0 && !state.busy && (
          <li className="py-8 text-center text-sm text-muted">
            The conversation starts when the first seat answers.
          </li>
        )}
        {items.map((it) => {
          if (it.kind === 'round')
            return <RoundSeparator key={it.key} r={it.round} cap={state.config.roundCap} />;
          if (it.kind === 'message') return <MessageRow key={it.key} m={it.message} cast={state.cast} />;
          if (it.kind === 'sealed')
            return <SealedRow key={it.key} count={it.count} total={it.total} cast={state.cast} />;
          return (
            <DecisionCard
              key={it.key}
              d={it.decision}
              busy={resolveBusy}
              error={resolveError}
              onResolve={onResolve}
              readOnly={!!readOnly}
            />
          );
        })}
        {shown.map((l) => {
          const seat = state.cast.find((c) => c.participantId === l.participantId) ?? null;
          return (
            <SeatTurn
              key={`live-${l.turnId ?? l.name}`}
              name={l.name}
              seat={seat}
              body=""
              segments={l.segments}
              live
            />
          );
        })}
        {state.busy && shown.length === 0 && !sealed && (
          <li
            role="status"
            className="flex items-center gap-2 text-sm text-muted"
            data-testid="session-thinking"
          >
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            {state.waitingFor === 'chair' ? `${state.chair.displayName} is choosing…` : 'Thinking…'}
          </li>
        )}
      </ol>
      {state.config.dissentNext && (
        <p className="text-center text-xs text-subtle">
          <Badge tone="warning">Dissent next</Badge> The Chair saw the room agree early: the next round is a
          steel-man and dissent round.
        </p>
      )}
    </div>
  );
}
