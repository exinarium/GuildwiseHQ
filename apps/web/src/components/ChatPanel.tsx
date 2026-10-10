import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useChat, useThreadMessages } from '../api/queries/chats.ts';
import { newId } from '../lib/secure.ts';
import { getSocket } from '../ws/socket.ts';
import { AgentAvatar } from './Face.tsx';
import { Avatar, Button, Callout, ErrorBox, Spinner, TextArea } from './ui.tsx';

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
}: {
  threadId: string;
  /** For conversations that are not in the chat list (the BA's intake chat). */
  agentName?: string;
  online?: boolean;
  /** Sent once when the panel opens (Ask DevOps starts a conversation with the user's request). */
  initialMessage?: string;
}) {
  const chat = useChat(threadId).data;
  const name = agentName ?? chat?.agentName;
  const messages = useThreadMessages(threadId);
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  /** null = idle; '' = sent, waiting for the first token; otherwise the reply so far. */
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; body: string } | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    setStreaming(null);
    setError(null);
    setPending(null);
    return getSocket()?.listenChat(threadId, (ev) => {
      if (ev.type === 'delta') setStreaming((s) => (s ?? '') + ev.text);
      else if (ev.type === 'done') {
        setStreaming(null);
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

  const send = (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    const id = newId();
    const sock = getSocket();
    setError(null);
    if (!sock?.sendChat(threadId, body, id)) {
      setError('The live connection is down. Reload the page and try again.');
      return;
    }
    setPending({ id, body });
    setStreaming('');
    setDraft('');
  };

  if (messages.isPending) return <Spinner label="Loading conversation" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="chat-panel">
      {offline && (
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
        className="min-h-40 flex-1 overflow-y-auto rounded-card border border-line bg-surface p-3"
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
      {error && (
        <Callout tone="danger" role="alert" data-testid="chat-error">
          {chatErrorText(error)}
        </Callout>
      )}
      <ErrorBox error={messages.error} />
      <form onSubmit={send} aria-label="Compose" className="flex flex-col gap-2">
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
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy || !draft.trim()}>
            Send
          </Button>
          {busy && <Button onClick={() => getSocket()?.cancelChat(threadId)}>Stop</Button>}
          <span className="ml-auto hidden text-xs text-subtle sm:block">
            Enter to send, Shift+Enter for a new line
          </span>
        </div>
      </form>
    </div>
  );
}
