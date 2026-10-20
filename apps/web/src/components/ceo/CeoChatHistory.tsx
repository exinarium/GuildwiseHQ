import type { ChatDto } from '@aom/shared';
import { useThreadPreview } from '../../api/queries/chats.ts';
import { formatDateTime } from '../../lib/time.ts';
import { previewText } from '../chats/ChatRow.tsx';
import { cx } from '../ui/cx.ts';

function HistoryRow({
  chat,
  current,
  standing,
  onOpen,
}: {
  chat: ChatDto;
  current: boolean;
  standing: boolean;
  onOpen: () => void;
}) {
  const preview = useThreadPreview(chat.threadId, chat.lastMessageAt !== null).data;
  return (
    <button
      type="button"
      aria-current={current ? 'page' : undefined}
      data-testid="ceo-chat-row"
      onClick={onOpen}
      className={cx(
        'flex min-h-14 w-full flex-col items-start gap-0.5 rounded-card border px-3 py-2 text-left hover:bg-sunken',
        current ? 'border-brand bg-brand-soft/40' : 'border-line',
      )}
    >
      <span className="flex w-full items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium text-fg">
          {standing ? 'Current chat' : formatDateTime(chat.lastMessageAt ?? chat.createdAt)}
        </span>
        <span className="shrink-0 text-xs text-subtle">
          {standing && chat.lastMessageAt ? formatDateTime(chat.lastMessageAt) : ''}
        </span>
      </span>
      <span className="w-full truncate text-xs text-muted">
        {preview ? previewText(preview.body) : chat.lastMessageAt ? '' : 'No messages yet'}
      </span>
    </button>
  );
}

/** The CEO chats, newest first: the current one and the earlier (archived) ones. Used as the side list and in the sheet. */
export function CeoChatHistory({
  chats,
  threadId,
  standingId,
  onOpen,
}: {
  chats: ChatDto[];
  threadId: string;
  standingId: string | null;
  onOpen: (id: string) => void;
}) {
  const sorted = [...chats].sort((a, b) =>
    (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt),
  );
  return (
    <ul className="flex flex-col gap-2" data-testid="ceo-chat-list">
      {sorted.length === 0 && <li className="text-sm text-subtle">No chats yet.</li>}
      {sorted.map((c) => (
        <li key={c.threadId}>
          <HistoryRow
            chat={c}
            current={c.threadId === threadId}
            standing={c.threadId === standingId}
            onOpen={() => onOpen(c.threadId)}
          />
        </li>
      ))}
    </ul>
  );
}
