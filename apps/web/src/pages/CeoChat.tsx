import { History, MessageSquareOff, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { useCeoChat, useCeoStatus, useNewCeoChat } from '../api/queries/ceo.ts';
import { useChats, useDeleteChat } from '../api/queries/chats.ts';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { PinnedScreen } from '../components/PinnedScreen.tsx';
import { BottomSheet } from '../components/ui/BottomSheet.tsx';
import { Button, ConfirmDialog, EmptyState, ErrorBox, PageSkeleton, useToast } from '../components/ui.tsx';
import type { CeoChatLocationState } from '../lib/openCeoChat.ts';
import { useActiveOrgRole } from '../lib/orgRole.ts';
import { formatDateTime } from '../lib/time.ts';

/**
 * The CEO chat as a page (not an overlay): the conversation, "New chat", "Clear chat" and the earlier CEO chats.
 * `/ceo-chat` opens the standing chat; `/ceo-chat/:threadId` an earlier one.
 */
export function CeoChat() {
  const { threadId } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const owner = useActiveOrgRole() === 'owner';
  const status = useCeoStatus(owner);
  const standing = useCeoChat();
  const fresh = useNewCeoChat();
  const remove = useDeleteChat();
  const chats = useChats();
  const prefill = (useLocation().state as CeoChatLocationState | null)?.ceoPrefill;
  const [standingId, setStandingId] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [clearing, setClearing] = useState(false);
  const asked = useRef(false);
  const hired = !!status.data?.hired && !!status.data.agent;
  const ceoName = status.data?.agent?.name ?? 'your CEO';

  // Find (or create) the standing chat once; `/ceo-chat` then goes to it.
  const { mutate: openStanding } = standing;
  useEffect(() => {
    if (!owner || !hired || asked.current) return;
    asked.current = true;
    openStanding(undefined, {
      onSuccess: (r) => {
        setStandingId(r.threadId);
        if (!threadId)
          nav(`/ceo-chat/${r.threadId}`, { replace: true, state: prefill ? { ceoPrefill: prefill } : null });
      },
    });
  }, [owner, hired, threadId, nav, openStanding, prefill]);

  if (status.isPending && owner) return <PageSkeleton label="Loading chat" panels={1} />;
  if (!owner || !hired) {
    return (
      <EmptyState
        icon={MessageSquareOff}
        tone="neutral"
        title="No CEO to chat with"
        description="Only the organization Owner can chat with the CEO, and the CEO has to be appointed first."
      />
    );
  }
  if (standing.isError) return <ErrorBox error={standing.error} onRetry={() => standing.reset()} />;
  if (!threadId) return <PageSkeleton label="Opening the chat" panels={1} />;

  const ceoChats = (chats.data ?? []).filter((c) => c.agentRole === 'ceo' && !c.archived);
  const isStanding = threadId === standingId;

  const goStanding = () => nav('/ceo-chat', { replace: true });
  const newChat = () =>
    fresh.mutate(undefined, {
      onSuccess: (r) => {
        setStandingId(r.threadId);
        setHistory(false);
        nav(`/ceo-chat/${r.threadId}`);
      },
    });
  const clear = () =>
    remove.mutate(threadId, {
      onSuccess: () => {
        setClearing(false);
        toast.success('Chat cleared');
        // The standing chat is gone: opening it again creates a clean one.
        asked.current = false;
        setStandingId(null);
        goStanding();
      },
    });

  return (
    <PinnedScreen
      desktopClassName="mx-auto h-[calc(100dvh-8.5rem)] min-h-[26rem] max-w-3xl"
      testId="ceo-chat-screen"
    >
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2">
        <h1 className="mr-auto min-w-0 truncate text-lg font-semibold text-fg">Chat with {ceoName}</h1>
        <Button
          size="sm"
          className="min-h-11 md:min-h-0"
          data-testid="ceo-chat-history"
          onClick={() => setHistory(true)}
          aria-label="Earlier chats"
        >
          <History aria-hidden="true" className="size-4" />
          <span className="max-sm:sr-only">Earlier</span>
        </Button>
        <Button
          size="sm"
          className="min-h-11 md:min-h-0"
          data-testid="ceo-chat-new"
          disabled={fresh.isPending}
          onClick={newChat}
        >
          <Plus aria-hidden="true" className="size-4" />
          <span>New chat</span>
        </Button>
        <Button
          size="sm"
          variant="danger-ghost"
          className="min-h-11 md:min-h-0"
          data-testid="ceo-chat-clear"
          onClick={() => setClearing(true)}
        >
          <Trash2 aria-hidden="true" className="size-4" />
          <span>Clear chat</span>
        </Button>
      </div>
      <ErrorBox error={fresh.error} />
      {!isStanding && standingId && (
        <p className="mb-2 shrink-0 text-xs text-subtle" data-testid="ceo-chat-earlier-note">
          An earlier chat.{' '}
          <button type="button" className="underline" onClick={goStanding}>
            Go to the current chat
          </button>
        </p>
      )}
      <ChatPanel key={threadId} threadId={threadId} {...(prefill ? { initialDraft: prefill } : {})} />

      <BottomSheet
        open={history}
        onOpenChange={setHistory}
        title="Earlier chats with the CEO"
        testId="ceo-chat-history-sheet"
      >
        <ul className="flex flex-col gap-2" data-testid="ceo-chat-list">
          {ceoChats.length === 0 && <li className="text-sm text-subtle">No chats yet.</li>}
          {ceoChats.map((c) => (
            <li key={c.threadId}>
              <button
                type="button"
                aria-current={c.threadId === threadId ? 'page' : undefined}
                onClick={() => {
                  setHistory(false);
                  nav(`/ceo-chat/${c.threadId}`);
                }}
                className="flex min-h-12 w-full items-center justify-between gap-2 rounded-control border border-line px-3 py-2 text-left text-sm hover:bg-sunken aria-[current=page]:border-brand"
              >
                <span className="truncate">
                  {c.threadId === standingId
                    ? 'Current chat'
                    : formatDateTime(c.lastMessageAt ?? c.createdAt)}
                </span>
                <span className="shrink-0 text-xs text-subtle">
                  {c.lastMessageAt ? formatDateTime(c.lastMessageAt) : 'No messages'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </BottomSheet>
      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        title="Clear this chat?"
        description={`The whole conversation is removed for good and ${ceoName} starts a clean one. This cannot be undone. Use New chat to keep it.`}
        confirmLabel="Clear chat"
        pending={remove.isPending}
        onConfirm={clear}
      >
        <ErrorBox error={remove.error} />
      </ConfirmDialog>
    </PinnedScreen>
  );
}
