import type { ChatDto } from '@aom/shared';
import * as RadixDialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useAgents } from '../api/queries/agents.ts';
import {
  useChats,
  useCloseChat,
  useCreateChat,
  useDeleteChat,
  useRestoreChat,
} from '../api/queries/chats.ts';
import { ChatPanel } from './ChatPanel.tsx';
import { AgentAvatar } from './Face.tsx';
import {
  Avatar,
  Button,
  ConfirmDialog,
  ConnectionDot,
  ErrorBox,
  Menu,
  MenuItem,
  Segmented,
  Select,
  useToast,
} from './ui.tsx';

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
  const [view, setView] = useState<'active' | 'archived'>('active');
  const [deleting, setDeleting] = useState<ChatDto | null>(null);
  const close = useCloseChat();
  const restore = useRestoreChat();
  const remove = useDeleteChat();
  const toast = useToast();
  const available = (agents.data ?? []).filter((a) => a.status === 'active');
  const current = chats.data?.find((c) => c.threadId === threadId);
  const archivedCount = chats.data?.filter((c) => c.archived).length ?? 0;
  const listed = (chats.data ?? []).filter((c) => !!c.archived === (view === 'archived'));

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
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-muted">Earlier conversations</h3>
                    {(archivedCount > 0 || view === 'archived') && (
                      <Segmented
                        label="Show chats"
                        value={view}
                        onChange={setView}
                        options={[
                          { value: 'active', label: 'Open' },
                          {
                            value: 'archived',
                            label: `Archived${archivedCount ? ` (${archivedCount})` : ''}`,
                          },
                        ]}
                      />
                    )}
                  </div>
                  <ul className="flex flex-col gap-1" data-testid="chat-list">
                    {listed.map((c) => (
                      <li
                        key={c.threadId}
                        className="flex items-center gap-1"
                        data-testid={`chat-row-${c.agentName}`}
                      >
                        <button
                          type="button"
                          onClick={() => setThreadId(c.threadId)}
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-control border border-line px-2 py-1.5 text-left text-sm hover:bg-sunken"
                        >
                          <AgentAvatar agentId={c.agentId} name={c.agentName} size={20} />
                          <span className="min-w-0 flex-1 truncate">
                            {c.agentName}
                            {c.cardRef && (
                              <span className="ml-1.5 font-mono text-xs text-subtle">{c.cardRef}</span>
                            )}
                          </span>
                          <ConnectionDot connected={c.workstationOnline} />
                        </button>
                        <ChatMenu
                          chat={c}
                          onClose={() => close.mutate(c.threadId)}
                          onRestore={() => restore.mutate(c.threadId)}
                          onDelete={() => setDeleting(c)}
                        />
                      </li>
                    ))}
                    {listed.length === 0 && (
                      <li className="rounded-control border border-dashed border-control/60 px-3 py-4 text-center text-sm text-subtle">
                        {view === 'archived' ? 'No archived chats.' : 'No open chats. Start one above.'}
                      </li>
                    )}
                  </ul>
                  <ErrorBox error={close.error ?? restore.error} />
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
                  <>
                    <span className="flex min-w-0 items-center gap-1.5 font-medium">
                      <AgentAvatar agentId={current.agentId} name={current.agentName} size={20} />
                      <span className="truncate">{current.agentName}</span>
                      <ConnectionDot connected={current.workstationOnline} />
                    </span>
                    <span className="ml-auto">
                      <ChatMenu
                        chat={current}
                        onClose={() =>
                          close.mutate(current.threadId, {
                            onSuccess: () => {
                              setThreadId(null);
                              toast.success('Chat closed. Find it under Archived.');
                            },
                          })
                        }
                        onRestore={() => restore.mutate(current.threadId)}
                        onDelete={() => setDeleting(current)}
                      />
                    </span>
                  </>
                )}
              </div>
              <ChatPanel threadId={threadId} />
            </>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete the chat with ${deleting?.agentName ?? 'this agent'}?`}
        description="The whole conversation is removed for good. This cannot be undone."
        confirmLabel="Delete chat"
        pending={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.threadId, {
            onSuccess: () => {
              if (threadId === deleting.threadId) setThreadId(null);
              setDeleting(null);
              toast.success('Chat deleted');
            },
          })
        }
      >
        <ErrorBox error={remove.error} />
      </ConfirmDialog>
    </RadixDialog.Root>
  );
}

/** Close or restore a chat, or delete it (a chat linked to a card is card history: it can only be closed). */
function ChatMenu({
  chat,
  onClose,
  onRestore,
  onDelete,
}: {
  chat: ChatDto;
  onClose: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const linked = !!chat.cardId;
  return (
    <Menu label={`Actions for the chat with ${chat.agentName}`}>
      {chat.archived ? (
        <MenuItem onSelect={onRestore}>Restore to the list</MenuItem>
      ) : (
        <MenuItem onSelect={onClose} description="Hide it from the list; find it under Archived">
          Close chat
        </MenuItem>
      )}
      {chat.mine !== false && (
        <MenuItem
          danger
          disabled={linked}
          onSelect={onDelete}
          description={
            linked
              ? `Linked to ${chat.cardRef ?? 'a card'}: it stays in the card's history`
              : 'Remove it for good'
          }
        >
          Delete chat
        </MenuItem>
      )}
    </Menu>
  );
}
