import { History, MessageSquareOff, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import {
  isTurnInFlight,
  TURN_IN_FLIGHT_TEXT,
  useCeoChat,
  useCeoStatus,
  useStartCeoChat,
} from '../api/queries/ceo.ts';
import { useChats } from '../api/queries/chats.ts';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { CeoChatHistory } from '../components/ceo/CeoChatHistory.tsx';
import { AgentAvatar } from '../components/Face.tsx';
import { PinnedScreen } from '../components/PinnedScreen.tsx';
import { BottomSheet } from '../components/ui/BottomSheet.tsx';
import { Button, Callout, EmptyState, ErrorBox, PageSkeleton, useToast } from '../components/ui.tsx';
import { type CeoChatLocationState, ceoChatPath } from '../lib/openCeoChat.ts';
import { useActiveOrgRole } from '../lib/orgRole.ts';
import { usePageTitle } from '../lib/usePageTitle.ts';

/**
 * The CEO chat as a page (not an overlay): the conversation, "New chat" (archives the old chat) and the earlier chats (a side list on
 * desktop, a sheet on phones). `/ceo-chat` opens the standing chat; `/ceo-chat/:threadId` an earlier one.
 */
export function CeoChat() {
  const { threadId } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const owner = useActiveOrgRole() === 'owner';
  const status = useCeoStatus(owner);
  const standing = useCeoChat();
  const startNew = useStartCeoChat();
  const chats = useChats();
  const prefill = (useLocation().state as CeoChatLocationState | null)?.ceoPrefill;
  const [standingId, setStandingId] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const asked = useRef(false);
  const hired = !!status.data?.hired && !!status.data.agent;
  const ceoName = status.data?.agent?.name ?? 'your CEO';
  usePageTitle(`Chat with ${ceoName}`);

  // Find (or create) the standing chat once; `/ceo-chat` then goes to it.
  const { mutate: openStanding } = standing;
  useEffect(() => {
    if (!owner || !hired || asked.current) return;
    asked.current = true;
    openStanding(undefined, {
      onSuccess: (r) => {
        setStandingId(r.threadId);
        if (!threadId)
          nav(ceoChatPath(r.threadId), { replace: true, state: prefill ? { ceoPrefill: prefill } : null });
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
        description={
          owner
            ? 'Your CEO is not set up yet. Try again in a moment.'
            : 'Only the organization Owner chats with the CEO.'
        }
      />
    );
  }
  if (standing.isError) return <ErrorBox error={standing.error} onRetry={() => standing.reset()} />;
  if (!threadId) return <PageSkeleton label="Opening the chat" panels={1} />;

  const ceoChats = (chats.data ?? []).filter((c) => c.agentRole === 'ceo');
  const isStanding = threadId === standingId;
  const agent = status.data?.agent;
  const goStanding = () => nav('/ceo-chat', { replace: true });
  const fail = (e: unknown) => setNotice(isTurnInFlight(e) ? TURN_IN_FLIGHT_TEXT : null);

  const newChat = () => {
    setNotice(null);
    startNew.mutate(undefined, {
      onSuccess: (r) => {
        setStandingId(r.threadId);
        setHistory(false);
        if (r.threadId !== threadId) nav(ceoChatPath(r.threadId));
      },
      onError: fail,
    });
  };
  const open = (id: string) => {
    setHistory(false);
    nav(ceoChatPath(id));
  };

  return (
    <PinnedScreen
      desktopClassName="mx-auto h-[calc(100dvh-8.5rem)] min-h-[26rem] max-w-5xl"
      testId="ceo-chat-screen"
    >
      <div className="flex min-h-0 flex-1 gap-5">
        <aside
          aria-label="Earlier chats"
          className="hidden w-64 shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain border-r border-line pr-4 md:flex"
          data-testid="ceo-chat-side"
        >
          <h2 className="text-sm font-semibold text-muted">Chats</h2>
          <CeoChatHistory chats={ceoChats} threadId={threadId} standingId={standingId} onOpen={open} />
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="mb-2 flex shrink-0 items-center gap-2 border-b border-line pb-2">
            {agent && <AgentAvatar agentId={agent.id} name={agent.name} size={32} />}
            <h1
              aria-label={`Chat with ${ceoName}`}
              className="mr-auto min-w-0 truncate text-lg font-semibold text-fg"
            >
              <span className="max-sm:hidden">Chat with </span>
              {ceoName}
            </h1>
            <Button
              size="sm"
              variant="ghost"
              className="min-h-11 min-w-11 md:hidden"
              data-testid="ceo-chat-history"
              onClick={() => setHistory(true)}
              aria-label="Earlier chats"
            >
              <History aria-hidden="true" className="size-5" />
            </Button>
            <Button
              size="sm"
              variant="primary"
              data-testid="ceo-chat-new"
              loading={startNew.isPending}
              onClick={newChat}
            >
              <Plus aria-hidden="true" className="size-4" />
              <span>New chat</span>
            </Button>
          </div>
          {notice && (
            <Callout tone="warning" role="alert" data-testid="ceo-chat-busy">
              {notice}
            </Callout>
          )}
          <ErrorBox error={isTurnInFlight(startNew.error) ? null : startNew.error} />
          {!isStanding && standingId && (
            <p className="mb-2 shrink-0 text-xs text-subtle" data-testid="ceo-chat-earlier-note">
              An earlier chat.{' '}
              <button type="button" className="underline" onClick={goStanding}>
                Go to the current chat
              </button>
            </p>
          )}
          <ChatPanel key={threadId} threadId={threadId} {...(prefill ? { initialDraft: prefill } : {})} />
        </div>
      </div>

      <BottomSheet
        open={history}
        onOpenChange={setHistory}
        title="Earlier chats with the CEO"
        testId="ceo-chat-history-sheet"
      >
        <CeoChatHistory chats={ceoChats} threadId={threadId} standingId={standingId} onOpen={open} />
      </BottomSheet>
    </PinnedScreen>
  );
}
