import { type ModelChoice, modelChoiceLabel } from '@aom/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useCeoChatState } from '../api/queries/ceo-chat.ts';
import { useChat, useThreadMessages } from '../api/queries/chats.ts';
import { newId } from '../lib/secure.ts';
import { getSocket } from '../ws/socket.ts';
import {
  ConfirmationCard,
  CorrectionCard,
  FullPowerLine,
  PermissionCard,
  QueuedBanner,
} from './ceo/CeoChatExtras.tsx';
import { ModelChip } from './ceo/ModelChip.tsx';
import { useCeoName } from './ceo/useCeoName.ts';
import { AgentAvatar } from './Face.tsx';
import { Button, Callout, ErrorBox, Spinner, TextArea } from './ui.tsx';

const OFFLINE_TEXT =
  'This agent is offline: its workstation is not connected. Nothing is queued, so send your message again once it is back.';

/** The model that answered, from the message data (a name, or a `{runtime, model, effort}` choice). */
function answeredWith(data: Record<string, unknown>): string | null {
  const m = data.model;
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object' && 'model' in m && 'runtime' in m) return modelChoiceLabel(m as ModelChoice);
  return null;
}

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
    default:
      return reason;
  }
}

/** One conversation: saved history, streamed reply, offline banner, send/stop. */
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
  const ceoName = useCeoName(retiredDevops);
  const messages = useThreadMessages(threadId);
  const qc = useQueryClient();
  const [draft, setDraft] = useState(initialDraft ?? '');
  /** null = idle; '' = sent, waiting for the first token; otherwise the reply so far. */
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; body: string } | null>(null);
  /** The CEO chat: a model chosen for the next message only. */
  const [messageModel, setMessageModel] = useState<ModelChoice | null>(null);
  /** The CEO's workstation is offline and the last message was queued. */
  const [queuedNotice, setQueuedNotice] = useState<{ workstationName?: string } | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    setStreaming(null);
    setError(null);
    setPending(null);
    return getSocket()?.listenChat(threadId, (ev) => {
      if (ev.type === 'delta') setStreaming((s) => (s ?? '') + ev.text);
      else if (ev.type === 'queued') {
        // Saved, not running: the reply comes when the workstation is back.
        setStreaming(null);
        setQueuedNotice({ ...(ev.workstationName ? { workstationName: ev.workstationName } : {}) });
        void qc.invalidateQueries({ queryKey: ['thread', threadId] });
      } else if (ev.type === 'done') {
        setStreaming(null);
        setQueuedNotice(null);
        void qc.invalidateQueries({ queryKey: ['thread', threadId] });
        void qc.invalidateQueries({ queryKey: ['chats'] });
      } else {
        // The message was not delivered (offline, busy...): take it back out of the thread and keep the text.
        const lost = pendingRef.current;
        setStreaming(null);
        setError(ev.reason);
        if (lost && ev.reason !== 'cancelled') {
          setPending(null);
          setDraft((d) => d || lost.body);
        }
      }
    });
  }, [threadId, qc]);

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
    setStreaming('');
  }, []);

  const list = messages.data?.messages ?? [];
  const showPending = pending && !list.some((m) => m.data.clientMsgId === pending.id);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the content changes
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [list.length, streaming, pending]);

  const offline = online !== undefined ? !online : chat ? !chat.workstationOnline : false;
  const busy = streaming !== null;
  const ceoState = useCeoChatState(threadId, isCeo, busy).data;

  const send = (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
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
    setStreaming('');
    setDraft('');
  };

  if (messages.isPending) return <Spinner label="Loading conversation" />;

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
      <div
        ref={log}
        role="log"
        aria-label="Conversation"
        className="min-h-40 flex-1 overflow-y-auto overscroll-contain rounded-card border border-line bg-surface p-3 max-md:rounded-none max-md:border-x-0"
      >
        {list.length === 0 && !showPending && streaming === null && (
          <p className="py-6 text-center text-sm text-subtle">Say hello to {name ?? 'the agent'}.</p>
        )}
        <ul className="flex flex-col gap-2">
          {list.map((m) => (
            <li
              key={m.id}
              data-testid="chat-message"
              data-author-kind={m.authorKind}
              className={`max-w-[88%] rounded-[14px] px-3.5 py-2 text-base ${
                m.authorKind === 'user'
                  ? 'self-end rounded-br-[4px] bg-brand text-brand-fg'
                  : 'self-start rounded-bl-[4px] bg-sunken text-fg'
              }`}
            >
              {m.authorKind === 'agent' && (
                <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted">
                  <AgentAvatar agentId={m.authorAgentId} name={m.authorName ?? 'agent'} size={16} />
                  {m.authorName}
                </span>
              )}
              <p className="whitespace-pre-wrap">{m.body}</p>
              {m.authorKind === 'agent' && isCeo && answeredWith(m.data) && (
                <span className="mt-1 block text-[11px] text-subtle" data-testid="answered-with">
                  {answeredWith(m.data)}
                </span>
              )}
              {m.authorKind === 'user' && m.data.queued === true && (
                <span className="mt-1 block text-[11px] opacity-80">Queued</span>
              )}
            </li>
          ))}
          {showPending && pending && (
            <li
              data-testid="chat-message"
              data-author-kind="user"
              className="max-w-[88%] self-end rounded-[14px] rounded-br-[4px] bg-brand px-3.5 py-2 text-base text-brand-fg"
            >
              <p className="whitespace-pre-wrap">{pending.body}</p>
            </li>
          )}
          {streaming !== null && (
            <li
              data-testid="chat-streaming"
              aria-live="polite"
              className="max-w-[88%] self-start rounded-[14px] rounded-bl-[4px] bg-sunken px-3.5 py-2 text-base text-fg"
            >
              {streaming ? (
                <p className="whitespace-pre-wrap">{streaming}</p>
              ) : (
                <p className="flex items-center gap-1 py-1" role="status">
                  <span className="sr-only">{name ?? 'The agent'} is typing</span>
                  {[0, 1, 2].map((d) => (
                    <span
                      key={d}
                      aria-hidden="true"
                      className="size-1.5 animate-pulse-soft rounded-full bg-subtle"
                      style={{ animationDelay: `${d * 0.25}s` }}
                    />
                  ))}
                </p>
              )}
            </li>
          )}
        </ul>
      </div>
      {isCeo && ceoState && (
        <div className="flex flex-col gap-2" data-testid="ceo-cards">
          {ceoState.permissions.map((p) => (
            <PermissionCard key={p.askId} p={p} />
          ))}
          {ceoState.confirmations.map((c) => (
            <ConfirmationCard key={c.actionId} c={c} />
          ))}
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
      ) : (
        <form
          onSubmit={send}
          aria-label="Compose"
          className="flex flex-col gap-2 max-md:sticky max-md:bottom-0 max-md:bg-canvas max-md:pb-2"
        >
          <TextArea
            label="Message"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(e);
              }
            }}
            disabled={busy}
          />
          <div className="flex flex-wrap items-center gap-2">
            {isCeo && ceoState && (
              <ModelChip
                model={ceoState.model}
                messageChoice={messageModel}
                onMessageChoice={setMessageModel}
              />
            )}
            <Button type="submit" variant="primary" disabled={busy || !draft.trim()}>
              Send
            </Button>
            {busy && <Button onClick={() => getSocket()?.cancelChat(threadId)}>Stop</Button>}
            <span className="ml-auto hidden text-xs text-subtle sm:block">
              Enter to send, Shift+Enter for a new line
            </span>
          </div>
        </form>
      )}
    </div>
  );
}
