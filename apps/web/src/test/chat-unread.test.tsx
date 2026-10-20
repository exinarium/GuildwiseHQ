import type { ChatDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { ChatRow } from '../components/chats/ChatRow.tsx';
import { MobileTabBar } from '../components/shell/MobileTabBar.tsx';
import { initSocket } from '../ws/socket.ts';

const THREAD = '0192f3a0-0000-7000-8000-0000000000d1';
const chat = (over: Partial<ChatDto> = {}): ChatDto => ({
  threadId: THREAD,
  title: 'Chat with Ada',
  agentId: '0192f3a0-0000-7000-8000-0000000000a1',
  agentName: 'Ada',
  agentRole: 'builder',
  projectId: null,
  cardId: null,
  cardRef: null,
  workstationOnline: true,
  createdAt: '2026-10-03T10:00:00.000Z',
  lastMessageAt: '2026-10-03T10:05:00.000Z',
  lastMessage: { authorKind: 'agent', body: 'Done.', at: '2026-10-03T10:05:00.000Z' },
  ...over,
});

let calls: string[];
function stubFetch(chats: ChatDto[]) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      const body = u.endsWith('/read')
        ? { chat: chat() }
        : u.startsWith('/api/chats')
          ? { chats }
          : { threadId: THREAD, kind: 'chat', hasMore: false, messages: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}
const setVisibility = (v: 'visible' | 'hidden') =>
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
const readCalls = () => calls.filter((c) => c === `POST /api/chats/${THREAD}/read`);
const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>
);

beforeEach(() => {
  const s = initSocket(new QueryClient());
  s.enableMockTransport();
  s.start();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setVisibility('visible');
});

describe('unread badges', () => {
  it('ChatRow shows the server unread count, capped as 99+, and nothing when read', () => {
    const open = () => {};
    const { rerender } = render(<ChatRow chat={chat({ unreadCount: 3 })} working={false} onOpen={open} />);
    expect(screen.getByTestId('chat-unread')).toHaveTextContent('3');
    rerender(<ChatRow chat={chat({ unreadCount: 99 })} working={false} onOpen={open} />);
    expect(screen.getByTestId('chat-unread')).toHaveTextContent('99+');
    rerender(<ChatRow chat={chat()} working={false} onOpen={open} />);
    expect(screen.queryByTestId('chat-unread')).toBeNull();
  });

  it('the Chats tab shows the total over open chats and not closed ones', async () => {
    stubFetch([
      chat({ unreadCount: 2 }),
      chat({ threadId: '0192f3a0-0000-7000-8000-0000000000d2', unreadCount: 5 }),
      chat({ threadId: '0192f3a0-0000-7000-8000-0000000000d3', unreadCount: 40, archived: true }),
    ]);
    render(
      wrap(
        <MobileTabBar
          counts={{ open: 0, blocking: 0 } as never}
          intake={{ to: '/cards/new', label: 'New' }}
          chatsOpen={false}
          moreOpen={false}
          onChats={() => {}}
          onMore={() => {}}
        />,
      ),
    );
    expect(await screen.findByTestId('tab-chats-badge')).toHaveTextContent('7');
  });
});

describe('marking the open chat read', () => {
  it('posts the read marker once the page is visible and the chat has unread agent messages', async () => {
    stubFetch([chat({ unreadCount: 2 })]);
    render(wrap(<ChatPanel threadId={THREAD} />));
    await screen.findByRole('log', { name: 'Conversation' });
    expect(readCalls()).toHaveLength(0); // debounced
    await waitFor(() => expect(readCalls()).toHaveLength(1), { timeout: 4000 });
  });

  it('does not mark read while the page is hidden, and does once it becomes visible', async () => {
    setVisibility('hidden');
    stubFetch([chat({ unreadCount: 1 })]);
    render(wrap(<ChatPanel threadId={THREAD} />));
    await screen.findByRole('log', { name: 'Conversation' });
    await new Promise((r) => setTimeout(r, 1600));
    expect(readCalls()).toHaveLength(0);
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(readCalls()).toHaveLength(1), { timeout: 4000 });
  });

  it('does nothing for a chat with no unread messages', async () => {
    stubFetch([chat()]);
    render(wrap(<ChatPanel threadId={THREAD} />));
    await screen.findByRole('log', { name: 'Conversation' });
    await new Promise((r) => setTimeout(r, 1600));
    expect(readCalls()).toHaveLength(0);
  });
});
