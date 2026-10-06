import { Link, useParams } from 'react-router';
import { useChat } from '../api/queries/chats.ts';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { ConnectionDot, PageHeader, Spinner } from '../components/ui.tsx';

/** A single conversation as a page (phone friendly). */
export function Chat() {
  const { threadId = '' } = useParams();
  const chat = useChat(threadId);
  if (chat.isPending) return <Spinner label="Loading chat" />;
  return (
    <div className="mx-auto flex h-[calc(100dvh-6rem)] max-w-2xl flex-col">
      <PageHeader
        title={chat.data ? `Chat with ${chat.data.agentName}` : 'Chat'}
        sub={
          <span className="flex items-center gap-2">
            {chat.data && <ConnectionDot connected={chat.data.workstationOnline} />}
            <Link to="/desk" className="underline">
              Back to the desk
            </Link>
          </span>
        }
      />
      {chat.data ? (
        <ChatPanel threadId={threadId} />
      ) : (
        <p className="text-sm text-subtle">This conversation was not found.</p>
      )}
    </div>
  );
}
