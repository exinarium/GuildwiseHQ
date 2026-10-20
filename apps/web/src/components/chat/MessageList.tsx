import type { ModelChoice, ThreadMessageDto } from '@aom/shared';
import { modelChoiceLabel } from '@aom/shared';
import { ArrowDown, Loader2 } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';
import { type ChatSegment, parseSegments } from '../../lib/chatSegments.ts';
import { AgentTurn, UserBubble } from './AgentTurn.tsx';
import { useStickToBottom } from './useStickToBottom.ts';

/** The model that answered, from the message data (a name, or a `{runtime, model, effort}` choice). */
export function answeredWith(data: Record<string, unknown>): string | null {
  const m = data.model;
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object' && 'model' in m && 'runtime' in m) return modelChoiceLabel(m as ModelChoice);
  return null;
}

/** The turn being streamed right now. */
export interface StreamTurn {
  segments: ChatSegment[];
  startedAt: number;
}

export function MessageList({
  messages,
  agentName,
  agentId,
  showModel,
  pending,
  stream,
  empty,
  hasOlder,
  loadingOlder,
  olderError,
  onLoadOlder,
}: {
  messages: ThreadMessageDto[];
  agentName: string;
  agentId?: string | undefined;
  /** CEO chat: show the model chip on agent turns. */
  showModel: boolean;
  pending: { id: string; body: string } | null;
  stream: StreamTurn | null;
  empty: ReactNode;
  hasOlder: boolean;
  loadingOlder: boolean;
  olderError?: string | null;
  onLoadOlder: () => Promise<boolean> | void;
}) {
  const log = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1];
  const streamText = stream
    ? stream.segments.length +
      stream.segments.reduce((n, s) => n + (s.type === 'text' ? s.text.length : 0), 0)
    : -1;
  const stick = useStickToBottom(
    log,
    `${last?.id ?? ''}|${pending?.id ?? ''}|${streamText}|${stream ? 1 : 0}`,
  );

  // Sending a message always brings you to it, even when you had scrolled up.
  const pendingId = pending?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when a new message is sent
  useEffect(() => {
    if (pendingId) stick.toBottom();
  }, [pendingId]);

  // Keep the reader's place when earlier messages are put above them.
  const anchor = useRef<{ h: number; first: string | undefined } | null>(null);
  const first = messages[0]?.id;
  useLayoutEffect(() => {
    const el = log.current;
    const a = anchor.current;
    if (el && a && a.first !== first) {
      el.scrollTop += el.scrollHeight - a.h;
      anchor.current = null;
    }
  }, [first]);
  const loadOlder = () => {
    const el = log.current;
    if (el) anchor.current = { h: el.scrollHeight, first };
    void onLoadOlder();
  };

  const showPending = pending && !messages.some((m) => m.data.clientMsgId === pending.id);
  const nothing = messages.length === 0 && !showPending && !stream;
  return (
    <div className="relative flex min-h-40 min-w-0 flex-1 flex-col">
      <div
        ref={log}
        role="log"
        aria-label="Conversation"
        onScroll={() => {
          stick.onScroll();
          const el = log.current;
          if (el && el.scrollTop < 120 && hasOlder && !loadingOlder) loadOlder();
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-3 max-md:px-0"
      >
        {nothing ? (
          empty
        ) : (
          <ul className="mx-auto flex w-full max-w-3xl flex-col gap-5">
            {(hasOlder || loadingOlder) && (
              <li className="flex justify-center">
                <button
                  type="button"
                  onClick={loadOlder}
                  disabled={loadingOlder}
                  data-testid="load-older"
                  className="inline-flex min-h-9 items-center gap-2 rounded-full border border-line px-3 text-xs text-muted hover:bg-sunken"
                >
                  {loadingOlder && <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />}
                  {loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
                </button>
              </li>
            )}
            {olderError && (
              <li role="alert" className="text-center text-xs text-danger">
                {olderError}
              </li>
            )}
            {messages.map((m) =>
              m.authorKind === 'user' ? (
                <UserBubble key={m.id} body={m.body} at={m.createdAt} queued={m.data.queued === true} />
              ) : m.authorKind === 'system' ? (
                <li
                  key={m.id}
                  data-testid="chat-message"
                  data-author-kind="system"
                  className="text-center text-xs text-subtle"
                >
                  {m.body}
                </li>
              ) : (
                <AgentTurn
                  key={m.id}
                  name={m.authorName ?? agentName}
                  agentId={m.authorAgentId ?? agentId}
                  body={m.body}
                  segments={parseSegments(m.data)}
                  at={m.createdAt}
                  model={showModel ? answeredWith(m.data) : null}
                />
              ),
            )}
            {showPending && pending && <UserBubble body={pending.body} />}
            {stream && (
              <AgentTurn
                testId="chat-streaming"
                aria-live="polite"
                name={agentName}
                agentId={agentId}
                body=""
                segments={stream.segments}
                live={{ startedAt: stream.startedAt }}
              />
            )}
          </ul>
        )}
      </div>
      {stick.away && (
        <button
          type="button"
          onClick={() => stick.toBottom(true)}
          data-testid="jump-to-latest"
          className="absolute bottom-3 left-1/2 inline-flex min-h-10 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-sm font-medium text-fg shadow-md hover:bg-sunken"
        >
          <ArrowDown aria-hidden="true" className="size-4" />
          {stick.unseen ? 'New messages' : 'Jump to latest'}
        </button>
      )}
    </div>
  );
}
