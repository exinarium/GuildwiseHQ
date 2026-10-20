import type { ChatDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDrawer } from '../components/ChatDrawer.tsx';

vi.mock('../api/queries/agents.ts', () => ({ useAgents: () => ({ data: [] }) }));

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const chat = (n: number, name: string, over: Partial<ChatDto> = {}): ChatDto => ({
  threadId: ID(n),
  title: `Chat with ${name}`,
  agentId: ID(100 + n),
  agentName: name,
  agentRole: 'builder',
  projectId: null,
  cardId: null,
  cardRef: null,
  workstationOnline: true,
  createdAt: '2026-10-03T10:00:00.000Z',
  lastMessageAt: null,
  archived: false,
  mine: true,
  ...over,
});

let list: ChatDto[];
const calls: string[] = [];
beforeEach(() => {
  calls.length = 0;
  list = [
    chat(1, 'Ada'),
    chat(2, 'Bo', { cardId: ID(50), cardRef: 'TOY-5' }),
    chat(3, 'Cy', { archived: true }),
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push(`${method} ${url}`);
      const m = /\/chats\/([^/]+)\/(close|restore)$/.exec(url);
      if (method === 'POST' && m) {
        const c = list.find((x) => x.threadId === m[1]);
        if (c) c.archived = m[2] === 'close';
        return new Response(JSON.stringify({ chat: c }), { status: 200 });
      }
      if (method === 'POST' && url === '/api/chats/archive-all') {
        const except = (JSON.parse(String(init.body ?? '{}')).exceptThreadIds ?? []) as string[];
        let n = 0;
        for (const c of list)
          if (!c.archived && !except.includes(c.threadId)) {
            c.archived = true;
            n++;
          }
        return new Response(JSON.stringify({ archived: n }), { status: 200 });
      }
      if (method === 'DELETE') {
        list = list.filter((x) => !url.endsWith(x.threadId));
        return new Response(null, { status: 204 });
      }
      if (url.startsWith('/api/chats')) return new Response(JSON.stringify({ chats: list }), { status: 200 });
      return new Response('{}', { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const Where = () => <p data-testid="where">{useLocation().pathname}</p>;
const setup = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ChatDrawer open onOpenChange={() => {}} />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const rowMenu = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  const row = await screen.findByTestId(`chat-row-${name}`);
  await user.click(within(row).getByRole('button', { name: `Actions for the chat with ${name}` }));
};

describe('chat list: close and delete', () => {
  it('lists open chats, with archived ones under an Archived filter', async () => {
    const user = userEvent.setup();
    setup();
    expect(await screen.findByTestId('chat-row-Ada')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-row-Cy')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Archived (1)' }));
    expect(screen.getByTestId('chat-row-Cy')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-row-Ada')).toBeNull();
    await rowMenu(user, 'Cy');
    await user.click(await screen.findByRole('menuitem', { name: /Restore to the list/ }));
    await waitFor(() => expect(calls).toContain(`POST /api/chats/${ID(3)}/restore`));
  });

  it('Close moves a chat out of the list', async () => {
    const user = userEvent.setup();
    setup();
    await rowMenu(user, 'Ada');
    await user.click(await screen.findByRole('menuitem', { name: /Close chat/ }));
    await waitFor(() => expect(calls).toContain(`POST /api/chats/${ID(1)}/close`));
    await waitFor(() => expect(screen.queryByTestId('chat-row-Ada')).toBeNull());
  });

  it('Delete asks first and is removed for good', async () => {
    const user = userEvent.setup();
    setup();
    await rowMenu(user, 'Ada');
    await user.click(await screen.findByRole('menuitem', { name: /Delete chat/ }));
    const dlg = await screen.findByRole('dialog', { name: /Delete the chat with Ada/ });
    expect(dlg).toHaveTextContent('cannot be undone');
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    await user.click(within(dlg).getByRole('button', { name: 'Delete chat' }));
    await waitFor(() => expect(calls).toContain(`DELETE /api/chats/${ID(1)}`));
    await waitFor(() => expect(screen.queryByTestId('chat-row-Ada')).toBeNull());
  });

  it('a chat linked to a card cannot be deleted, only closed', async () => {
    const user = userEvent.setup();
    setup();
    await rowMenu(user, 'Bo');
    const del = await screen.findByRole('menuitem', { name: /Delete chat/ });
    expect(del).toHaveAttribute('aria-disabled', 'true');
    expect(del).toHaveTextContent("stays in the card's history");
  });
});

describe('chat list: archive all', () => {
  it('asks first, then archives every open chat with one request and keeps them under Archived', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByTestId('archive-all-chats'));
    expect(calls.some((c) => c.endsWith('/archive-all'))).toBe(false);
    await user.click(await screen.findByRole('button', { name: 'Archive all' }));
    await waitFor(() => expect(calls).toContain('POST /api/chats/archive-all'));
    expect(calls.filter((c) => c.endsWith('/close'))).toHaveLength(0);
    await waitFor(() => expect(screen.queryByTestId('chat-row-Ada')).toBeNull());
  });

  it('never offers to archive the live CEO chat, and sends it as an exception', async () => {
    list.push(chat(9, 'Cora', { agentRole: 'ceo' }));
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByTestId('archive-all-chats'));
    expect(await screen.findByRole('dialog', { name: 'Archive all 2 chats?' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Archive all' }));
    await waitFor(() => expect(calls).toContain('POST /api/chats/archive-all'));
    expect(screen.getByTestId('chat-row-Cora')).toBeInTheDocument();
  });

  it('opens a CEO chat on the CEO chat page, not inline', async () => {
    list.push(chat(9, 'Cora', { agentRole: 'ceo' }));
    const user = userEvent.setup();
    setup();
    await user.click(
      within(await screen.findByTestId('chat-row-Cora')).getAllByRole('button')[0] as HTMLElement,
    );
    expect(screen.queryByTestId('chat-panel')).toBeNull();
    expect(screen.getByTestId('where')).toHaveTextContent(`/ceo-chat/${ID(9)}`);
  });
});
