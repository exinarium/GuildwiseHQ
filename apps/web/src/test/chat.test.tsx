import type { ChatDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel, chatErrorText } from '../components/ChatPanel.tsx';
import { initSocket, type LiveSocket } from '../ws/socket.ts';

const THREAD = '0192f3a0-0000-7000-8000-0000000000d1';
const chat = (online: boolean, projectId: string | null = null): ChatDto => ({
  threadId: THREAD,
  title: 'Chat with Ada',
  agentId: '0192f3a0-0000-7000-8000-0000000000a1',
  agentName: 'Ada',
  agentRole: 'builder',
  projectId,
  cardId: null,
  cardRef: null,
  workstationOnline: online,
  createdAt: '2026-10-03T10:00:00.000Z',
  lastMessageAt: null,
});

let socket: LiveSocket;
let sent: unknown[];
beforeEach(() => {
  const qc = new QueryClient();
  socket = initSocket(qc);
  socket.enableMockTransport();
  socket.start();
  sent = [];
  vi.spyOn(socket, 'send').mockImplementation((m) => void sent.push(m));
  vi.spyOn(socket, 'sendChat').mockImplementation((threadId, body, clientMsgId) => {
    sent.push({ type: 'chat.send', threadId, body, clientMsgId });
    return true;
  });
});
afterEach(() => vi.unstubAllGlobals());

function renderPanel(online: boolean, projectId: string | null = null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = String(url).startsWith('/api/chats')
        ? { chats: [chat(online, projectId)] }
        : { threadId: THREAD, kind: 'chat', hasMore: false, messages: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ChatPanel threadId={THREAD} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ChatPanel', () => {
  it("labels project chats as visible to the project's managers, and org chats not (review low)", async () => {
    const withProject = renderPanel(true, '0192f3a0-0000-7000-8000-0000000000b1');
    expect(await screen.findByTestId('chat-visibility')).toHaveTextContent(
      "visible to this project's managers",
    );
    withProject.unmount();
    renderPanel(true);
    await screen.findByRole('log', { name: 'Conversation' });
    expect(screen.queryByTestId('chat-visibility')).toBeNull();
  });

  it('sends over the socket, streams the reply token by token, and clears when it is done', async () => {
    renderPanel(true);
    await screen.findByRole('log', { name: 'Conversation' });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Message'), 'Hello Ada');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(sent).toEqual([
      { type: 'chat.send', threadId: THREAD, body: 'Hello Ada', clientMsgId: expect.any(String) },
    ]);
    expect(screen.getByTestId('chat-streaming')).toHaveTextContent(/Thinking/);
    // The textarea stays enabled while streaming (disabling it closes the keyboard on iOS); only Send is off.
    expect(screen.getByLabelText('Message')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();

    act(() => socket.handle({ type: 'chat.delta', threadId: THREAD, text: '[mock] Ada ' }));
    act(() => socket.handle({ type: 'chat.delta', threadId: THREAD, text: 'heard: Hello Ada' }));
    expect(screen.getByTestId('chat-streaming')).toHaveTextContent('[mock] Ada heard: Hello Ada');

    act(() =>
      socket.handle({
        type: 'chat.done',
        threadId: THREAD,
        messageId: '0192f3a0-0000-7000-8000-0000000000f1',
      }),
    );
    // The streamed turn stays until the stored message is there (no flicker); the composer is free again at once.
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('chat-streaming')).toBeNull());
    expect(screen.getByLabelText('Message')).toBeEnabled();
  });

  it('stops waiting when the connection drops mid-stream, and the composer is free again', async () => {
    renderPanel(true);
    await screen.findByRole('log', { name: 'Conversation' });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Message'), 'Hello Ada');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    act(() => socket.handle({ type: 'chat.delta', threadId: THREAD, text: 'partial' }));
    expect(screen.getByTestId('chat-streaming')).toBeInTheDocument();
    act(() => (socket as unknown as { dropStreams(): void }).dropStreams());
    expect(screen.queryByTestId('chat-streaming')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getByLabelText('Message')).toBeEnabled();
    expect(socket.getWorking().size).toBe(0);
  });

  it('shows the offline banner when the agent workstation is not connected', async () => {
    renderPanel(false);
    expect(await screen.findByTestId('chat-offline')).toHaveTextContent('Ada is offline');
    expect(screen.getByTestId('chat-offline')).toHaveTextContent('not queued');
  });

  it('reports a workstation_offline error from the server and re-enables the input', async () => {
    renderPanel(true);
    await screen.findByRole('log', { name: 'Conversation' });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Message'), 'anyone?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    act(() => socket.handle({ type: 'chat.error', threadId: THREAD, reason: 'workstation_offline' }));
    expect(screen.getByTestId('chat-error')).toHaveTextContent('workstation is not connected');
    expect(screen.getByTestId('chat-error')).toHaveTextContent('Nothing is queued');
    expect(screen.getByLabelText('Message')).toBeEnabled();
    // The undelivered message is not shown as sent; its text is back in the box.
    expect(screen.queryAllByTestId('chat-message')).toHaveLength(0);
    expect(screen.getByLabelText('Message')).toHaveValue('anyone?');
  });

  it('ignores events of other conversations', async () => {
    renderPanel(true);
    await screen.findByRole('log', { name: 'Conversation' });
    act(() =>
      socket.handle({ type: 'chat.delta', threadId: '0192f3a0-0000-7000-8000-0000000000d9', text: 'x' }),
    );
    expect(screen.queryByTestId('chat-streaming')).toBeNull();
  });

  it('turns known error reasons into text and passes others through', () => {
    expect(chatErrorText('busy')).toContain('still answering');
    expect(chatErrorText('cancelled')).toBe('Stopped.');
    expect(chatErrorText('claude exited with code 1')).toBe('claude exited with code 1');
  });
});
