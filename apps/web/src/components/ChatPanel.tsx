import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useChat, useThreadMessages } from '../api/queries/chats.ts';
import { getSocket } from '../ws/socket.ts';
import { Avatar, Button, ErrorBox, Spinner, TextArea } from './ui.tsx';

const OFFLINE_TEXT =
  'This agent is offline: its workstation is not connected. Nothing is queued, so send your message again once it is back.';

/** Human text for the `chat.error` reasons the server sends (docs/ARCHITECTURE.md section 14). */
export function chatErrorText(reason: string): string {
  switch (reason) {
    case 'workstation_offline':
      return OFFLINE_TEXT;
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
export function ChatPanel({ threadId }: { threadId: string }) {
  const chat = useChat(threadId).data;
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

  const list = messages.data?.messages ?? [];
  const showPending = pending && !list.some((m) => m.data.clientMsgId === pending.id);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the content changes
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [list.length, streaming, pending]);

  const offline = chat ? !chat.workstationOnline : false;
  const busy = streaming !== null;

  const send = (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    const id = crypto.randomUUID();
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
        <p
          role="alert"
          data-testid="chat-offline"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          {chat?.agentName} is offline: its workstation is not connected. Messages are not queued.
        </p>
      )}
      <div
        ref={log}
        role="log"
        aria-label="Conversation"
        className="min-h-40 flex-1 overflow-y-auto rounded-md border border-zinc-200 p-2 dark:border-zinc-800"
      >
        {list.length === 0 && !showPending && streaming === null && (
          <p className="text-sm text-zinc-500">Say hello to {chat?.agentName ?? 'the agent'}.</p>
        )}
        <ul className="flex flex-col gap-2">
          {list.map((m) => (
            <li
              key={m.id}
              data-testid="chat-message"
              data-author-kind={m.authorKind}
              className={`max-w-[92%] rounded-lg px-3 py-2 text-sm ${
                m.authorKind === 'user'
                  ? 'self-end bg-indigo-600 text-white'
                  : 'self-start bg-zinc-100 dark:bg-zinc-800'
              }`}
            >
              {m.authorKind === 'agent' && (
                <span className="mb-0.5 flex items-center gap-1 text-xs font-medium text-zinc-500">
                  <Avatar name={m.authorName ?? 'agent'} size={16} />
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
              className="max-w-[92%] self-end rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white"
            >
              <p className="whitespace-pre-wrap">{pending.body}</p>
            </li>
          )}
          {streaming !== null && (
            <li
              data-testid="chat-streaming"
              aria-live="polite"
              className="max-w-[92%] self-start rounded-lg bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-800"
            >
              <p className="whitespace-pre-wrap">{streaming || '…'}</p>
            </li>
          )}
        </ul>
      </div>
      {error && (
        <p
          role="alert"
          data-testid="chat-error"
          className="text-sm font-medium text-red-600 dark:text-red-400"
        >
          {chatErrorText(error)}
        </p>
      )}
      <ErrorBox error={messages.error} />
      <form onSubmit={send} aria-label="Compose" className="flex flex-col gap-2">
        <TextArea
          label="Message"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e);
          }}
          disabled={busy}
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy || !draft.trim()}>
            Send
          </Button>
          {busy && <Button onClick={() => getSocket()?.cancelChat(threadId)}>Stop</Button>}
        </div>
      </form>
    </div>
  );
}
