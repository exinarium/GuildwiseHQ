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
    await waitFor(() =>
      expect(screen.getByTestId('mail-reply-sent')).toHaveTextContent('Sent to ana@acme.com'),
    );
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST') as [string, RequestInit];
    expect(post[0]).toContain(`/cards/${CARD}/mail-reply`);
    expect(JSON.parse(String(post[1].body))).toEqual({ text: 'On our way.' });
    expect(await screen.findByTestId('mail-message-out')).toHaveTextContent('Pieter replied');
  });

  it('says why a reply is not possible instead of showing the form', async () => {
    fetchMock.mockResolvedValue(
      json(
        thread({
          canReply: false,
          cannotReplyReason: 'Only the Owner, Admins and the project owner or managers can reply',
        }),
      ),
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

describe('Draft with BA', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const draft = (status: string, over: Record<string, unknown> = {}) => ({
    id: '0192f3a0-0000-7000-8000-0000000000a1',
    status,
    text: null,
    subject: null,
    error: null,
    createdAt: '2026-10-14T10:10:00.000Z',
    ...over,
  });
  /** Routes the card's thread, its draft (the state is `current`) and the draft/reply posts. */
  function routes(current: { draft: unknown }) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const post = init?.method === 'POST';
      if (String(url).endsWith('/mail-draft')) return json({ draft: post ? draft('queued') : current.draft });
      if (String(url).endsWith('/mail-reply')) return json(thread());
      return json(thread());
    });
  }

  it('asks for a draft, says the BA is writing, and puts the draft in the box to edit; nothing is sent', async () => {
    const current: { draft: unknown } = { draft: null };
    routes(current);
    const user = userEvent.setup();
    wrap(<CardMailReply cardId={CARD} />);
    await screen.findByTestId('mail-message-in');
    await user.click(screen.getByTestId('mail-draft-ask'));
    expect(await screen.findByTestId('mail-draft-working')).toHaveTextContent(
      'nothing is sent until you press Send',
    );
    expect(screen.getByTestId('mail-draft-ask')).toBeDisabled();
    const ask = fetchMock.mock.calls.find(
      ([u, init]) => init?.method === 'POST' && String(u).endsWith('/mail-draft'),
    );
    expect(ask?.[0]).toContain(`/cards/${CARD}/mail-draft`);
    // the BA finishes: the next poll brings the draft
    current.draft = draft('done', { text: 'Hello Ana,\n\nI will send someone today.\n\nPat' });
    await waitFor(
      () =>
        expect(screen.getByTestId('mail-reply-text')).toHaveValue(
          'Hello Ana,\n\nI will send someone today.\n\nPat',
        ),
      { timeout: 8000 },
    );
    expect(screen.getByTestId('mail-draft-note')).toHaveTextContent('Drafted by the BA');
    expect(
      fetchMock.mock.calls.some(([u, init]) => init?.method === 'POST' && String(u).endsWith('/mail-reply')),
    ).toBe(false);
    // the person changes it and sends: the reply records that it started from the BA's draft
    await user.type(screen.getByTestId('mail-reply-text'), ' Thanks.');
    await user.click(screen.getByTestId('mail-reply-send'));
    await waitFor(() => expect(screen.getByTestId('mail-reply-sent')).toBeInTheDocument());
    const send = fetchMock.mock.calls.find(
      ([u, init]) => init?.method === 'POST' && String(u).endsWith('/mail-reply'),
    ) as [string, RequestInit];
    expect(JSON.parse(String(send[1].body))).toEqual({
      text: 'Hello Ana,\n\nI will send someone today.\n\nPat Thanks.',
      draftedBy: 'ba',
    });
  }, 20_000);

  it('a reply the person wrote themselves is not marked as drafted', async () => {
    routes({ draft: null });
    const user = userEvent.setup();
    wrap(<CardMailReply cardId={CARD} />);
    await screen.findByTestId('mail-message-in');
    await user.type(screen.getByTestId('mail-reply-text'), 'On our way.');
    await user.click(screen.getByTestId('mail-reply-send'));
    await waitFor(() => expect(screen.getByTestId('mail-reply-sent')).toBeInTheDocument());
    const send = fetchMock.mock.calls.find(
      ([u, init]) => init?.method === 'POST' && String(u).endsWith('/mail-reply'),
    ) as [string, RequestInit];
    expect(JSON.parse(String(send[1].body))).toEqual({ text: 'On our way.' });
  });

  it('shows why no draft came and offers it again', async () => {
    routes({
      draft: draft('failed', {
        error: 'No BA was available to write the draft. Try again, or write the reply yourself.',
      }),
    });
    wrap(<CardMailReply cardId={CARD} />);
    expect(await screen.findByTestId('mail-draft-failed')).toHaveTextContent('write the reply yourself');
    expect(screen.getByTestId('mail-draft-ask')).toBeEnabled();
  });

  it('does not overwrite what the person already typed: it offers the draft instead', async () => {
    const current: { draft: unknown } = { draft: null };
    routes(current);
    const user = userEvent.setup();
    wrap(<CardMailReply cardId={CARD} />);
    await screen.findByTestId('mail-message-in');
    await user.type(screen.getByTestId('mail-reply-text'), 'My own words');
    await user.click(screen.getByTestId('mail-draft-ask'));
    current.draft = draft('done', { text: 'The BA wrote this.' });
    const use = await screen.findByTestId('mail-draft-use', {}, { timeout: 8000 });
    expect(screen.getByTestId('mail-reply-text')).toHaveValue('My own words');
    await user.click(use);
    expect(screen.getByTestId('mail-reply-text')).toHaveValue('The BA wrote this.');
  }, 20_000);
});
