import type { ChatDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { Composer, enterSends } from '../components/chat/Composer.tsx';
import { Markdown } from '../components/chat/Markdown.tsx';
import { ToolGroup } from '../components/chat/ToolRow.tsx';
import { isNearBottom } from '../components/chat/useStickToBottom.ts';
import {
  applyActivity,
  applyDelta,
  type ChatSegment,
  groupSegments,
  liveStatus,
  parseActivity,
  parseSegments,
  toolKind,
} from '../lib/chatSegments.ts';
import { initSocket, type LiveSocket } from '../ws/socket.ts';

describe('segment parsing and building', () => {
  it('parses segments tolerantly and drops junk', () => {
    expect(
      parseSegments({
        segments: [
          { type: 'text', text: 'hi' },
          { type: 'tool', name: 'Read', status: 'weird' },
          { type: 'x' },
          5,
        ],
      }),
    ).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool', name: 'Read', status: 'ok' },
    ]);
    expect(parseSegments({})).toBeNull();
    expect(parseSegments({ segments: [] })).toBeNull();
  });

  it('parses a chat.activity message and rejects others', () => {
    expect(
      parseActivity({
        type: 'chat.activity',
        threadId: 't',
        seq: 2,
        segment: { type: 'thinking' },
        replace: true,
      }),
    ).toEqual({ threadId: 't', seq: 2, segment: { type: 'thinking' }, replace: true });
    expect(parseActivity({ type: 'chat.delta', threadId: 't' })).toBeNull();
  });

  it('builds a turn: tool, replace by id, empty text placeholder then deltas', () => {
    let s: ChatSegment[] = [];
    s = applyDelta(s, 'Let me look. ');
    s = applyActivity(s, {
      threadId: 't',
      seq: 1,
      segment: { type: 'tool', id: 'a', name: 'Bash', summary: 'pnpm test', status: 'running' },
    });
    expect(liveStatus(s)).toBe('Running pnpm test…');
    s = applyActivity(s, {
      threadId: 't',
      seq: 1,
      replace: true,
      segment: { type: 'tool', id: 'a', name: 'Bash', status: 'ok' },
    });
    expect(s[1]).toMatchObject({ status: 'ok', summary: 'pnpm test' });
    s = applyActivity(s, { threadId: 't', seq: 2, segment: { type: 'text', text: '' } });
    s = applyDelta(s, 'Done');
    expect(s).toHaveLength(3);
    expect(s[2]).toEqual({ type: 'text', text: 'Done' });
  });

  it('groups consecutive tools and maps kinds', () => {
    const t = (n: string): ChatSegment => ({ type: 'tool', name: n, status: 'ok' });
    const g = groupSegments([
      { type: 'text', text: 'a' },
      t('Read'),
      { type: 'thinking' },
      t('Grep'),
      { type: 'text', text: 'b' },
    ]);
    expect(g.map((i) => i.kind)).toEqual(['text', 'tools', 'text']);
    expect(toolKind('mcp__aom__card_create')).toBe('mcp');
    expect(toolKind('Edit')).toBe('edit');
  });
});

describe('Markdown', () => {
  it('renders headings, lists, tables, links and code with a copy button, and no raw HTML', () => {
    render(
      <MemoryRouter>
        <Markdown
          text={
            '# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[x](https://example.com) `inline`\n\n```ts\nconst a = 1;\n```\n\n<script>alert(1)</script>'
          }
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'x' })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });
});

describe('ToolGroup', () => {
  const tools = (n: number): Extract<ChatSegment, { type: 'tool' }>[] =>
    Array.from({ length: n }, (_, i) => ({
      type: 'tool',
      id: String(i),
      name: 'Read',
      summary: `f${i}.ts`,
      status: 'ok',
    }));
  it('shows 2 inline and collapses 3 or more behind "Used N tools"', async () => {
    const { unmount } = render(<ToolGroup tools={tools(2)} />);
    expect(screen.getAllByTestId('tool-row')).toHaveLength(2);
    unmount();
    render(<ToolGroup tools={tools(4)} />);
    expect(screen.queryAllByTestId('tool-row')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: /Used 4 tools/ }));
    expect(screen.getAllByTestId('tool-row')).toHaveLength(4);
  });
});

describe('autoscroll logic', () => {
  it('is near the bottom within the threshold only', () => {
    expect(isNearBottom({ scrollTop: 920, clientHeight: 80, scrollHeight: 1000 })).toBe(true);
    expect(isNearBottom({ scrollTop: 500, clientHeight: 80, scrollHeight: 1000 })).toBe(false);
  });
});

describe('Composer', () => {
  it('Enter sends on desktop, newline on touch; never disables the textarea while busy', async () => {
    expect(enterSends({ key: 'Enter', shiftKey: false }, false)).toBe(true);
    expect(enterSends({ key: 'Enter', shiftKey: true }, false)).toBe(false);
    expect(enterSends({ key: 'Enter', shiftKey: false }, true)).toBe(false);
    expect(enterSends({ key: 'Enter', shiftKey: false, isComposing: true }, false)).toBe(false);
    const send = vi.fn();
    const stop = vi.fn();
    const { rerender } = render(
      <Composer value="hi" onChange={() => {}} onSend={send} onStop={stop} busy={false} />,
    );
    await userEvent.type(screen.getByLabelText('Message'), '{Enter}');
    expect(send).toHaveBeenCalledTimes(1);
    rerender(<Composer value="hi" onChange={() => {}} onSend={send} onStop={stop} busy />);
    expect(screen.getByLabelText('Message')).toBeEnabled();
    await userEvent.type(screen.getByLabelText('Message'), '{Enter}');
    expect(send).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(stop).toHaveBeenCalled();
  });
});

const THREAD = '0192f3a0-0000-7000-8000-0000000000d1';
const AGENT = '0192f3a0-0000-7000-8000-0000000000a1';
const chat: ChatDto = {
  threadId: THREAD,
  title: 'Chat with Ada',
  agentId: AGENT,
  agentName: 'Ada',
  agentRole: 'builder',
  projectId: null,
  cardId: null,
  cardRef: null,
  workstationOnline: true,
  createdAt: '2026-10-03T10:00:00.000Z',
  lastMessageAt: null,
};
const msg = (n: number, authorKind: 'user' | 'agent', body: string, data: Record<string, unknown> = {}) => ({
  id: `0192f3a0-0000-7000-8000-00000000${String(n).padStart(4, '0')}`,
  threadId: THREAD,
  authorKind,
  authorUserId: null,
  authorAgentId: authorKind === 'agent' ? AGENT : null,
  authorName: authorKind === 'agent' ? 'Ada' : null,
  kind: 'comment',
  body,
  data,
  createdAt: `2026-10-03T10:0${n}:00.000Z`,
});

describe('ChatPanel with activity', () => {
  let socket: LiveSocket;
  let pages: Record<string, unknown>;
  beforeEach(() => {
    socket = initSocket(new QueryClient());
    socket.enableMockTransport();
    socket.start();
    vi.spyOn(socket, 'sendChat').mockReturnValue(true);
    localStorage.clear();
    pages = {
      latest: {
        threadId: THREAD,
        kind: 'chat',
        hasMore: true,
        messages: [
          msg(5, 'agent', 'plain **bold** body'),
          msg(6, 'agent', 'ignored', {
            segments: [
              { type: 'text', text: 'Reading' },
              { type: 'tool', name: 'Read', summary: 'a.ts', status: 'ok' },
              { type: 'text', text: 'Done **now**' },
            ],
          }),
        ],
      },
      older: { threadId: THREAD, kind: 'chat', hasMore: false, messages: [msg(1, 'user', 'first question')] },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        const body = u.startsWith('/api/chats')
          ? { chats: [chat] }
          : u.includes('before=')
            ? pages.older
            : pages.latest;
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const mount = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <ChatPanel threadId={THREAD} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('renders old messages as markdown, stored segments as a timeline, and pages in earlier messages', async () => {
    mount();
    expect(await screen.findByText('bold')).toBeInTheDocument();
    expect(screen.getByText('now')).toBeInTheDocument();
    expect(screen.getAllByTestId('tool-row')).toHaveLength(1);
    expect(screen.queryByText('ignored')).toBeNull();
    await userEvent.click(screen.getByTestId('load-older'));
    expect(await screen.findByText('first question')).toBeInTheDocument();
    expect(screen.queryByTestId('load-older')).toBeNull();
  });

  it('shows live tool activity, a status line, and keeps the streamed turn until the stored one arrives', async () => {
    mount();
    await screen.findByRole('log', { name: 'Conversation' });
    await userEvent.type(screen.getByLabelText('Message'), 'go');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    act(() =>
      socket.handle({
        type: 'chat.activity',
        threadId: THREAD,
        seq: 0,
        segment: { type: 'tool', id: 'x', name: 'Bash', summary: 'pnpm test', status: 'running' },
      }),
    );
    expect(screen.getByTestId('chat-live-status')).toHaveTextContent('Running pnpm test…');
    act(() => socket.handle({ type: 'chat.delta', threadId: THREAD, text: 'Result' }));
    const stored = msg(9, 'agent', 'Result', { segments: [{ type: 'text', text: 'Result' }] });
    act(() => socket.handle({ type: 'chat.done', threadId: THREAD, messageId: stored.id, message: stored }));
    expect(screen.queryByTestId('chat-streaming')).toBeNull();
    await waitFor(() => expect(screen.getAllByText('Result').length).toBeGreaterThan(0));
  });

  it('persists the draft per thread', async () => {
    const { unmount } = mount();
    await screen.findByRole('log', { name: 'Conversation' });
    await userEvent.type(screen.getByLabelText('Message'), 'half typed');
    unmount();
    mount();
    await screen.findByRole('log', { name: 'Conversation' });
    expect(screen.getByLabelText('Message')).toHaveValue('half typed');
  });
});
