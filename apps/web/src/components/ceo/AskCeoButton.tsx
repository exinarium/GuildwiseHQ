import { MessagesSquare } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useCeoChat, useCeoStatus } from '../../api/queries/ceo.ts';
import { useActiveOrgRole } from '../../lib/orgRole.ts';

/**
 * "Ask <CEO name>" in the top bar: opens the Owner's standing chat with the CEO. Only the Owner sees it, and the status
 * (an Admin endpoint) is not even fetched for anyone else.
 */
export function AskCeoButton() {
  const owner = useActiveOrgRole() === 'owner';
  const status = useCeoStatus(owner);
  const chat = useCeoChat();
  const nav = useNavigate();
  const s = status.data;
  if (!owner || !s?.hired || !s.agent || s.state === 'disabled' || s.state === 'none') return null;
  const name = s.agent.name;
  return (
    <button
      type="button"
      disabled={chat.isPending}
      data-testid="ask-ceo-button"
      aria-label={`Ask ${name}`}
      onClick={() => chat.mutate(undefined, { onSuccess: (r) => nav(`/ceo-chat/${r.threadId}`) })}
      className="inline-flex h-9 items-center gap-2 rounded-control border border-control bg-surface px-3 text-sm font-medium text-fg hover:bg-sunken disabled:text-disabled-fg"
    >
      <MessagesSquare aria-hidden="true" className="size-4" />
      <span className="hidden xl:inline">Ask {name}</span>
    </button>
  );
}
