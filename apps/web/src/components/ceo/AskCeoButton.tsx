import { MessagesSquare } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useCeoChat, useCeoStatus } from '../../api/queries/ceo.ts';
import { ceoChatPath } from '../../lib/openCeoChat.ts';
import { useActiveOrgRole } from '../../lib/orgRole.ts';

/**
 * "Ask <CEO name>" in the top bar: opens the Owner's standing chat with the CEO. Only the Owner sees it, and the status
 * (an Admin endpoint) is not even fetched for anyone else.
 */
export function AskCeoButton({ mobile = false }: { mobile?: boolean }) {
  const owner = useActiveOrgRole() === 'owner';
  const status = useCeoStatus(owner);
  const chat = useCeoChat();
  const nav = useNavigate();
  const s = status.data;
  if (!owner || !s?.hired || !s.agent || s.state === 'disabled' || s.state === 'none') return null;
  const name = s.agent.name;
  if (mobile)
    return (
      <button
        type="button"
        disabled={chat.isPending}
        data-testid="ask-ceo-mobile"
        aria-label={`Chat with ${name}`}
        onClick={() => chat.mutate(undefined, { onSuccess: (r) => nav(ceoChatPath(r.threadId)) })}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-control text-fg hover:bg-sunken disabled:text-disabled-fg"
      >
        <MessagesSquare aria-hidden="true" className="size-5" />
      </button>
    );
  return (
    <button
      type="button"
      disabled={chat.isPending}
      data-testid="ask-ceo-button"
      aria-label={`Ask ${name}`}
      onClick={() => chat.mutate(undefined, { onSuccess: (r) => nav(ceoChatPath(r.threadId)) })}
      className="inline-flex h-9 items-center gap-2 rounded-control border border-control bg-surface px-3 text-sm font-medium text-fg hover:bg-sunken disabled:text-disabled-fg"
    >
      <MessagesSquare aria-hidden="true" className="size-4" />
      <span className="hidden xl:inline">Ask {name}</span>
    </button>
  );
}
