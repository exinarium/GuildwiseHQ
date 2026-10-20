import type { ChatDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CeoChat } from '../pages/CeoChat.tsx';
import { ceoStatus, Fail, stubApi, U } from './ceo-fixtures.tsx';

afterEach(() => vi.unstubAllGlobals());

const ceoChat = (n: number): ChatDto => ({
  threadId: U(n),
  title: 'Chat with Cora',
  agentId: U(70),
  agentName: 'Cora',
  agentRole: 'ceo',
  projectId: null,
  cardId: null,
  cardRef: null,
  workstationOnline: true,
  createdAt: '2026-10-03T10:00:00.000Z',
  lastMessageAt: null,
  archived: false,
  mine: true,
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
const mount = (path: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/ceo-chat" element={<CeoChat />} />
          <Route path="/ceo-chat/:threadId" element={<CeoChat />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const routes = (extra: Array<[string, () => unknown]> = []): Array<[string, () => unknown]> => [
  ['GET /api/ceo/status', () => ceoStatus()],
  ['POST /api/ceo/chat/new', () => ({ threadId: U(2) })],
  ['POST /api/ceo/chat', () => ({ threadId: U(1) })],
  ['GET /api/chats', () => ({ chats: [ceoChat(1), ceoChat(2)] })],
  ['GET /api/ceo/chat/state', () => new Fail(404, 'none', 'not_found')],
  ['GET /api/threads', () => ({ threadId: U(1), kind: 'chat', hasMore: false, messages: [] })],
  ...extra,
];

describe('CEO chat page', () => {
  it('opens the standing chat at /ceo-chat', async () => {
    stubApi('owner', routes() as never);
    mount('/ceo-chat');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/ceo-chat/${U(1)}`));
    expect(await screen.findByRole('heading', { name: /Chat with Cora/ })).toBeInTheDocument();
  });

  it('New chat starts a fresh thread and Clear chat asks before deleting', async () => {
    const del = vi.fn(() => null);
    const calls = stubApi('owner', routes([['DELETE /api/chats', del]]) as never);
    const user = userEvent.setup();
    mount(`/ceo-chat/${U(1)}`);
    await user.click(await screen.findByTestId('ceo-chat-new'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/ceo-chat/${U(2)}`));
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/ceo/chat/new')).toBe(true);
    await user.click(screen.getByTestId('ceo-chat-clear'));
    expect(del).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Clear chat', hidden: false }));
    await waitFor(() => expect(del).toHaveBeenCalled());
  });

  it('shows nothing to chat with for a non-owner', async () => {
    stubApi('admin', routes() as never);
    mount(`/ceo-chat/${U(1)}`);
    expect(await screen.findByText('No CEO to chat with')).toBeInTheDocument();
  });
});
