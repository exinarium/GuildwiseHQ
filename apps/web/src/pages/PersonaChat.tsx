import { useQueryClient } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useThreadMessages } from '../api/queries/chats.ts';
import { usePersonaChat, useSayToPersona } from '../api/queries/my-capabilities.ts';
import { AgentTurn, UserBubble } from '../components/chat/AgentTurn.tsx';
import { Composer } from '../components/chat/Composer.tsx';
import { Badge, Callout, EmptyState, ErrorBox, PageHeader, PageSkeleton } from '../components/ui.tsx';
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
            </Badge>
          </div>
        }
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
        />
      </div>
    </div>
  );
}
