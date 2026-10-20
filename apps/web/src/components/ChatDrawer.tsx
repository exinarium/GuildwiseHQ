import type { ChatDto } from '@aom/shared';
import * as RadixDialog from '@radix-ui/react-dialog';
import { ArchiveX, ChevronLeft, MessageSquareDashed, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAgents } from '../api/queries/agents.ts';
import {
  useArchiveAllChats,
  useChats,
  useCloseChat,
  useCreateChat,
  useDeleteChat,
  useRestoreChat,
} from '../api/queries/chats.ts';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { useViewportBottomGap } from '../hooks/useViewportBottomGap.ts';
import { ceoChatPath } from '../lib/openCeoChat.ts';
import { useWorkingThreads } from '../ws/socket.ts';
import { ChatPanel } from './ChatPanel.tsx';
import { ChatRow } from './chats/ChatRow.tsx';
import { AgentAvatar } from './Face.tsx';
import {
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

/** Rows whose last message is fetched for the preview (the list scrolls; the rest show it once they are near the top). */
const PREVIEW_ROWS = 40;

const recency = (c: ChatDto) => c.lastMessageAt ?? c.createdAt;

/**
 * Chats: pick any agent you may direct (BA, DevOps, builders...), see earlier conversations, and talk. Replies stream in; an
 * offline workstation is reported on the spot. On a phone it is a full-screen sheet; conversations with the CEO open on
 * the CEO chat page instead of in here.
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
  const mobile = useIsMobile();
  const nav = useNavigate();
  const gap = useViewportBottomGap(mobile && open);
  const chats = useChats();
  const working = useWorkingThreads();
  const create = useCreateChat();
  const [agentId, setAgentId] = useState('');
  const [threadId, setThreadId] = useState<string | null>(null);
  const [view, setView] = useState<'active' | 'archived'>('active');
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<ChatDto | null>(null);
  const close = useCloseChat();
  const archiveAll = useArchiveAllChats();
  const [archivingAll, setArchivingAll] = useState(false);
  const restore = useRestoreChat();
  const remove = useDeleteChat();
  const toast = useToast();
  // DevOps works through the CEO now: it is not offered as someone to chat with (docs/design/ceo-front-door.md section 8).
  const available = (agents.data ?? []).filter((a) => a.status === 'active' && !a.isDevops);
  const current = chats.data?.find((c) => c.threadId === threadId);
  const archivedCount = chats.data?.filter((c) => c.archived).length ?? 0;
  const listed = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (chats.data ?? [])
      .filter((c) => !!c.archived === (view === 'archived'))
      .filter((c) => !q || `${c.agentName} ${c.cardRef ?? ''} ${c.title}`.toLowerCase().includes(q))
      .sort((a, b) => recency(b).localeCompare(recency(a)));
  }, [chats.data, view, query]);
  /** The live CEO chat is never archived by Archive all (the server skips it too). */
  const archivable = listed.filter((c) => c.agentRole !== 'ceo');
  const keep = (chats.data ?? []).filter((c) => c.agentRole === 'ceo' && !c.archived).map((c) => c.threadId);

  const openChat = (c: ChatDto) => {
    if (c.agentRole === 'ceo') {
      onOpenChange(false);
      nav(ceoChatPath(c.threadId));
    } else setThreadId(c.threadId);
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RadixDialog.Content
          aria-label="Chat"
          aria-describedby={undefined}
          style={mobile && gap > 0 ? { bottom: gap } : undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-full flex-col overflow-hidden border-l border-line bg-surface pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] shadow-xl sm:w-[28rem]"
        >
          <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
            {threadId ? (
              <>
                <Button variant="ghost" className="min-h-11 px-2" onClick={() => setThreadId(null)}>
                  <ChevronLeft aria-hidden="true" className="size-5" />
                  Back
                </Button>
                {current && (
                  <>
                    <span className="flex min-w-0 flex-1 items-center gap-2 text-base font-semibold">
                      <AgentAvatar agentId={current.agentId} name={current.agentName} size={24} />
                      <span className="truncate">{current.agentName}</span>
                      <ConnectionDot connected={current.workstationOnline} />
                    </span>
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
                  </>
                )}
              </>
            ) : (
              <RadixDialog.Title className="flex-1 px-2 text-lg font-semibold">Chats</RadixDialog.Title>
            )}
            {threadId && <RadixDialog.Title className="sr-only">Chat</RadixDialog.Title>}
            <RadixDialog.Close asChild>
              <Button variant="ghost" aria-label="Close chat" className="min-h-11 min-w-11 px-2">
                <X aria-hidden="true" className="size-5 sm:hidden" />
                <span className="max-sm:sr-only">Close</span>
              </Button>
            </RadixDialog.Close>
          </div>

          {!threadId ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 flex-col gap-2 border-b border-line bg-surface px-3 py-2.5">
                <form
                  className="flex items-end gap-2"
                  aria-label="Start a chat"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!agentId) return;
                    create.mutate(
                      { agentId, ...(projectId ? { projectId } : {}) },
                      { onSuccess: (c) => openChat(c) },
                    );
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <Select label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                      <option value="">Choose an agent</option>
                      {available.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} ({a.roleKey})
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Button type="submit" variant="primary" disabled={!agentId || create.isPending}>
                    Start chat
                  </Button>
                </form>
                <ErrorBox error={create.error} />
                {(chats.data?.length ?? 0) > 0 && (
                  <>
                    <div className="relative">
                      <Search
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle"
                      />
                      <input
                        type="search"
                        aria-label="Search chats"
                        placeholder="Search chats"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        className="min-h-11 w-full rounded-control border border-control bg-canvas py-1.5 pr-3 pl-9 text-base text-fg placeholder:text-subtle focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 md:min-h-9"
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
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
                      {view === 'active' && archivable.length > 1 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          data-testid="archive-all-chats"
                          onClick={() => setArchivingAll(true)}
                        >
                          <ArchiveX aria-hidden="true" className="size-4" />
                          Archive all ({archivable.length})
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </div>
              <ul
                className="flex min-h-0 flex-1 flex-col divide-y divide-line overflow-y-auto overscroll-contain px-1 py-1"
                data-testid="chat-list"
              >
                {listed.map((c, i) => (
                  <li
                    key={c.threadId}
                    className="flex items-center gap-1"
                    data-testid={`chat-row-${c.agentName}`}
                  >
                    <ChatRow
                      chat={c}
                      ceo={c.agentRole === 'ceo'}
                      working={working.has(c.threadId)}
                      loadPreview={i < PREVIEW_ROWS}
                      onOpen={() => openChat(c)}
                    />
                    <ChatMenu
                      chat={c}
                      onClose={() => close.mutate(c.threadId)}
                      onRestore={() => restore.mutate(c.threadId)}
                      onDelete={() => setDeleting(c)}
                    />
                  </li>
                ))}
                {listed.length === 0 && (
                  <li className="flex flex-col items-center gap-2 px-6 py-12 text-center text-sm text-subtle">
                    <MessageSquareDashed aria-hidden="true" className="size-8" />
                    {query.trim()
                      ? 'No chats match your search.'
                      : view === 'archived'
                        ? 'No archived chats.'
                        : 'No open chats. Choose an agent above to start one.'}
                  </li>
                )}
              </ul>
              <ErrorBox error={close.error ?? restore.error} />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col px-3 pt-2">
              <ChatPanel threadId={threadId} />
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
      <ConfirmDialog
        open={archivingAll}
        onOpenChange={setArchivingAll}
        title={`Archive all ${archivable.length} chats?`}
        description={`They leave this list and move to Archived. Nothing is deleted; restore any of them from there.${keep.length > 0 ? ' Your chat with the CEO stays open.' : ''}`}
        confirmLabel="Archive all"
        pending={archiveAll.isPending}
        onConfirm={() =>
          archiveAll.mutate(keep, {
            onSuccess: (n) => {
              setArchivingAll(false);
              toast.success(`${n} chats archived`);
            },
          })
        }
      >
        <ErrorBox error={archiveAll.error} />
      </ConfirmDialog>
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
