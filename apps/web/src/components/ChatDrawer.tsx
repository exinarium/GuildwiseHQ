import * as RadixDialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useAgents } from '../api/queries/agents.ts';
import { useChats, useCreateChat } from '../api/queries/chats.ts';
import { ChatPanel } from './ChatPanel.tsx';
import { Avatar, Button, ConnectionDot, ErrorBox, Select } from './ui.tsx';

/**
 * Chat from the decision desk: pick any agent you may direct (BA, DevOps, builders...), see earlier conversations,
 * and talk. Replies stream in; an offline workstation is reported on the spot.
 */
export function ChatDrawer({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId?: string;
}) {
  const agents = useAgents();
  const chats = useChats();
  const create = useCreateChat();
  const [agentId, setAgentId] = useState('');
  const [threadId, setThreadId] = useState<string | null>(null);
  const available = (agents.data ?? []).filter((a) => a.status === 'active');
  const current = chats.data?.find((c) => c.threadId === threadId);

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RadixDialog.Content
          aria-label="Chat"
          className="fixed inset-y-0 right-0 z-50 flex w-full flex-col gap-3 border-l border-line bg-surface p-4 shadow-xl sm:w-[28rem]"
        >
          <div className="flex items-center justify-between">
            <RadixDialog.Title className="text-base font-semibold">Chat</RadixDialog.Title>
            <RadixDialog.Close asChild>
              <Button variant="ghost" aria-label="Close chat">
                Close
              </Button>
            </RadixDialog.Close>
          </div>
          <RadixDialog.Description className="sr-only">
            Talk to an agent directly. Messages stream through the agent's workstation.
          </RadixDialog.Description>

          {!threadId ? (
            <div className="flex flex-col gap-3">
              <form
                className="flex flex-col gap-2"
                aria-label="Start a chat"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!agentId) return;
                  create.mutate(
                    { agentId, ...(projectId ? { projectId } : {}) },
                    { onSuccess: (c) => setThreadId(c.threadId) },
                  );
                }}
              >
                <Select label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  <option value="">Choose an agent</option>
                  {available.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.roleKey}
                      {a.isDevops ? ', DevOps' : ''})
                    </option>
                  ))}
                </Select>
                <ErrorBox error={create.error} />
                <Button type="submit" variant="primary" disabled={!agentId || create.isPending}>
                  Start chat
                </Button>
              </form>
              {(chats.data?.length ?? 0) > 0 && (
                <div>
                  <h3 className="mb-1 text-sm font-semibold text-muted">Earlier conversations</h3>
                  <ul className="flex flex-col gap-1" data-testid="chat-list">
                    {chats.data?.map((c) => (
                      <li key={c.threadId}>
                        <button
                          type="button"
                          onClick={() => setThreadId(c.threadId)}
                          className="flex w-full items-center gap-2 rounded-control border border-line px-2 py-1.5 text-left text-sm hover:bg-sunken"
                        >
                          <Avatar name={c.agentName} size={20} />
                          <span className="flex-1 truncate">{c.agentName}</span>
                          <ConnectionDot connected={c.workstationOnline} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm">
                <Button variant="ghost" onClick={() => setThreadId(null)}>
                  Back
                </Button>
                {current && (
                  <span className="flex items-center gap-1.5 font-medium">
                    <Avatar name={current.agentName} size={20} />
                    {current.agentName}
                    <ConnectionDot connected={current.workstationOnline} />
                  </span>
                )}
              </div>
              <ChatPanel threadId={threadId} />
            </>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
