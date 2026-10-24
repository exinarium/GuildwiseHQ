import { useQueryClient } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useThreadMessages } from '../api/queries/chats.ts';
import { usePersonaChat, useSayToPersona, useSetPersonaChatLimits } from '../api/queries/my-capabilities.ts';
import { AgentTurn, UserBubble } from '../components/chat/AgentTurn.tsx';
import { Composer } from '../components/chat/Composer.tsx';
import {
  Badge,
  Button,
  Callout,
  Disclosure,
  EmptyState,
  ErrorBox,
  PageHeader,
  PageSkeleton,
  TextInput,
} from '../components/ui.tsx';
import { applyActivity, applyDelta, type ChatSegment } from '../lib/chatSegments.ts';
import { getSocket } from '../ws/socket.ts';

/** A one-to-one chat with a persona that is not hired: durable turns on your own workstation, read-only, cost tracked. */
export function PersonaChat() {
  const { id = '' } = useParams();
  const chat = usePersonaChat(id);
  const messages = useThreadMessages(id);
  const say = useSayToPersona(id);
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState<{ segments: ChatSegment[]; startedAt: number } | null>(null);
  useEffect(() => {
    setLive(null);
    return getSocket()?.listenChat(id, (ev) => {
      if (ev.type === 'delta')
        setLive((cur) => ({
          segments: applyDelta(cur?.segments ?? [], ev.text),
          startedAt: cur?.startedAt ?? Date.now(),
        }));
      else if (ev.type === 'activity')
        setLive((cur) => ({
          segments: applyActivity(cur?.segments ?? [], ev.activity),
          startedAt: cur?.startedAt ?? Date.now(),
        }));
      else if (ev.type === 'done' || ev.type === 'error' || ev.type === 'disconnected') {
        setLive(null);
        void qc.invalidateQueries({ queryKey: ['thread', id] });
        void qc.invalidateQueries({ queryKey: ['persona-chat', id] });
      }
    });
  }, [id, qc]);
  if (chat.isPending) return <PageSkeleton label="Loading the chat" />;
  const s = chat.data?.session;
  if (!s)
    return (
      <EmptyState
        icon={MessageSquare}
        tone="neutral"
        title="Chat not found"
        description="It may have been removed, or it belongs to someone else."
      />
    );
  const persona = s.participants.find((p) => p.kind === 'persona');
  const limitMinutes = typeof s.config.timeLimitMinutes === 'number' ? s.config.timeLimitMinutes : null;
  const timeLeft =
    limitMinutes === null
      ? null
      : Math.ceil(limitMinutes - (Date.now() - new Date(s.createdAt).getTime()) / 60_000);
  const turns = chat.data?.turns ?? [];
  const busy = turns.some((t) => t.status === 'queued' || t.status === 'running');
  const last = turns[turns.length - 1];
  return (
    <div className="mx-auto flex max-w-3xl flex-col" data-testid="persona-chat">
      <PageHeader
        title={s.title}
        documentTitle={s.title}
        back={{ to: '/settings/capabilities', label: 'Capabilities' }}
        eyebrow={
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge>read only</Badge>
            <Badge tone="neutral" data-testid="chat-cost">
              ${s.cost.costUsd.toFixed(2)} so far
              {s.cost.budgetUsd ? ` of $${s.cost.budgetUsd.toFixed(2)}` : ''}
            </Badge>
            {timeLeft !== null && (
              <Badge tone={timeLeft <= 0 ? 'danger' : 'neutral'} data-testid="chat-time">
                {timeLeft <= 0 ? 'time is up' : `${timeLeft} min left`}
              </Badge>
            )}
          </div>
        }
      />
      {(s.cost.exceeded || (timeLeft !== null && timeLeft <= 0)) && (
        <Callout tone="warning" role="status" className="mb-2" data-testid="chat-limit-reached">
          {s.cost.exceeded
            ? `This chat has used its budget of $${s.cost.budgetUsd?.toFixed(2)}.`
            : `This chat has reached its time limit of ${limitMinutes} minutes.`}{' '}
          Raise the limit below to carry on.
        </Callout>
      )}
      <LimitsForm
        key={`${s.cost.budgetUsd}-${limitMinutes}`}
        id={id}
        budgetUsd={s.cost.budgetUsd}
        minutes={limitMinutes}
      />
      {!s.workstationOnline && (
        <Callout tone="warning" role="status" className="mb-2">
          Your workstation is offline. Messages wait for it and nothing is lost.
        </Callout>
      )}
      <div className="flex h-[calc(100dvh-16rem)] min-h-[20rem] flex-col gap-3">
        <div
          className="min-h-0 flex-1 overflow-y-auto pr-1"
          role="log"
          aria-label="Conversation"
          data-testid="persona-chat-log"
        >
          <ol className="flex flex-col gap-3 pb-2">
            {(messages.data?.messages ?? []).map((m) =>
              m.authorKind === 'user' ? (
                <UserBubble key={m.id} body={m.body} at={m.createdAt} />
              ) : (
                <AgentTurn
                  key={m.id}
                  name={m.authorName ?? persona?.displayName ?? 'Persona'}
                  agentId={m.authorPersonaKey ?? null}
                  body={m.body}
                  at={m.createdAt}
                />
              ),
            )}
            {live && (
              <AgentTurn
                name={persona?.displayName ?? 'Persona'}
                agentId={null}
                body=""
                segments={live.segments}
                live={{ startedAt: live.startedAt }}
              />
            )}
          </ol>
        </div>
        {last?.status === 'failed' && last.error !== 'cancelled' && !busy && (
          <Callout tone="warning" role="alert" title="The last reply did not finish">
            {last.error}
          </Callout>
        )}
        <ErrorBox error={say.error} />
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={() => {
            const body = draft.trim();
            if (body) say.mutate(body, { onSuccess: () => setDraft('') });
          }}
          onStop={() => undefined}
          busy={false}
          placeholder={`Write to ${persona?.displayName ?? 'the persona'}`}
          slash={{ context: 'chat' }}
        />
      </div>
    </div>
  );
}

/** The chat's optional budget and time limit: change or remove them (an empty field removes the limit). */
function LimitsForm({
  id,
  budgetUsd,
  minutes,
}: {
  id: string;
  budgetUsd: number | null;
  minutes: number | null;
}) {
  const set = useSetPersonaChatLimits(id);
  const [b, setB] = useState(budgetUsd ? String(budgetUsd) : '');
  const [m, setM] = useState(minutes ? String(minutes) : '');
  return (
    <Disclosure summary="Limits" className="mb-2" data-testid="chat-limits">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          set.mutate({ budgetUsd: b ? Number(b) : null, timeLimitMinutes: m ? Number(m) : null });
        }}
      >
        <TextInput
          label="Budget in USD"
          type="number"
          min="0"
          step="0.5"
          value={b}
          onChange={(e) => setB(e.target.value)}
        />
        <TextInput
          label="Time limit in minutes"
          type="number"
          min="5"
          step="5"
          value={m}
          onChange={(e) => setM(e.target.value)}
        />
        <Button type="submit" size="sm" loading={set.isPending} data-testid="save-limits">
          Save limits
        </Button>
      </form>
      <p className="mt-1 text-xs text-muted">
        The time limit counts from the start of the chat. A chat nobody writes in for 90 days is removed from
        your lists.
      </p>
      <ErrorBox error={set.error} />
    </Disclosure>
  );
}
