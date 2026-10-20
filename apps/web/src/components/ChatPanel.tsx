import type { ModelChoice, ThreadMessagesResponse } from '@aom/shared';
import { useQueryClient } from '@tanstack/react-query';
import { MessagesSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useCeoChatState } from '../api/queries/ceo-chat.ts';
import { useChat, useMarkChatRead, useThreadMessages } from '../api/queries/chats.ts';
import { applyActivity, applyDelta } from '../lib/chatSegments.ts';
import { newId } from '../lib/secure.ts';
import { getSocket } from '../ws/socket.ts';
import {
  ConfirmationCard,
  CorrectionCard,
  FullPowerLine,
  PermissionCard,
  QueuedBanner,
  ReleaseCards,
} from './ceo/CeoChatExtras.tsx';
import { ModelChip } from './ceo/ModelChip.tsx';
import { useCeoName } from './ceo/useCeoName.ts';
import { Composer } from './chat/Composer.tsx';
import { MessageList, type StreamTurn } from './chat/MessageList.tsx';
import { useDraft } from './chat/useDraft.ts';
import { useOlderMessages } from './chat/useOlderMessages.ts';
import { Callout, ErrorBox, Spinner } from './ui.tsx';

const OFFLINE_TEXT =
  'This agent is offline: its workstation is not connected. Nothing is queued, so send your message again once it is back.';

/** Human text for the `chat.error` reasons the server sends (docs/ARCHITECTURE.md section 14). */
export function chatErrorText(reason: string): string {
  switch (reason) {
    case 'workstation_offline':
      return OFFLINE_TEXT;
    case 'simulation_workstation':
      return 'This is a simulation organization: this agent is not on its simulated workstation, and real workstations do not answer here. Hire the agent again on the simulated workstation.';
    case 'busy':
      return 'The agent is still answering your previous message.';
    case 'project_paused':
      return 'This project is paused by an Owner or Admin: nothing new starts on it until it is resumed.';
    case 'unknown_thread':
      return 'This conversation no longer exists.';
    case 'cancelled':
      return 'Stopped.';
    case 'ba_reports_retired':
      return 'The daily report is written by your CEO now. This conversation is read-only: ask your CEO instead.';
    default:
      return reason;
  }
}

const CEO_SUGGESTIONS = [
  "What's the status of my projects?",
  'What needs my decision?',
  'Plan a new feature',
  'What did the team ship this week?',
];

/** The turn being streamed: `finished` once chat.done arrived and the stored message is on its way. */
type Stream = StreamTurn & { finished?: boolean; doneId?: string };

/** One conversation: saved history, streamed turn with tool activity, offline banner, composer. */
export function ChatPanel({
  threadId,
  agentName,
  online,
  initialMessage,
  initialDraft,
}: {
  threadId: string;
  /** For conversations that are not in the chat list (the BA's intake chat). */
  agentName?: string;
  online?: boolean;
  /** Sent once when the panel opens (Ask DevOps starts a conversation with the user's request). */
  initialMessage?: string;
  /** Put in the composer for the user to review and send (a prefilled request to the CEO). */
  initialDraft?: string;
}) {
  const chat = useChat(threadId).data;
  const name = agentName ?? chat?.agentName;
  const isCeo = chat?.agentRole === 'ceo';
  /** Old DevOps conversations are read-only: DevOps works through the CEO now. */
  const retiredDevops = chat?.agentRole === 'devops';
  /** The standing "BA reports" conversation is read-only too: the CEO writes the daily report now. */
  const retiredBaReports = chat?.title === 'BA reports';
  const ceoName = useCeoName(retiredDevops || retiredBaReports);
  const messages = useThreadMessages(threadId);
  const qc = useQueryClient();
  const [draft, setDraft] = useDraft(threadId, initialDraft);
  /** null = idle; otherwise the turn being answered (no segments yet = waiting for the first token). */
  const [stream, setStream] = useState<Stream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; body: string } | null>(null);
  /** The CEO chat: a model chosen for the next message only. */
  const [messageModel, setMessageModel] = useState<ModelChoice | null>(null);
  /** The CEO's workstation is offline and the last message was queued. */
  const [queuedNotice, setQueuedNotice] = useState<{ workstationName?: string } | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    setStream(null);
    setError(null);
    setPending(null);
    return getSocket()?.listenChat(threadId, (ev) => {
      if (ev.type === 'delta') {
        setStream((s) => {
          if (s?.finished) return s;
          const cur = s ?? { segments: [], startedAt: Date.now() };
          return { ...cur, segments: applyDelta(cur.segments, ev.text) };
        });
      } else if (ev.type === 'activity') {
        setStream((s) => {
          if (s?.finished) return s;
          const cur = s ?? { segments: [], startedAt: Date.now() };
          return { ...cur, segments: applyActivity(cur.segments, ev.activity) };
        });
      } else if (ev.type === 'queued') {
        // Saved, not running: the reply comes when the workstation is back.
        setStream(null);
        setQueuedNotice({ ...(ev.workstationName ? { workstationName: ev.workstationName } : {}) });
        void qc.invalidateQueries({ queryKey: ['thread', threadId] });
      } else if (ev.type === 'done') {
        setQueuedNotice(null);
        const msg = ev.message;
        if (msg) {
          // The stored message came with it: swap in one step, no gap and no refetch flicker.
          qc.setQueryData<ThreadMessagesResponse>(['thread', threadId], (old) =>
            old && !old.messages.some((m) => m.id === msg.id)
              ? { ...old, messages: [...old.messages, msg] }
              : old,
          );
          setStream(null);
          void qc.invalidateQueries({ queryKey: ['thread', threadId] });
        } else {
          // Keep the streamed turn on screen until the stored one is in the list (or the refetch finished).
          setStream((s) => (s ? { ...s, finished: true, doneId: ev.messageId } : s));
          void qc
            .invalidateQueries({ queryKey: ['thread', threadId] })
            .finally(() => setStream((s) => (s?.finished ? null : s)));
        }
        void qc.invalidateQueries({ queryKey: ['chats'] });
      } else {
        // The message was not delivered (offline, busy...): take it back out of the thread and keep the text.
        const lost = pendingRef.current;
        setStream(null);
        setError(ev.reason);
        if (lost && ev.reason !== 'cancelled') {
          setPending(null);
          setDraft((d) => d || lost.body);
        }
      }
    });
  }, [threadId, qc, setDraft]);

  const initialSent = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
  useEffect(() => {
    if (!initialMessage || initialSent.current) return;
    initialSent.current = true;
    const id = newId();
    if (!getSocket()?.sendChat(threadId, initialMessage, id)) {
      setError('The live connection is down. Reload the page and try again.');
      setDraft(initialMessage);
      return;
    }
    setPending({ id, body: initialMessage });
    setStream({ segments: [], startedAt: Date.now() });
  }, []);

  const older = useOlderMessages(threadId, messages.data?.messages ?? [], messages.data?.hasMore ?? false);
  const list = older.messages;
  const offline = online !== undefined ? !online : chat ? !chat.workstationOnline : false;
  const busy = stream !== null && !stream.finished;
  const ceoState = useCeoChatState(threadId, isCeo, busy).data;
  // New agent messages in the open, visible chat are marked read on the server (synced to the user's other devices).
  useMarkChatRead(threadId, chat?.unreadCount ?? 0, list[list.length - 1]?.createdAt);
  const doneStored = !!stream?.doneId && list.some((m) => m.id === stream.doneId);
  const shownStream = stream && !doneStored ? stream : null;

  const send = (text?: string) => {
    const body = (text ?? draft).trim();
    if (!body || busy) return;
    const id = newId();
    const sock = getSocket();
    setError(null);
    const sent = messageModel
      ? sock?.sendChat(threadId, body, id, { choice: messageModel, scope: 'message' })
      : sock?.sendChat(threadId, body, id);
    if (!sent) {
      setError('The live connection is down. Reload the page and try again.');
      return;
    }
    setMessageModel(null);
    setPending({ id, body });
    setStream({ segments: [], startedAt: Date.now() });
    if (text === undefined) setDraft('');
  };

  if (messages.isPending) return <Spinner label="Loading conversation" />;

  const who = name ?? 'the agent';
  const empty = isCeo ? (
    <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center gap-4 px-2 py-8 text-center">
      <span className="inline-flex size-12 items-center justify-center rounded-full bg-brand-soft text-brand-soft-fg">
        <MessagesSquare aria-hidden="true" className="size-6" />
      </span>
      <div>
        <h2 className="text-lg font-semibold text-fg">Ask {who} anything</h2>
        <p className="mt-1 text-sm text-muted">
          Your CEO knows your projects, cards and team. Ask for a status, a decision or a plan.
        </p>
      </div>
      <ul className="flex w-full flex-col gap-2" data-testid="chat-suggestions">
        {CEO_SUGGESTIONS.map((s) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => send(s)}
              className="flex min-h-11 w-full items-center rounded-card border border-line bg-surface px-4 py-2 text-left text-sm text-fg hover:bg-sunken"
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
    </div>
  ) : (
    <p className="py-6 text-center text-sm text-subtle">Say hello to {who}.</p>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="chat-panel">
      {isCeo && ceoState && <FullPowerLine fullPower={ceoState.fullPower} ceoName={ceoState.agentName} />}
      {isCeo && <QueuedBanner state={ceoState} notice={queuedNotice} />}
      {offline && !isCeo && (
        <Callout tone="warning" role="alert" data-testid="chat-offline">
          {name} is offline: its workstation is not connected. Messages are not queued.
        </Callout>
      )}
      {chat?.projectId && (
        <p className="text-xs text-subtle" data-testid="chat-visibility">
          This conversation is visible to this project's managers.
        </p>
      )}
      <MessageList
        messages={list}
        agentName={name ?? 'agent'}
        agentId={chat?.agentId}
        showModel={isCeo}
        pending={pending}
        stream={shownStream}
        empty={empty}
        hasOlder={older.hasMore}
        loadingOlder={older.loading}
        olderError={older.error}
        onLoadOlder={older.loadOlder}
      />
      {isCeo && ceoState && (
        <div className="flex flex-col gap-2" data-testid="ceo-cards">
          {ceoState.permissions.map((p) => (
            <PermissionCard key={p.askId} p={p} />
          ))}
          {ceoState.confirmations.map((c) => (
            <ConfirmationCard key={c.actionId} c={c} />
          ))}
          <ReleaseCards />
          {ceoState.corrections.slice(0, 3).map((c) => (
            <CorrectionCard key={c.id} c={c} />
          ))}
        </div>
      )}
      {error && (
        <Callout tone="danger" role="alert" data-testid="chat-error">
          {chatErrorText(error)}
        </Callout>
      )}
      <ErrorBox error={messages.error} />
      {retiredDevops ? (
        <Callout tone="info" role="note" data-testid="devops-read-only">
          DevOps now works through {ceoName}. This conversation is read-only: ask {ceoName} instead.
        </Callout>
      ) : retiredBaReports ? (
        <Callout tone="info" role="note" data-testid="ba-reports-read-only">
          {ceoName} writes your daily report now. This conversation is read-only: ask {ceoName} instead.
        </Callout>
      ) : (
        <div className="shrink-0 pb-2 md:pb-0">
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={() => send()}
            onStop={() => getSocket()?.cancelChat(threadId)}
            busy={busy}
            placeholder={name ? `Message ${name}` : 'Message'}
            autoFocus
            tools={
              isCeo && ceoState ? (
                <ModelChip
                  model={ceoState.model}
                  messageChoice={messageModel}
                  onMessageChoice={setMessageModel}
                />
              ) : undefined
            }
          />
        </div>
      )}
    </div>
  );
}
