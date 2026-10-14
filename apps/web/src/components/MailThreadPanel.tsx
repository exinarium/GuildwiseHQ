import { MAIL_REPLY_MAX_CHARS, type MailThreadDto } from '@aom/shared';
import { useState } from 'react';
import { type ThreadRef, useMailReply, useMailThread } from '../api/queries/mail.ts';
import { formatDateTime } from '../lib/time.ts';
import { Badge, Button, Callout, ErrorBox, ListSkeleton, Panel, TextArea } from './ui.tsx';

/** The messages of a conversation, oldest first. Incoming text is outside content: shown as plain text only. */
function Messages({ thread }: { thread: MailThreadDto }) {
  return (
    <ol className="flex flex-col gap-3" aria-label="Conversation" data-testid="mail-thread-messages">
      {thread.messages.map((m) => (
        <li
          key={m.id}
          className={`rounded-control border border-line p-3 text-sm ${m.direction === 'out' ? 'bg-sunken' : 'bg-surface'}`}
          data-testid={`mail-message-${m.direction}`}
        >
          <p className="mb-1 flex flex-wrap items-center gap-x-2 text-xs text-subtle">
            <span className="font-medium text-fg">
              {m.direction === 'out'
                ? `${m.sentByName ?? 'Guildwise'} replied`
                : m.fromName
                  ? `${m.fromName} <${m.from}>`
                  : m.from}
            </span>
            <span>{formatDateTime(m.at)}</span>
            {m.direction === 'out' && <Badge tone="brand">Sent</Badge>}
          </p>
          <p className="whitespace-pre-wrap break-words text-fg">{m.text}</p>
        </li>
      ))}
    </ol>
  );
}

/**
 * Reply to an e-mail conversation as the organisation (backlog #15). A person always writes or reviews the text and
 * presses Send; nothing is sent by itself. `draft` pre-fills the box (a draft written by the BA).
 */
export function MailThreadPanel({
  refTo,
  draft,
  draftedBy,
  extra,
}: {
  refTo: ThreadRef;
  draft?: string;
  draftedBy?: 'ba';
  /** Buttons next to Send (Draft with BA). */
  extra?: (thread: MailThreadDto) => React.ReactNode;
}) {
  const q = useMailThread(refTo);
  const reply = useMailReply(refTo);
  const [text, setText] = useState('');
  const [fromDraft, setFromDraft] = useState<string | undefined>();
  const [sentNote, setSentNote] = useState('');
  if (draft && draft !== fromDraft) {
    setFromDraft(draft);
    setText(draft);
  }
  if (q.isPending) return <ListSkeleton label="Loading the conversation" rows={2} />;
  // A card without a stored conversation (pruned, or not made from e-mail): nothing to show.
  if (q.isError) return null;
  const thread = q.data;
  const send = () =>
    reply.mutate(
      { text: text.trim(), ...(draftedBy && text === draft ? { draftedBy } : {}) },
      {
        onSuccess: () => {
          setText('');
          setSentNote(`Sent to ${thread.replyTo}`);
        },
      },
    );
  return (
    <div className="flex flex-col gap-3" data-testid="mail-thread">
      <Messages thread={thread} />
      {thread.canReply ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) send();
          }}
        >
          <TextArea
            label={`Reply to ${thread.replyTo}`}
            value={text}
            rows={5}
            maxLength={MAIL_REPLY_MAX_CHARS}
            onChange={(e) => {
              setText(e.target.value);
              setSentNote('');
            }}
            hint="Sent by e-mail as the organisation. The person who wrote in sees your text and their answer comes back here."
            data-testid="mail-reply-text"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={!text.trim()}
              loading={reply.isPending}
              data-testid="mail-reply-send"
            >
              Send reply
            </Button>
            {extra?.(thread)}
            {sentNote && (
              <span className="text-sm text-success" role="status" data-testid="mail-reply-sent">
                {sentNote}
              </span>
            )}
          </div>
          <ErrorBox error={reply.error} />
        </form>
      ) : (
        <Callout tone="info" title="You cannot reply here">
          {thread.cannotReplyReason}
        </Callout>
      )}
    </div>
  );
}

/** The e-mail conversation of a card made from e-mail, on the card page. Shows nothing when there is none stored. */
export function CardMailReply({ cardId }: { cardId: string }) {
  const refTo: ThreadRef = { kind: 'card', id: cardId };
  const q = useMailThread(refTo);
  if (q.isError || q.isPending) return null;
  return (
    <Panel title="E-mail conversation" data-testid="card-mail-reply">
      <MailThreadPanel refTo={refTo} />
    </Panel>
  );
}
