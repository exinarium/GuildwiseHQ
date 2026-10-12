import type { MailInboxDto, MailMessageDto, ScheduleDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailInboxTab, messageOutcome } from '../components/orgsettings/MailInboxTab.tsx';
import { MAIL_TOKENS, MappingEditor } from '../components/schedules/MappingEditor.tsx';
import {
  buildScheduleRequest,
  describeTrigger,
  emptyWizard,
  stateFromSchedule,
  TRIGGER_TILES,
  type WizardState,
} from '../lib/schedules.ts';
import { Automations } from '../pages/Automations.tsx';
import { PlatformInbound } from '../pages/platform/PlatformInbound.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

const inbox: MailInboxDto = {
  id: ID(60),
  label: 'Support',
  address: 'acme-k3x9p2m7qd@in.guildwise.test',
  enabled: true,
  projectId: null,
  allowList: ['@vip.com'],
  createdAt: '2026-10-12T08:00:00.000Z',
  lastReceivedAt: '2026-10-12T09:00:00.000Z',
  last24h: { received: 3, skipped: 1 },
};
const msg = (n: number, over: Partial<MailMessageDto> = {}): MailMessageDto => ({
  id: ID(70 + n),
  inboxId: inbox.id,
  threadId: ID(80 + n),
  from: 'ana@acme.com',
  fromName: 'Ana',
  subject: `Subject ${n}`,
  receivedAt: '2026-10-12T09:00:00.000Z',
  status: 'draft_created',
  reason: null,
  reasonText: null,
  cardId: ID(90 + n),
  cardRef: `WEB-${n}`,
  auth: 'pass',
  allowListed: false,
  attachments: 0,
  isReply: false,
  ...over,
});
const messages = [
  msg(1),
  msg(2, { status: 'card_created', cardRef: 'WEB-2', allowListed: true }),
  msg(3, {
    status: 'skipped',
    reason: 'spam',
    reasonText: 'Looked like spam',
    cardId: null,
    cardRef: null,
    auth: 'unknown',
  }),
  msg(4, { status: 'comment_added', cardRef: 'WEB-1', isReply: true, attachments: 2 }),
];

let calls: Array<{ method: string; url: string; body: unknown }>;
let role: 'owner' | 'admin' = 'owner';
let configured = true;
let inboxes: MailInboxDto[];

beforeEach(() => {
  calls = [];
  role = 'owner';
  configured = true;
  inboxes = [inbox];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (method !== 'GET')
        calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/mail-inboxes' && method === 'GET')
        return json({
          configured,
          domain: configured ? 'in.guildwise.test' : null,
          inboxes: configured ? inboxes : [],
        });
      if (url === '/api/mail-inboxes' && method === 'POST')
        return json({ ...inbox, id: ID(61), label: 'Orders' }, 201);
      if (url.endsWith('/rotate')) return json({ ...inbox, address: 'acme-newaddress1@in.guildwise.test' });
      if (url.includes('/messages')) return json({ messages });
      if (url.startsWith('/api/mail-inboxes/') && method === 'PATCH') {
        const b = JSON.parse(String(init.body));
        return json({ ...inbox, ...b });
      }
      if (url === '/api/platform/inbound')
        return json({
          provider: 'postmark',
          domain: 'in.guildwise.test',
          configured: true,
          secretSet: true,
          inboxes: 2,
          lastReceivedAt: '2026-10-12T09:00:00.000Z',
          last24h: {
            received: 12,
            skipped: 3,
            skippedByReason: { spam: 2, rate_limited: 1 },
            unknownAddress: 4,
            authFailed: 0,
          },
          limits: { maxMessageBytes: 10_000_000, ratePerHourPerOrg: 60, spamThreshold: 5 },
        });
      if (url.startsWith('/api/auth/me'))
        return json({
          user: { id: ID(900), displayName: 'Pieter', email: 'p@x.test' },
          isAdmin: role === 'owner',
          visibleProjectIds: [],
          activeOrg: {
            id: ID(1),
            name: 'Acme',
            role,
            status: 'active',
            plan: 'team',
            planName: 'Team',
            features: {},
          },
        });
      if (url.startsWith('/api/schedules')) return json({ schedules: [], system: [] });
      if (url.startsWith('/api/projects')) return json({ projects: [] });
      if (url.startsWith('/api/workstations')) return json({ workstations: [] });
      if (url.startsWith('/api/workflows')) return json({ workflows: [] });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const wrap = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

describe('Organization > E-mail inbox', () => {
  it('shows the address with a copy button, the allow-list and what became of each message', async () => {
    const user = userEvent.setup();
    wrap(<MailInboxTab orgRole="owner" />);
    const card = await screen.findByTestId('mail-inbox');
    expect(within(card).getByTestId('inbox-address')).toHaveTextContent(inbox.address);
    await user.click(within(card).getByRole('button', { name: /Copy the address of Support/ }));
    expect(await navigator.clipboard.readText()).toBe(inbox.address);
    expect(within(card).getByText('@vip.com')).toBeInTheDocument();
    const list = await within(card).findByTestId('inbox-messages');
    const statuses = within(list)
      .getAllByTestId('message-status')
      .map((e) => e.textContent);
    expect(statuses).toEqual([
      'Draft card created WEB-1',
      'Card created WEB-2',
      'Skipped: Looked like spam',
      'Added to a card WEB-1',
    ]);
    expect(within(list).getByText(/2 attachments \(not kept\)/)).toBeInTheDocument();
    expect(within(card).getByText(/forward every message to the\s+address above/)).toBeInTheDocument();
  });

  it('the Owner adds a sender or a domain to the allow-list, and removes one', async () => {
    const user = userEvent.setup();
    wrap(<MailInboxTab orgRole="owner" />);
    const list = await screen.findByTestId('allow-list');
    await user.type(within(list).getByLabelText('Add a sender or domain'), 'Ana@Acme.com');
    await user.click(within(list).getByTestId('allow-add'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        allowList: ['@vip.com', 'ana@acme.com'],
      }),
    );
    await user.click(within(list).getByRole('button', { name: 'Remove @vip.com' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'PATCH')[1]?.body).toEqual({ allowList: [] });
  });

  it('refuses text that is neither an address nor a domain, before asking the server', async () => {
    const user = userEvent.setup();
    wrap(<MailInboxTab orgRole="owner" />);
    const list = await screen.findByTestId('allow-list');
    await user.type(within(list).getByLabelText('Add a sender or domain'), 'not an address');
    await user.click(within(list).getByTestId('allow-add'));
    expect(await within(list).findByText(/Enter an address/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('an Admin sees the allow-list but cannot change it', async () => {
    wrap(<MailInboxTab orgRole="admin" />);
    const list = await screen.findByTestId('allow-list');
    expect(within(list).getByText('@vip.com')).toBeInTheDocument();
    expect(within(list).queryByTestId('allow-add')).toBeNull();
    expect(within(list).queryByRole('button', { name: /^Remove/ })).toBeNull();
    expect(within(list).getByText(/Only the Owner can change this list/)).toBeInTheDocument();
  });

  it('makes a new address only after a confirmation', async () => {
    const user = userEvent.setup();
    wrap(<MailInboxTab orgRole="owner" />);
    await user.click(await screen.findByTestId('rotate-inbox'));
    expect(calls).toHaveLength(0);
    await user.click(await screen.findByRole('button', { name: 'Make a new address' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/mail-inboxes/${inbox.id}/rotate`)).toBe(true),
    );
  });

  it('makes an inbox, and says so when the platform has no mail provider yet', async () => {
    const user = userEvent.setup();
    wrap(<MailInboxTab orgRole="owner" />);
    await screen.findByTestId('mail-inbox');
    await user.clear(screen.getByLabelText('Name of a new inbox'));
    await user.type(screen.getByLabelText('Name of a new inbox'), 'Orders');
    await user.click(screen.getByTestId('create-inbox'));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/mail-inboxes')?.body).toEqual({ label: 'Orders' }),
    );
  });

  it('shows a notice instead of a form when inbound mail is not set up', async () => {
    configured = false;
    wrap(<MailInboxTab orgRole="owner" />);
    expect(await screen.findByText(/not switched on for this platform yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('create-inbox')).toBeNull();
  });

  it('describes outcomes in words', () => {
    expect(messageOutcome(messages[2] as MailMessageDto)).toBe('Skipped: Looked like spam');
    expect(messageOutcome(messages[1] as MailMessageDto)).toBe('Card created WEB-2');
  });
});

describe('automations for e-mail', () => {
  const ctx = { workflow: undefined, mockUi: false, myEmail: 'p@x.test' };
  const regression = (over: Partial<WizardState>): WizardState =>
    emptyWizard({ name: 'Mail', tile: 'regression_run', projectId: ID(10), ...over });

  it('has trigger tiles for new mail and for replies, and they read in plain words', () => {
    expect(TRIGGER_TILES.map((t) => t.id)).toEqual(expect.arrayContaining(['email_received', 'email_reply']));
    expect(describeTrigger({ kind: 'email_received', inboxId: ID(60) })).toBe('When an e-mail arrives');
    expect(
      describeTrigger({
        kind: 'email_received',
        inboxId: ID(60),
        from: ['@acme.com'],
        subjectContains: 'order',
      }),
    ).toBe('When an e-mail arrives (from @acme.com, subject contains "order")');
    expect(describeTrigger({ kind: 'email_reply', inboxId: ID(60) })).toBe(
      'When a reply to a card e-mail arrives',
    );
  });

  it('builds the trigger with the inbox, the normalised senders and the subject word', () => {
    const r = buildScheduleRequest(
      regression({
        triggerKind: 'email_received',
        inboxId: ID(60),
        mailFrom: 'Ana@Acme.com, acme.org',
        mailSubject: ' order ',
      }),
      ctx,
    );
    expect(r.body?.trigger).toEqual({
      kind: 'email_received',
      inboxId: ID(60),
      from: ['ana@acme.com', '@acme.org'],
      subjectContains: 'order',
    });
    expect(
      buildScheduleRequest(regression({ triggerKind: 'email_reply', inboxId: ID(60) }), ctx).body?.trigger,
    ).toEqual({ kind: 'email_reply', inboxId: ID(60) });
  });

  it('needs an inbox and valid sender entries', () => {
    expect(
      buildScheduleRequest(regression({ triggerKind: 'email_received' }), ctx).errors.inboxId,
    ).toBeTruthy();
    expect(
      buildScheduleRequest(
        regression({ triggerKind: 'email_received', inboxId: ID(60), mailFrom: 'bad entry' }),
        ctx,
      ).errors.mailFrom,
    ).toBeTruthy();
  });

  it('an existing mail automation comes back into the form', () => {
    const s = {
      id: ID(20),
      name: 'Mail',
      enabled: true,
      projectId: ID(10),
      trigger: { kind: 'email_received', inboxId: ID(60), from: ['@acme.com'], subjectContains: 'order' },
      action: {
        kind: 'create_card',
        projectId: ID(10),
        template: { title: 'x', fields: {}, mapping: { title: '{email.subject}' }, start: 'draft' },
        dedupe: 'thread',
      },
    } as unknown as ScheduleDto;
    expect(stateFromSchedule(s)).toMatchObject({
      triggerKind: 'email_received',
      inboxId: ID(60),
      mailFrom: '@acme.com',
      mailSubject: 'order',
      start: 'draft',
      dedupe: 'thread',
      mapping: [{ target: 'title', text: '{email.subject}' }],
    });
  });

  function Harness({ mail }: { mail: boolean }) {
    const [rows, setRows] = useState<WizardState['mapping']>([{ target: 'context', text: 'From: ' }]);
    return (
      <>
        <MappingEditor rows={rows} onChange={setRows} mail={mail} />
        <output data-testid="rows">{JSON.stringify(rows)}</output>
      </>
    );
  }

  it('the mapping editor offers the email tokens for mail triggers (and not the card ones)', async () => {
    const user = userEvent.setup();
    render(<Harness mail />);
    const tokens = within(screen.getByTestId('mapping-tokens'));
    for (const t of MAIL_TOKENS) expect(tokens.getByText(`{${t}}`)).toBeInTheDocument();
    for (const t of ['email.subject', 'email.from', 'email.body', 'email.date', 'email.thread'])
      expect(MAIL_TOKENS).toContain(t);
    expect(tokens.queryByText('{card.ref}')).toBeNull();
    await user.click(tokens.getByText('{email.from}'));
    expect(JSON.parse(screen.getByTestId('rows').textContent ?? '[]')).toEqual([
      { target: 'context', text: 'From: {email.from}' },
    ]);
  });

  it('other triggers still get no email tokens', () => {
    render(<Harness mail={false} />);
    expect(screen.queryByText('{email.subject}')).toBeNull();
  });

  it('the wizard lists the mail tiles; choosing one asks for the inbox and fills a draft mapping', async () => {
    const user = userEvent.setup();
    wrap(<Automations />);
    await user.click(await screen.findByTestId('new-schedule'));
    const wizard = await screen.findByTestId('schedule-wizard');
    expect(within(wizard).getByTestId('tile-email_received')).toBeInTheDocument();
    expect(within(wizard).getByTestId('tile-email_reply')).toBeInTheDocument();
    await user.click(within(wizard).getByTestId('tile-email_received'));
    const fields = await within(wizard).findByTestId('mail-trigger-fields');
    const select = within(fields).getByLabelText('Inbox');
    await within(select).findByRole('option', { name: /Support/ });
    await user.selectOptions(select, ID(60));
    expect(within(fields).getByLabelText('Only from (optional)')).toBeInTheDocument();
    // moving on without an inbox is not possible
    await user.selectOptions(select, '');
    await user.click(screen.getByTestId('wizard-next'));
    expect(await within(wizard).findByText('Choose the inbox')).toBeInTheDocument();
  });
});

describe('Platform > Inbound mail', () => {
  it('shows the provider, domain, volumes and refusals', async () => {
    wrap(<PlatformInbound />);
    const health = await screen.findByTestId('inbound-health');
    expect(within(health).getByTestId('inbound-provider')).toHaveTextContent('postmark');
    expect(within(health).getByText('in.guildwise.test')).toBeInTheDocument();
    const day = within(within(health).getByTestId('inbound-24h'));
    expect(day.getByText(/2 looked like spam, 1 too many messages/)).toBeInTheDocument();
    expect(day.getByText('4')).toBeInTheDocument();
  });
});
