import { MessageSquareOff } from 'lucide-react';
import { Navigate, useLocation, useParams } from 'react-router';
import { useChat } from '../api/queries/chats.ts';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { AgentAvatar } from '../components/Face.tsx';
import { PinnedScreen } from '../components/PinnedScreen.tsx';
import { ConnectionDot, EmptyState, PageSkeleton } from '../components/ui.tsx';
import { type CeoChatLocationState, ceoChatPath } from '../lib/openCeoChat.ts';
import { usePageTitle } from '../lib/usePageTitle.ts';

/** A single conversation as a page (phone friendly). CEO threads live on the CEO chat page and are redirected there. */
export function Chat() {
  const { threadId = '' } = useParams();
  const chat = useChat(threadId);
  const location = useLocation();
  const prefill = (location.state as CeoChatLocationState | null)?.ceoPrefill;
  const title = chat.data ? `Chat with ${chat.data.agentName}` : 'Chat';
  usePageTitle(title);
  if (chat.isPending) return <PageSkeleton label="Loading chat" panels={1} />;
  if (chat.data?.agentRole === 'ceo')
    return <Navigate to={ceoChatPath(threadId)} replace state={location.state} />;
  return (
    <PinnedScreen
      desktopClassName="mx-auto h-[calc(100dvh-8.5rem)] min-h-[26rem] max-w-2xl"
      testId="chat-screen"
    >
      <header className="mb-2 flex shrink-0 items-center gap-2.5 border-b border-line pb-2">
        {chat.data && <AgentAvatar agentId={chat.data.agentId} name={chat.data.agentName} size={32} />}
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-fg">{title}</h1>
        {chat.data && <ConnectionDot connected={chat.data.workstationOnline} />}
      </header>
      {chat.data ? (
        <ChatPanel threadId={threadId} {...(prefill ? { initialDraft: prefill } : {})} />
      ) : (
        <EmptyState
          icon={MessageSquareOff}
          tone="neutral"
          title="Conversation not found"
          description="It may have been removed, or it belongs to another manager."
        />
      )}
    </PinnedScreen>
  );
}
