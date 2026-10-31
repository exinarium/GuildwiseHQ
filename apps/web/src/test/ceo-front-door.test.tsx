import type { CeoChatStateDto, ChatDto, DeskItemDto, LedgerEntryDto } from '@aom/shared';
import { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDrawer } from '../components/ChatDrawer.tsx';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { CorrectButton } from '../components/ceo/CorrectDialog.tsx';
import { DeskItem } from '../pages/Desk.tsx';
import { IntakeNew } from '../pages/Intake.tsx';
import { Ledger } from '../pages/Ledger.tsx';
import { initSocket, type LiveSocket } from '../ws/socket.ts';
import { ceoStatus, deskItem, Fail, stubApi, U, wrap } from './ceo-fixtures.tsx';

const THREAD = U(30);
const ceoChat = (over: Partial<ChatDto> = {}): ChatDto => ({
  threadId: THREAD,
  title: 'Chat with Cora',
  agentId: U(20),
  agentName: 'Cora',
  agentRole: 'ceo',
  projectId: null,
  cardId: null,
  cardRef: null,
  workstationOnline: true,
  createdAt: '2026-10-03T10:00:00.000Z',
  lastMessageAt: null,
  ...over,
});

const state = (over: Partial<CeoChatStateDto> = {}): CeoChatStateDto => ({
  threadId: THREAD,
  agentName: 'Cora',
  workstation: { id: U(90), name: 'Pieter laptop', online: true },
  fullPower: { state: 'on', workstationName: 'Pieter laptop' },
  model: {
    default: { runtime: 'claude-code', model: 'sonnet', effort: 'medium' },
    thread: null,
    runtimes: ['claude-code'],
  },
  cwd: '',
  busy: false,
  queued: [],
  permissions: [],
  confirmations: [],
  corrections: [],
  ...over,
});

let socket: LiveSocket;
let sent: Array<Record<string, unknown>>;
beforeEach(() => {
  socket = initSocket(new QueryClient());
  socket.enableMockTransport();
  socket.start();
  sent = [];
  vi.spyOn(socket, 'send').mockImplementation(() => {});
  vi.spyOn(socket, 'sendChat').mockImplementation((threadId, body, clientMsgId, model) => {
    sent.push({ threadId, body, clientMsgId, ...(model ? { model } : {}) });
    return true;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const chatRoutes = (st: CeoChatStateDto, chat: ChatDto = ceoChat()): Array<[string, () => unknown]> => [
  ['GET /api/chats', () => ({ chats: [chat] })],
  ['GET /api/threads/', () => ({ threadId: THREAD, kind: 'chat', hasMore: false, messages: [] })],
  ['GET /api/ceo/chat/state', () => st],
  ['GET /api/ceo/status', () => ceoStatus()],
];

describe('the CEO chat: model switch', () => {
  it('shows "Default (Sonnet)", sends one message with a model for that message only, and then falls back', async () => {
    stubApi('owner', chatRoutes(state()));
    wrap(<ChatPanel threadId={THREAD} />);
    const chip = await screen.findByTestId('model-chip');
    expect(chip).toHaveTextContent('Default (Sonnet)');
    const user = userEvent.setup();
    await user.click(chip);
    const dialog = await screen.findByRole('dialog', { name: 'Model for this chat' });
    await user.click(within(dialog).getByRole('radio', { name: 'Opus' }));
    await user.selectOptions(within(dialog).getByLabelText('Effort'), 'high');
    await user.click(within(dialog).getByRole('button', { name: 'This message' }));
    await user.click(within(dialog).getByTestId('model-apply'));
    expect(screen.getByTestId('model-chip')).toHaveTextContent('This message: Opus (high)');
    await user.type(screen.getByLabelText('Message'), 'think hard');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(sent).toEqual([
      {
        threadId: THREAD,
        body: 'think hard',
        clientMsgId: expect.any(String),
        model: { choice: { runtime: 'claude-code', model: 'opus', effort: 'high' }, scope: 'message' },
      },
    ]);
    expect(screen.getByTestId('model-chip')).toHaveTextContent('Default (Sonnet)');
  });

  it('saves a conversation-wide choice (PUT) and offers Back to default while it is set', async () => {
    let thread: unknown = null;
    const calls = stubApi('owner', [
      [
        'PUT /api/ceo/chat/model',
        (c) => {
          thread = (c.body as { choice: unknown }).choice;
          return { ok: true };
        },
      ],
      ['GET /api/ceo/chat/state', () => state({ model: { ...state().model, thread: thread as never } })],
      ...chatRoutes(state()).filter(([k]) => k !== 'GET /api/ceo/chat/state'),
    ]);
    wrap(<ChatPanel threadId={THREAD} />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('model-chip'));
    const dialog = await screen.findByRole('dialog', { name: 'Model for this chat' });
    await user.click(within(dialog).getByRole('radio', { name: 'Haiku' }));
    await user.click(within(dialog).getByTestId('model-apply'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        choice: { runtime: 'claude-code', model: 'haiku' },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('model-chip')).toHaveTextContent('This conversation: Haiku'),
    );
    expect(screen.getByTestId('model-chip')).toHaveAttribute('data-overridden', 'true');
    await user.click(screen.getByTestId('model-chip'));
    await user.click(await screen.findByTestId('model-default'));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({ choice: null }),
    );
  });

  it('lists only the runtimes the workstation reports', async () => {
    stubApi('owner', chatRoutes(state({ model: { ...state().model, runtimes: ['mock'] } })));
    wrap(<ChatPanel threadId={THREAD} />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('model-chip'));
    const dialog = await screen.findByRole('dialog', { name: 'Model for this chat' });
    expect(within(dialog).getByRole('radio', { name: 'Mock' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('radio', { name: 'Opus' })).toBeNull();
  });

  it('has no model chip in a chat with another agent', async () => {
    stubApi('owner', chatRoutes(state(), ceoChat({ agentRole: 'builder', agentName: 'Ada' })));
    wrap(<ChatPanel threadId={THREAD} />);
    await screen.findByRole('log', { name: 'Conversation' });
    expect(screen.queryByTestId('model-chip')).toBeNull();
  });
});

describe('the CEO chat: full power, queue, permissions, confirmations', () => {
  it.each([
    ['on', 'Full power is on'],
    ['off', 'Full power is off on Pieter laptop: run `guildwise-runner ceo full-power on` there'],
    ['unknown', 'Messages wait until it is back'],
    ['unbound', 'Add a workstation to talk to Cora'],
  ] as const)('says what full power %s means', async (st, text) => {
    stubApi('owner', chatRoutes(state({ fullPower: { state: st, workstationName: 'Pieter laptop' } })));
    wrap(<ChatPanel threadId={THREAD} />);
    expect(await screen.findByTestId('full-power')).toHaveTextContent(text);
  });

  it('shows the queued banner and, for a message that waited too long, Send and Drop', async () => {
    const calls = stubApi('owner', [
      ['POST /api/ceo/queue/', () => ({ ok: true })],
      ...chatRoutes(
        state({
          workstation: { id: U(90), name: 'Pieter laptop', online: false },
          queued: [
            {
              turnId: U(31),
              messageId: U(32),
              body: 'old news',
              queuedAt: '2026-10-01T10:00:00.000Z',
              stale: true,
            },
            {
              turnId: U(33),
              messageId: U(34),
              body: 'fresh',
              queuedAt: '2026-10-13T10:00:00.000Z',
              stale: false,
            },
          ],
        }),
      ),
    ]);
    wrap(<ChatPanel threadId={THREAD} />);
    expect(await screen.findByTestId('ceo-queued')).toHaveTextContent(
      'Queued: Cora answers when Pieter laptop is back.',
    );
    const stale = screen.getByTestId('ceo-queued-stale');
    expect(stale).toHaveTextContent('This waited 3 days, still want it?');
    await userEvent.click(within(stale).getByRole('button', { name: 'Drop' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/ceo/queue/${U(31)}`)?.body).toEqual({ decision: 'drop' }),
    );
    await userEvent.click(within(stale).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith('/api/ceo/queue/')).length).toBe(2));
  });

  it('shows the banner when a chat.queued message arrives', async () => {
    stubApi('owner', chatRoutes(state()));
    wrap(<ChatPanel threadId={THREAD} />);
    await screen.findByRole('log', { name: 'Conversation' });
    expect(screen.queryByTestId('ceo-queued')).toBeNull();
    act(() => socket.handle({ type: 'chat.queued', threadId: THREAD, workstationName: 'Studio PC' }));
    expect(await screen.findByTestId('ceo-queued')).toHaveTextContent('Studio PC is back');
  });

  it('renders a permission card with a countdown and posts the three decisions', async () => {
    const soon = new Date(Date.now() + 125_000).toISOString();
    const calls = stubApi('owner', [
      ['POST /api/ceo/permissions/', () => ({ ok: true })],
      ...chatRoutes(
        state({
          permissions: [
            {
              askId: U(35),
              deskItemId: U(36),
              turnId: U(37),
              mode: 'owner',
              tool: 'Bash',
              input: 'docker compose up -d',
              reason: 'start the stack',
              askedAt: new Date().toISOString(),
              expiresAt: soon,
            },
          ],
        }),
      ),
    ]);
    wrap(<ChatPanel threadId={THREAD} />);
    const card = await screen.findByTestId('ceo-permission');
    expect(card).toHaveTextContent('docker compose up -d');
    expect(within(card).getByTestId('ceo-permission-left')).toHaveTextContent(
      /Denied automatically in 2:0\d/,
    );
    await userEvent.click(within(card).getByRole('button', { name: 'Authorize for this turn' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/ceo/permissions/${U(35)}`)?.body).toEqual({
        decision: 'turn',
      }),
    );
    await userEvent.click(within(card).getByRole('button', { name: 'Authorize once' }));
    await userEvent.click(within(card).getByRole('button', { name: 'Deny' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.url === `/api/ceo/permissions/${U(35)}`).map((c) => c.body)).toEqual([
        { decision: 'turn' },
        { decision: 'once' },
        { decision: 'deny' },
      ]),
    );
  });

  it('answers an inline confirmation with Approve or No (never by text)', async () => {
    const calls = stubApi('owner', [
      ['POST /api/ceo/turns/', () => ({ ok: true })],
      ...chatRoutes(
        state({
          confirmations: [
            {
              actionId: U(38),
              deskItemId: U(39),
              title: 'Cancel card TOY-12?',
              reason: 'you asked',
              turnId: U(37),
            },
          ],
        }),
      ),
    ]);
    wrap(<ChatPanel threadId={THREAD} />);
    const card = await screen.findByTestId('ceo-confirmation');
    await userEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/ceo/turns/${U(37)}/confirm`)?.body).toEqual({
        actionId: U(38),
        approve: true,
      }),
    );
    await userEvent.click(within(card).getByRole('button', { name: 'No' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.url.includes('/confirm')).at(-1)?.body).toEqual({
        actionId: U(38),
        approve: false,
      }),
    );
  });

  it('shows "Noted: <rule>" with Edit and Undo / Redo while they are on offer', async () => {
    const calls = stubApi('owner', [
      ['PATCH /api/ceo/corrections/', () => ({ ok: true })],
      ['POST /api/ceo/corrections/', () => ({ message: 'Redone: TOY-4 released' })],
      ...chatRoutes(
        state({
          corrections: [
            {
              id: U(80),
              at: '2026-10-13T10:00:00.000Z',
              text: 'do not release on Fridays',
              rule: 'Never release on Fridays',
              memoryId: U(81),
              actionId: U(41),
              orderTurnId: null,
              chatMessageId: null,
              deskItemId: null,
              remedy: 'none',
              canUndo: true,
              canRedo: true,
            },
          ],
        }),
      ),
    ]);
    wrap(<ChatPanel threadId={THREAD} />);
    const card = await screen.findByTestId('ceo-correction');
    expect(card).toHaveTextContent('Noted: Never release on Fridays');
    expect(within(card).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Redo' }));
    expect(await within(card).findByText('Redone: TOY-4 released')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    const input = within(card).getByLabelText('The rule');
    await userEvent.clear(input);
    await userEvent.type(input, 'No Friday releases');
    await userEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ rule: 'No Friday releases' }),
    );
  });

  it('opens an old DevOps conversation read-only', async () => {
    stubApi('owner', chatRoutes(state(), ceoChat({ agentRole: 'devops', agentName: 'Atlas' })));
    wrap(<ChatPanel threadId={THREAD} />);
    const note = await screen.findByTestId('devops-read-only');
    await waitFor(() => expect(note).toHaveTextContent('DevOps now works through Cora'));
    expect(screen.queryByLabelText('Message')).toBeNull();
  });

  it('opens the standing "BA reports" conversation read-only: the CEO writes the daily report now', async () => {
    stubApi(
      'owner',
      chatRoutes(state(), ceoChat({ agentRole: 'ba', agentName: 'Bea', title: 'BA reports' })),
    );
    wrap(<ChatPanel threadId={THREAD} />);
    const note = await screen.findByTestId('ba-reports-read-only');
    await waitFor(() => expect(note).toHaveTextContent('Cora writes your daily report now'));
    expect(screen.queryByLabelText('Message')).toBeNull();
  });
});

describe('the correct dialog', () => {
  it('posts the owner words, the rule choice and Undo', async () => {
    const calls = stubApi('owner', [
      [
        'POST /api/ceo/corrections',
        () => ({
          correctionId: U(80),
          memoryId: U(81),
          message: 'Noted: rule',
          remedyResult: 'Undone: TOY-1',
        }),
      ],
    ]);
    wrap(<CorrectButton target={{ actionId: U(41), label: 'Release TOY-1', undoLabel: 'Release TOY-1' }} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Correct' }));
    const dialog = await screen.findByRole('dialog', { name: 'Correct the CEO' });
    expect(within(dialog).getByTestId('correct-rule')).toBeChecked();
    await user.type(within(dialog).getByLabelText('What should I have done?'), 'Ask me first');
    await user.click(within(dialog).getByTestId('correct-undo'));
    await user.click(within(dialog).getByTestId('correct-submit'));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/ceo/corrections')?.body).toEqual({
        actionId: U(41),
        text: 'Ask me first',
        makeRule: true,
        remedy: 'undo',
      }),
    );
    expect(await within(dialog).findByText('Noted: rule')).toBeInTheDocument();
    expect(within(dialog).getByText('Undone: TOY-1')).toBeInTheDocument();
  });

  it('offers no Undo where the action has no inverse, and can skip the rule', async () => {
    const calls = stubApi('owner', [
      [
        'POST /api/ceo/corrections',
        () => ({ correctionId: U(80), memoryId: null, message: 'Recorded', remedyResult: null }),
      ],
    ]);
    wrap(
      <CorrectButton
        target={{ orderTurnId: U(60), label: 'Standing order' }}
        label="I'd rather you didn't"
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: "I'd rather you didn't" }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByTestId('correct-undo')).toBeNull();
    await user.type(within(dialog).getByLabelText('What should I have done?'), 'Not that way');
    await user.click(within(dialog).getByTestId('correct-rule'));
    await user.click(within(dialog).getByTestId('correct-submit'));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/ceo/corrections')?.body).toEqual({
        orderTurnId: U(60),
        text: 'Not that way',
        makeRule: false,
        remedy: 'none',
      }),
    );
  });

  it('shows the server error and keeps the dialog open', async () => {
    stubApi('admin', [
      ['POST /api/ceo/corrections', () => new Fail(403, 'only the Owner may correct this class')],
    ]);
    wrap(<CorrectButton target={{ actionId: U(41), label: 'x' }} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Correct' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('What should I have done?'), 'Something else');
    await user.click(within(dialog).getByTestId('correct-submit'));
    expect(await within(dialog).findByText('only the Owner may correct this class')).toBeInTheDocument();
  });
});

describe('the desk: authorize this execution', () => {
  it('shows the three buttons on a ceo_permission item', async () => {
    const calls = stubApi('admin', [['POST /api/ceo/permissions/', () => ({ ok: true })]]);
    const item: DeskItemDto = deskItem({
      kind: 'approval',
      subkind: 'ceo_permission',
      title: 'Authorize this execution',
      options: [],
      data: {
        askId: U(35),
        turnId: U(37),
        tool: 'Bash',
        input: 'rm -rf build',
        reason: 'clean build',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    wrap(<DeskItem item={item} now={Date.now()} />);
    const card = await screen.findByTestId('ceo-permission');
    expect(card).toHaveTextContent('rm -rf build');
    await userEvent.click(within(card).getByRole('button', { name: 'Authorize once' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/ceo/permissions/${U(35)}`)?.body).toEqual({
        decision: 'once',
      }),
    );
    expect(screen.queryByTestId('desk-approve')).toBeNull();
  });
});

describe('the daily report', () => {
  const report = {
    actions: [
      {
        id: U(41),
        class: 'card.release',
        mode: 'decided',
        status: 'done',
        subject: 'TOY-4',
        undoable: true,
        correctable: true,
      },
    ],
    scores: [],
    fallback: false,
    orderTurns: [
      {
        turnId: U(60),
        at: '2026-10-13T09:00:00.000Z',
        entryId: U(61),
        orderTitle: 'Release notes',
        outcome: 'done' as const,
        summary: 'Wrote the notes',
        commands: ['git log'],
        ask: null,
        corrected: false,
      },
    ],
    repeats: [
      {
        id: U(62),
        key: 'invoice-export',
        suggestion: 'skill' as const,
        count7: 4,
        count30: 5,
        projectKey: 'TOY',
        jobs: [{ id: U(63), title: 'Export invoices', at: '2026-10-12T09:00:00.000Z' }],
        detectedAt: '2026-10-13T06:00:00.000Z',
      },
    ],
  };

  it('has Correct on decisions and order turns, and "Things you keep asking me" with its buttons', async () => {
    const calls = stubApi('owner', [
      ['POST /api/ceo/chat', () => ({ threadId: THREAD })],
      ['POST /api/ceo/repeats/', () => ({ ok: true })],
      ['GET /api/ceo/status', () => ceoStatus()],
    ]);
    wrap(
      <DeskItem
        item={deskItem({
          kind: 'alert',
          subkind: 'ceo_report',
          title: 'Daily report',
          options: [],
          ceoReport: report,
        })}
        now={Date.now()}
      />,
    );
    expect(await screen.findByTestId(`report-correct-${U(41)}`)).toBeInTheDocument();
    expect(await screen.findByTestId(`report-correct-order-${U(60)}`)).toHaveTextContent(
      "I'd rather you didn't",
    );
    const rep = screen.getByTestId('ceo-repeat');
    expect(rep).toHaveTextContent('invoice-export');
    expect(rep).toHaveTextContent('4 in 7 days, 5 in 30');
    await userEvent.click(await within(rep).findByRole('button', { name: 'Not a pattern' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/ceo/repeats/${U(62)}/resolve`)?.body).toEqual({
        decision: 'dismissed',
      }),
    );
  });

  it('"Make it a skill" opens the CEO chat and resolves the repeat', async () => {
    const calls = stubApi('owner', [
      ['POST /api/ceo/chat', () => ({ threadId: THREAD })],
      ['POST /api/ceo/repeats/', () => ({ ok: true })],
      ['GET /api/ceo/status', () => ceoStatus()],
    ]);
    wrap(
      <DeskItem
        item={deskItem({
          kind: 'alert',
          subkind: 'ceo_report',
          title: 'Daily report',
          options: [],
          ceoReport: report,
        })}
        now={Date.now()}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Make it a skill' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/ceo/repeats/${U(62)}/resolve`)?.body).toEqual({
        decision: 'skill',
      }),
    );
    expect(await screen.findByTestId('elsewhere')).toBeInTheDocument();
  });
});

describe('standing orders: full power', () => {
  const entry = (fp: LedgerEntryDto['fullPower'], over: Partial<LedgerEntryDto> = {}): LedgerEntryDto => ({
    id: U(70),
    scope: 'standing_order',
    projectId: null,
    projectKey: null,
    cardId: null,
    cardRef: null,
    title: 'Triage bugs',
    body: 'Specify every new bug at once.',
    tags: [],
    sourceDeskItemId: null,
    vaultPath: null,
    createdByKind: 'user',
    createdByName: 'Pieter',
    supersededBy: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    version: 1,
    editedAt: null,
    editedByName: null,
    retiredAt: null,
    retiredReason: null,
    conflictsWith: [],
    canRetire: true,
    canEdit: true,
    reviewDate: null,
    reviewDue: false,
    reviewedAt: null,
    fullPower: fp,
    ...over,
  });
  const none = {
    state: 'none' as const,
    versionHash: 'a'.repeat(64),
    current: false,
    scope: null,
    covers: [],
    authorizedAt: null,
    voidReason: null,
    eligible: true,
    ineligibleReason: null,
    escalated: false,
  };
  const ledger = (e: LedgerEntryDto): Array<[string, () => unknown]> => [
    ['GET /api/ledger', () => ({ entries: [e] })],
    ['GET /api/projects', () => ({ projects: [{ id: U(5), key: 'TOY', name: 'Toy' }] })],
  ];

  it('lets the Owner authorize with a scope and explicitly ticked covers, bound to the wording hash', async () => {
    const calls = stubApi('owner', [
      ['POST /api/ledger/', () => ({ entry: entry(none) })],
      ...ledger(entry(none)),
    ]);
    wrap(<Ledger />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('fp-give'));
    const dialog = await screen.findByRole('dialog', { name: /full power/ });
    expect(dialog).toHaveTextContent('Bound to this exact wording');
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'Finalize, large merge and pull request approvals' }),
    );
    await user.type(within(dialog).getByLabelText('Only for these triggers (optional)'), 'bug_flagged');
    await user.click(within(dialog).getByTestId('fp-authorize'));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/ledger/${U(70)}/authorize`)).toBe(true));
    const body = calls.find((c) => c.url.endsWith('/authorize'))?.body as {
      versionHash: string;
      scope: unknown;
      covers: string[];
    };
    expect(body.versionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.scope).toEqual({ projectIds: null, triggers: ['bug_flagged'] });
    expect(body.covers).toEqual(['finalize_merge']);
  });

  it('shows Authorized with Revoke, and Voided as "authorize again"', async () => {
    const authorized = { ...none, state: 'authorized' as const, current: true, covers: ['outbound'] };
    const calls = stubApi('owner', [
      ['POST /api/ledger/', () => ({ entry: entry(authorized) })],
      ...ledger(entry(authorized)),
    ]);
    wrap(<Ledger />);
    expect(await screen.findByTestId('fp-authorized')).toHaveTextContent('full power');
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/ledger/${U(70)}/revoke`)).toBe(true));
  });

  it('shows a voided order and, for an Admin, Not eligible with an Ask the Owner button', async () => {
    const voided = { ...none, state: 'voided' as const, voidReason: 'edited' };
    stubApi('owner', ledger(entry(voided)));
    const first = wrap(<Ledger />);
    expect(await screen.findByTestId('fp-voided')).toHaveTextContent('Edited since: authorize again');
    first.unmount();
    vi.unstubAllGlobals();
    const adminOrder = { ...none, eligible: false, ineligibleReason: 'written by an Admin' };
    const calls = stubApi('admin', [
      ['POST /api/ledger/', () => ({ entry: entry(adminOrder) })],
      ...ledger(entry(adminOrder)),
    ]);
    wrap(<Ledger />);
    expect(await screen.findByTestId('fp-ineligible')).toHaveTextContent('written by an Admin');
    expect(screen.queryByTestId('fp-give')).toBeNull();
    await userEvent.click(screen.getByTestId('fp-escalate'));
    await userEvent.click(await screen.findByTestId('fp-escalate-send'));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/ledger/${U(70)}/escalate`)).toBe(true));
  });
});

describe('the chat drawer: DevOps works through the CEO', () => {
  it('does not offer DevOps engineers as someone to chat with', async () => {
    stubApi('owner', [
      [
        'GET /api/agents',
        () => ({
          agents: [
            { id: U(1), name: 'Ada', roleKey: 'builder', isDevops: false, status: 'active' },
            { id: U(2), name: 'Atlas', roleKey: 'devops', isDevops: true, status: 'active' },
          ],
        }),
      ],
      ['GET /api/chats', () => ({ chats: [] })],
    ]);
    wrap(<ChatDrawer open onOpenChange={() => {}} />);
    const select = await screen.findByLabelText('Agent');
    await waitFor(() => expect(within(select).queryByRole('option', { name: /Ada/ })).toBeInTheDocument());
    expect(within(select).queryByRole('option', { name: /Atlas/ })).toBeNull();
  });
});

describe('New intake: the CEO is the front door', () => {
  it('the Owner can tell the CEO: it opens the CEO chat with the request waiting, and the BA stays a direct path', async () => {
    const calls = stubApi('owner', [
      ['GET /api/intakes', () => ({ intakes: [] })],
      ['POST /api/ceo/chat', () => ({ threadId: THREAD })],
    ]);
    wrap(<IntakeNew />);
    await userEvent.type(await screen.findByLabelText('Ticket or need'), 'Add dark mode to the settings');
    expect(screen.getByRole('button', { name: 'Work with the BA directly' })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('intake-via-ceo'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/ceo/chat')).toBe(true),
    );
    // the router moved on to the chat page (the wrapper's catch-all route)
    expect(await screen.findByTestId('elsewhere')).toBeInTheDocument();
  });

  it('an Admin has no CEO button (only the Owner talks to the CEO): the plain Start intake stays', async () => {
    stubApi('admin', [['GET /api/intakes', () => ({ intakes: [] })]]);
    wrap(<IntakeNew />);
    expect(await screen.findByRole('button', { name: 'Start intake' })).toBeInTheDocument();
    expect(screen.queryByTestId('intake-via-ceo')).toBeNull();
  });
});
