import type { ChatDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CeoChat } from '../pages/CeoChat.tsx';
import { ceoStatus, Fail, stubApi, U } from './ceo-fixtures.tsx';

// Let the query cache deliver what it has queued (it flushes in a timer) before the test environment is torn down:
// a late flush used to reach react-dom after `window` was gone ("window is not defined", an unhandled error).
afterEach(async () => {
  for (const c of clients.splice(0)) await c.cancelQueries();
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.unstubAllGlobals();
});
const clients: QueryClient[] = [];

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
const mount = (path: string) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/ceo-chat" element={<CeoChat />} />
          <Route path="/ceo-chat/:threadId" element={<CeoChat />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const routes = (extra: Array<[string, () => unknown]> = []): Array<[string, () => unknown]> => [
  ...extra,
  ['GET /api/ceo/status', () => ceoStatus()],
  ['POST /api/ceo/chat/new', () => ({ threadId: U(2) })],
  ['POST /api/ceo/chat', () => ({ threadId: U(1) })],
  ['GET /api/chats', () => ({ chats: [ceoChat(1), ceoChat(2)] })],
  ['GET /api/ceo/chat/state', () => new Fail(404, 'none', 'not_found')],
  ['GET /api/threads', () => ({ threadId: U(1), kind: 'chat', hasMore: false, messages: [] })],
];

describe('CEO chat page', () => {
  it('opens the standing chat at /ceo-chat', async () => {
    stubApi('owner', routes() as never);
    mount('/ceo-chat');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/ceo-chat/${U(1)}`));
    expect(await screen.findByRole('heading', { name: /Chat with Cora/ })).toBeInTheDocument();
  });

  const withMessages = (n: number): ChatDto => ({ ...ceoChat(n), lastMessageAt: '2026-10-03T11:00:00.000Z' });

  it('New chat stays on the current chat when the server returns it (still empty)', async () => {
    const calls = stubApi('owner', routes([['POST /api/ceo/chat/new', () => ({ threadId: U(1) })]]) as never);
    const user = userEvent.setup();
    mount(`/ceo-chat/${U(1)}`);
    await user.click(await screen.findByTestId('ceo-chat-new'));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/ceo/chat/new')).toBe(true));
    expect(screen.getByTestId('where')).toHaveTextContent(`/ceo-chat/${U(1)}`);
  });

  it('New chat starts a fresh thread when the current one has messages', async () => {
    const calls = stubApi(
      'owner',
      routes([['GET /api/chats', () => ({ chats: [withMessages(1), ceoChat(2)] })]]) as never,
    );
    const user = userEvent.setup();
    mount(`/ceo-chat/${U(1)}`);
    await user.click(await screen.findByTestId('ceo-chat-new'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/ceo-chat/${U(2)}`));
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/ceo/chat/new')).toBe(true);
  });

  it('has no separate Clear chat action', async () => {
    stubApi('owner', routes() as never);
    mount(`/ceo-chat/${U(1)}`);
    await screen.findByTestId('ceo-chat-new');
    expect(screen.queryByRole('button', { name: 'More chat actions' })).toBeNull();
  });

  it('tells the user to wait when the CEO is mid-turn (409 turn_in_flight)', async () => {
    stubApi(
      'owner',
      routes([
        ['GET /api/chats', () => ({ chats: [withMessages(1)] })],
        ['POST /api/ceo/chat/new', () => new Fail(409, 'turn in flight', 'turn_in_flight')],
      ]) as never,
    );
    const user = userEvent.setup();
    mount(`/ceo-chat/${U(1)}`);
    await user.click(await screen.findByTestId('ceo-chat-new'));
    expect(await screen.findByTestId('ceo-chat-busy')).toHaveTextContent(/still answering/);
  });

  it('does not call another 409 "still answering"', async () => {
    stubApi(
      'owner',
      routes([
        ['GET /api/chats', () => ({ chats: [withMessages(1)] })],
        ['POST /api/ceo/chat/new', () => new Fail(409, 'something else', 'no_ceo')],
      ]) as never,
    );
    const user = userEvent.setup();
    mount(`/ceo-chat/${U(1)}`);
    await user.click(await screen.findByTestId('ceo-chat-new'));
    await waitFor(() => expect(screen.getByText(/something else/)).toBeInTheDocument());
    expect(screen.queryByTestId('ceo-chat-busy')).toBeNull();
  });

  it('shows nothing to chat with for a non-owner', async () => {
    stubApi('admin', routes() as never);
    mount(`/ceo-chat/${U(1)}`);
    expect(await screen.findByText('No CEO to chat with')).toBeInTheDocument();
    expect(screen.getByText('Only the organization Owner chats with the CEO.')).toBeInTheDocument();
  });

  it('tells the Owner the CEO is not set up yet when there is no CEO row', async () => {
    stubApi(
      'owner',
      routes([['GET /api/ceo/status', () => ceoStatus({ hired: false, agent: null })]]) as never,
    );
    mount(`/ceo-chat/${U(1)}`);
    expect(await screen.findByText('Your CEO is not set up yet. Try again in a moment.')).toBeInTheDocument();
  });
});
