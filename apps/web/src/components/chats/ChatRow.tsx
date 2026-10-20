import type { ChatDto } from '@aom/shared';
import { Loader2 } from 'lucide-react';
import { ageLabel } from '../../lib/time.ts';
import { AgentAvatar } from '../Face.tsx';
import { cx } from '../ui/cx.ts';

/** One conversation in the Chats list: avatar, agent, last message, when, and whether it needs a look. */
export function ChatRow({
  chat,
  working,
  onOpen,
  ceo,
}: {
  chat: ChatDto;
  working: boolean;
  onOpen: () => void;
  ceo?: boolean;
}) {
  const preview = chat.lastMessage ?? null;
  const count = chat.unreadCount ?? 0;
  const unread = count > 0;
  const text = preview?.body ?? '';
  return (
    <button
      type="button"
      onClick={onOpen}
      data-unread={unread || undefined}
      className="flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-card px-3 py-2 text-left hover:bg-sunken active:bg-sunken"
    >
      <span className="relative shrink-0">
        <AgentAvatar agentId={chat.agentId} name={chat.agentName} size={40} />
        <span
          role="img"
          aria-label={chat.workstationOnline ? 'Online' : 'Offline'}
          className={cx(
            'absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-surface',
            chat.workstationOnline ? 'bg-success' : 'bg-subtle',
          )}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cx('min-w-0 flex-1 truncate text-base', unread ? 'font-semibold' : 'font-medium')}>
            {chat.agentName}
            {ceo && <span className="ml-1.5 text-xs font-normal text-subtle">CEO</span>}
            {chat.cardRef && (
              <span className="ml-1.5 font-mono text-xs font-normal text-subtle">{chat.cardRef}</span>
            )}
          </span>
          <span className="shrink-0 text-xs text-subtle">
            {chat.lastMessageAt ? ageLabel(chat.lastMessageAt) : ''}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          {working ? (
            <span
              className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-brand-text"
              data-testid="chat-working"
            >
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              Working…
            </span>
          ) : (
            <span className={cx('min-w-0 flex-1 truncate text-sm', unread ? 'text-fg' : 'text-muted')}>
              {preview?.authorKind === 'user' && text
                ? `You: ${text}`
                : text || (chat.lastMessageAt ? '' : 'No messages yet')}
            </span>
          )}
          {unread && (
            <span
              role="img"
              aria-label={`${count >= 99 ? '99+' : count} unread`}
              className="tnum inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-xs font-semibold text-white"
              data-testid="chat-unread"
            >
              {count >= 99 ? '99+' : count}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
