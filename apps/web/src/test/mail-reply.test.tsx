import type { MailThreadDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardMailReply } from '../components/MailThreadPanel.tsx';

const CARD = '0192f3a0-0000-7000-8000-0000000000c1';
const THREAD = '0192f3a0-0000-7000-8000-0000000000d1';
const INBOX = '0192f3a0-0000-7000-8000-0000000000e1';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const thread = (over: Partial<MailThreadDto> = {}): MailThreadDto => ({
  id: THREAD,
  inboxId: INBOX,
  subject: 'Printer is on fire',
  cardId: CARD,
  cardRef: 'WEB-1',
  messages: [
    {
      id: '0192f3a0-0000-7000-8000-0000000000f1',
      direction: 'in',
      from: 'ana@acme.com',
      fromName: 'Ana',
      to: 'in@x.example',
      subject: 'Printer is on fire',
      text: '<b>Please</b> come and look.',
      at: '2026-10-14T10:00:00.000Z',
      status: 'card_created',
      sentByName: null,
    },
  ],
  replyTo: 'ana@acme.com',
  canReply: true,
  cannotReplyReason: null,
  ...over,
});

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('reply to an e-mail conversation', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the conversation as plain text and sends a reply the person wrote', async () => {
    const sentThread = thread({
      messages: [
        ...thread().messages,
        {
          id: '0192f3a0-0000-7000-8000-0000000000f2',
          direction: 'out',
          from: 'in@x.example',
          fromName: null,
          to: 'ana@acme.com',
          subject: 'Re: Printer is on fire',
          text: 'On our way.',
          at: '2026-10-14T10:05:00.000Z',
          status: 'processed',
          sentByName: 'Pieter',
        },
      ],
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' ? json(sentThread) : json(thread()),
    );
    const user = userEvent.setup();
    wrap(<CardMailReply cardId={CARD} />);
    expect(await screen.findByTestId('mail-message-in')).toHaveTextContent('<b>Please</b> come and look.');
    const send = screen.getByTestId('mail-reply-send');
    expect(send).toBeDisabled();
    await user.type(screen.getByTestId('mail-reply-text'), 'On our way.');
    await user.click(send);
    await waitFor(() => expect(screen.getByTestId('mail-reply-sent')).toHaveTextContent('Sent to ana@acme.com'));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST') as [string, RequestInit];
    expect(post[0]).toContain(`/cards/${CARD}/mail-reply`);
    expect(JSON.parse(String(post[1].body))).toEqual({ text: 'On our way.' });
    expect(await screen.findByTestId('mail-message-out')).toHaveTextContent('Pieter replied');
  });

  it('says why a reply is not possible instead of showing the form', async () => {
    fetchMock.mockResolvedValue(
      json(thread({ canReply: false, cannotReplyReason: 'Only the Owner, Admins and the project owner or managers can reply' })),
    );
    wrap(<CardMailReply cardId={CARD} />);
    expect(await screen.findByText(/Only the Owner, Admins and the project owner/)).toBeInTheDocument();
    expect(screen.queryByTestId('mail-reply-send')).toBeNull();
  });

  it('shows nothing for a card without a stored conversation', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 'not_found', message: 'nope' } }, 404));
    wrap(<CardMailReply cardId={CARD} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('card-mail-reply')).toBeNull();
  });
});
