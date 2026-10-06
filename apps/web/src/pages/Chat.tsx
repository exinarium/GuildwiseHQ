import { MessageSquareOff } from 'lucide-react';
import { useParams } from 'react-router';
import { useChat } from '../api/queries/chats.ts';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { AgentAvatar } from '../components/Face.tsx';
import { Avatar, ConnectionDot, EmptyState, PageHeader, PageSkeleton } from '../components/ui.tsx';

/** A single conversation as a page (phone friendly). */
export function Chat() {
  const { threadId = '' } = useParams();
  const chat = useChat(threadId);
  if (chat.isPending) return <PageSkeleton label="Loading chat" panels={1} />;
  return (
    <div className="mx-auto flex h-[calc(100dvh-8.5rem)] min-h-[26rem] max-w-2xl flex-col">
      <PageHeader
        title={chat.data ? `Chat with ${chat.data.agentName}` : 'Chat'}
        back={{ to: '/desk', label: 'Back to the desk' }}
        sub={
          chat.data && (
            <span className="flex items-center gap-2">
              <AgentAvatar agentId={chat.data.agentId} name={chat.data.agentName} size={20} />
              <ConnectionDot connected={chat.data.workstationOnline} />
            </span>
          )
        }
      />
      {chat.data ? (
        <ChatPanel threadId={threadId} />
      ) : (
        <EmptyState
          icon={MessageSquareOff}
          tone="neutral"
          title="Conversation not found"
          description="It may have been removed, or it belongs to another manager."
        />
      )}
    </div>
  );
}
