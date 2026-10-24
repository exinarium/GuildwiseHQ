import type { BoardStateDto, SessionDto, ThreadMessageDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNav } from '../components/shell/nav-config.ts';
import { ToastProvider } from '../components/ui.tsx';
import {
  boardWaitingText,
  buildBoardTimeline,
  completeMention,
  estimateText,
  mentionMatches,
  mentionPartial,
  seatColor,
} from '../lib/boardroom.ts';
import { BoardroomList } from '../pages/Boardroom.tsx';
import { BoardroomSession } from '../pages/BoardroomSession.tsx';
import { initSocket } from '../ws/socket.ts';

const T = '0192f3a0-0000-7000-8000-0000000000f1';
const P1 = '0192f3a0-0000-7000-8000-0000000000f2';
const P2 = '0192f3a0-0000-7000-8000-0000000000f3';
const P3 = '0192f3a0-0000-7000-8000-0000000000f4';
const N1 = '0192f3a0-0000-7000-8000-0000000000f5';
const N2 = '0192f3a0-0000-7000-8000-0000000000f6';
const D1 = '0192f3a0-0000-7000-8000-0000000000f7';
const DOC = '0192f3a0-0000-7000-8000-0000000000f8';
const AT = '2026-10-03T10:00:00.000Z';

const cast = [
  {
    participantId: P1,
    kind: 'persona',
    refId: 'devils-advocate',
    seat: 'Panelist',
    displayName: "Devil's Advocate",
    slug: 'devils-advocate',
    stance: 'Skeptic',
    icon: null,
    model: null,
    index: 0,
  },
  {
    participantId: P2,
    kind: 'persona',
    refId: 'cost-hawk',
    seat: 'Panelist',
    displayName: 'Cost Hawk',
    slug: 'cost-hawk',
    stance: 'Money',
    icon: null,
    model: null,
    index: 1,
  },
  {
    participantId: P3,
    kind: 'persona',
    refId: 'ad-hoc-regulator',
    seat: 'Compliance',
    displayName: 'Regulator',
    slug: 'regulator',
    stance: 'Rules',
    icon: null,
    model: null,
    index: 2,
  },
] as BoardStateDto['cast'];

const note = (over: Partial<BoardStateDto['notes'][number]> = {}): BoardStateDto['notes'][number] => ({
  id: N1,
  column: 'risks',
  text: 'Adoption is assumed',
  byKind: 'persona',
  byName: "Devil's Advocate",
  round: 1,
  votes: 0,
  votedByMe: false,
  mergedFrom: [],
  createdAt: AT,
  updatedAt: AT,
  ...over,
});
const state = (over: Partial<BoardStateDto> = {}): BoardStateDto => ({
  threadId: T,
  title: 'Boardroom: Launch a pilot?',
  projectId: null,
  config: {
    topic: 'Should we launch a pilot?',
    brief: 'Eight weeks',
    format: 'open',
    roundCap: 4,
    stage: 'chair',
    round: 1,
    revealedRound: 1,
    paused: false,
    budgetStopped: false,
    endReason: null,
    models: {},
    dissentNext: false,
    minutesDocId: null,
    prdSessionId: null,
    suggestState: null,
  },
  cast,
  chair: { participantId: '0192f3a0-0000-7000-8000-0000000000f9', displayName: 'Chair' },
  rounds: [
    {
      round: 1,
      kind: 'independent',
      speakers: cast.map((c) => ({ participantId: c.participantId, name: c.displayName })),
      reason: '',
      instruction: '',
      source: 'independent',
      plannedAt: AT,
      status: 'done',
    },
  ],
  notes: [note()],
  hiddenNotes: 0,
  disagreements: [],
  decisions: [],
  suggestions: [],
  sealedMessageIds: [],
  sealedProgress: null,
  documents: [],
  turns: [],
  cost: { costMicros: 120_000, costUsd: 0.12, turns: 3, unpricedTurns: 0, budgetUsd: 5, exceeded: false },
  estimate: { speakers: 3, usd: 0.03, basis: 'average' },
  workstationOnline: true,
  ceoAvailable: false,
  busy: false,
  waitingFor: 'owner',
  chairStatus: null,
  createdAt: AT,
  ...over,
});
const message = (over: Partial<ThreadMessageDto> = {}): ThreadMessageDto => ({
  id: '0192f3a0-0000-7000-8000-000000000a01',
  threadId: T,
  authorKind: 'agent',
  authorUserId: null,
  authorAgentId: null,
  authorPersonaKey: 'devils-advocate',
  authorName: "Devil's Advocate",
  kind: 'chat',
  body: 'I assume this fails on the first customer.',
  data: { participantId: P1, round: 1 },
  createdAt: '2026-10-03T10:00:30.000Z',
  ...over,
});

const realMatchMedia = window.matchMedia;
function setMobile(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile ? /max-width:\s*767/.test(query) : /min-width:\s*(1024|768|640)px/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
beforeEach(() => {
  setMobile(false);
  const sock = initSocket(new QueryClient());
  sock.enableMockTransport();
  sock.start();
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.unstubAllGlobals();
});

type Handler = (init: RequestInit) => unknown;
function stub(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const key = Object.keys(handlers)
        .filter((k) => `${method} ${url}`.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const body = key ? (handlers[key] as Handler)(init) : {};
      return new Response(JSON.stringify(body), { status: method === 'POST' ? 201 : 200 });
    }),
  );
  return calls;
}
const thread = (messages: ThreadMessageDto[]) => ({
  threadId: T,
  kind: 'boardroom',
  hasMore: false,
  messages,
});
const meHandlers = {
  'GET /api/auth/me': () => ({
    user: { id: 'u', email: 'o@example.com', displayName: 'Owner' },
    activeOrg: { id: 'o', name: 'Org', role: 'owner' },
  }),
};
const mount = (path: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/boardroom" element={<BoardroomList />} />
            <Route path="/boardroom/:id" element={<BoardroomSession />} />
            <Route path="/discovery/:id" element={<p>the discovery session</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
};
const session = (over: Partial<SessionDto> = {}): SessionDto =>
  ({
    threadId: T,
    kind: 'boardroom',
    title: 'Boardroom: Launch a pilot?',
    projectId: null,
    facilitatorAgentId: null,
    workstationId: null,
    workstationOnline: true,
    config: { board: true, format: 'pre_mortem', stage: 'round', round: 2, roundCap: 4, paused: true },
    createdBy: null,
    createdAt: AT,
    lastMessageAt: AT,
    cost: { costMicros: 500_000, costUsd: 0.5, turns: 4, unpricedTurns: 0, budgetUsd: null, exceeded: false },
    participants: [
      {
        id: P1,
        threadId: T,
        kind: 'persona',
        refId: 'chair',
        seat: 'Chair',
        stance: null,
        displayName: 'Chair',
        addedAt: AT,
      },
      ...cast.map((c) => ({
        id: c.participantId,
        threadId: T,
        kind: 'persona' as const,
        refId: c.refId,
        seat: c.seat,
        stance: null,
        displayName: c.displayName,
        addedAt: AT,
      })),
    ],
    ...over,
  }) as SessionDto;

describe('boardroom helpers', () => {
  it('orders rounds, messages and decisions, drops the chair chatter, and hides sealed answers behind one line', () => {
    const msgs = [
      message(),
      message({
        id: 'c1',
        authorPersonaKey: 'chair',
        authorName: 'Chair',
        data: { purpose: 'board_chair' },
        createdAt: '2026-10-03T10:00:40.000Z',
      }),
      message({ id: 'sealed1', createdAt: '2026-10-03T10:00:35.000Z', body: 'SECRET' }),
    ];
    const open = buildBoardTimeline(msgs, state());
    expect(open.map((i) => i.kind)).toEqual(['round', 'message', 'message']);
    expect(open.some((i) => i.kind === 'message' && i.message.id === 'c1')).toBe(false);
    const sealed = buildBoardTimeline(
      msgs,
      state({ sealedMessageIds: ['sealed1'], sealedProgress: { done: 1, total: 3 } }),
    );
    expect(sealed.map((i) => i.kind)).toEqual(['round', 'sealed', 'message']);
    expect(JSON.stringify(sealed)).not.toContain('SECRET');
  });

  it('words the waiting state, the estimate and the seat colours', () => {
    const s = (waitingFor: BoardStateDto['waitingFor'], round = 2) => ({
      waitingFor,
      chair: { participantId: null, displayName: 'Chair' },
      config: { round } as BoardStateDto['config'],
    });
    expect(boardWaitingText(s('speakers', 1))).toMatch(/on their own/);
    expect(boardWaitingText(s('chair'))).toBe('Chair is choosing the next speakers');
    expect(boardWaitingText(s('decision'))).toMatch(/decision/);
    expect(boardWaitingText(s('budget'))).toMatch(/budget/);
    expect(estimateText({ speakers: 3, usd: 0.034, basis: 'average' })).toBe('~$0.03 for 3 speakers');
    expect(estimateText({ speakers: 1, usd: 0.004, basis: 'default' })).toBe(
      '<$0.01 for 1 speaker (a first guess)',
    );
    expect(seatColor(0)).not.toEqual(seatColor(1));
    expect(seatColor(8)).toEqual(seatColor(0));
  });

  it('completes an @mention from the end of the text', () => {
    expect(mentionPartial('what about @co')).toBe('co');
    expect(mentionPartial('hello')).toBeNull();
    expect(mentionPartial('a@b')).toBeNull();
    expect(mentionMatches('co', cast).map((m) => m.slug)).toEqual(['cost-hawk']);
    expect(mentionMatches('', cast).map((m) => m.slug)).toEqual([
      'all',
      'devils-advocate',
      'cost-hawk',
      'regulator',
    ]);
    expect(completeMention('what about @co', 'cost-hawk')).toBe('what about @cost-hawk ');
  });

  it('puts Boardroom in the navigation for every member', () => {
    expect(
      buildNav({ projectKey: null, canManage: true })
        .sections.flatMap((s) => s.items)
        .map((i) => i.id),
    ).toContain('boardroom');
    expect(
      buildNav({ projectKey: null, canManage: false })
        .sections.flatMap((s) => s.items)
        .map((i) => i.id),
    ).toContain('boardroom');
  });
});

describe('Boardroom list and the new boardroom dialog', () => {
  it('lists the boardrooms with round, format, seats, state and cost', async () => {
    stub({ ...meHandlers, 'GET /api/sessions': () => ({ sessions: [session()] }) });
    mount('/boardroom');
    const row = await screen.findByTestId('boardroom-row');
    expect(row).toHaveTextContent('Launch a pilot?');
    expect(row).toHaveTextContent('Round 2 of 4');
    expect(row).toHaveTextContent('Paused');
    expect(row).toHaveTextContent('Pre-mortem');
    expect(row).toHaveTextContent('3 seats');
    expect(row).toHaveTextContent('$0.50');
  });

  it('starts a boardroom: topic, format, a library persona, an agent, a persona cast from a brief, a saved room, budget and models', async () => {
    const calls = stub({
      ...meHandlers,
      'GET /api/sessions': () => ({ sessions: [] }),
      'GET /api/projects': () => ({ projects: [] }),
      'GET /api/agents': () => ({
        agents: [
          { id: '0192f3a0-0000-7000-8000-0000000000aa', name: 'Ben', roleKey: 'ba', status: 'active' },
        ],
      }),
      'GET /api/capabilities': () => ({
        items: [
          {
            kind: 'persona',
            key: 'cost-hawk',
            name: 'Cost Hawk',
            description: 'Money',
            hash: 'h',
            source: 'builtin',
            overrides: false,
          },
          {
            kind: 'persona',
            key: 'security',
            name: 'Security',
            description: 'Risk',
            hash: 'h',
            source: 'builtin',
            overrides: false,
          },
          {
            kind: 'persona',
            key: 'chair',
            name: 'Chair',
            description: 'Runs the room',
            hash: 'h',
            source: 'builtin',
            overrides: false,
          },
        ],
        issues: [],
        indexedAt: null,
      }),
      'GET /api/board-rooms': () => ({ rooms: [] }),
      'GET /api/workstations': () => ({
        workstations: [
          {
            id: 'w',
            userId: 'u',
            name: 'Laptop',
            status: 'active',
            connected: true,
            runtimes: [{ id: 'claude-code', available: true }],
          },
        ],
      }),
      'POST /api/board': () => ({ state: state() }),
      'GET /api/board/': () => ({ state: state() }),
      'GET /api/threads/': () => thread([message()]),
    });
    mount('/boardroom');
    const user = userEvent.setup();
    expect(await screen.findByText('No boardrooms yet')).toBeInTheDocument();
    await user.click(await screen.findByTestId('new-boardroom'));
    const dialog = await screen.findByRole('dialog');
    const start = within(dialog).getByTestId('start-boardroom');
    expect(start).toBeDisabled();
    // the two fixed seats are there from the start and cannot be removed
    expect(within(dialog).getByRole('list', { name: 'Chosen cast' })).toHaveTextContent('Optimist');
    expect(within(dialog).getByTestId('fixed-seat-optimist')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Remove Optimist/ })).toBeNull();
    expect(within(dialog).getByTestId('cast-counter')).toHaveTextContent('0 of 3-4 opinion seats');
    await user.type(within(dialog).getByLabelText('Topic'), 'Should we launch a pilot?');
    await user.type(within(dialog).getByLabelText('Brief (optional)'), 'Eight weeks');
    await user.selectOptions(within(dialog).getByLabelText('Format'), 'six_hats');
    // the chair is not offered as a seat
    expect(within(dialog).queryByRole('checkbox', { name: 'Chair' })).toBeNull();
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Cost Hawk' }));
    expect(start).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Ben' }));
    await user.type(within(dialog).getByLabelText('Name'), 'Regulator');
    await user.type(within(dialog).getByLabelText('Brief'), 'A cautious compliance officer');
    await user.click(within(dialog).getByTestId('add-adhoc'));
    expect(within(dialog).getByRole('list', { name: 'Chosen cast' })).toHaveTextContent('Regulator');
    expect(within(dialog).getByTestId('cast-counter')).toHaveTextContent('3 of 3-4 opinion seats');
    await user.selectOptions(within(dialog).getByLabelText('Round cap'), '3');
    await user.type(within(dialog).getByLabelText('Cost limit in USD (optional)'), '2');
    await user.selectOptions(within(dialog).getByLabelText('Time limit'), '45');
    await user.selectOptions(within(dialog).getByLabelText('The Chair runs on'), 'claude-code/sonnet');
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    expect(await screen.findByTestId('boardroom-session')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/board')?.body).toEqual({
      topic: 'Should we launch a pilot?',
      brief: 'Eight weeks',
      format: 'six_hats',
      roundCap: 3,
      models: { chair: { runtime: 'claude-code', model: 'sonnet' } },
      cast: [
        { kind: 'persona', refId: 'optimist', seat: 'Optimist' },
        { kind: 'persona', refId: 'devils-advocate', seat: "Devil's Advocate" },
        { kind: 'persona', refId: 'cost-hawk' },
        { kind: 'agent', refId: '0192f3a0-0000-7000-8000-0000000000aa' },
        {
          kind: 'persona',
          refId: 'ad-hoc-regulator',
          displayName: 'Regulator',
          stance: 'A cautious compliance officer',
        },
      ],
      budgetUsd: 2,
      timeLimitMinutes: 45,
      workstationId: 'w',
    });
  });

  it('asks the Chair for a cast, follows the suggestions and adds one; picks a saved room', async () => {
    const draft = state({
      config: { ...state().config, stage: 'setup', suggestState: 'done' },
      cast: [],
      suggestions: [
        { id: 's1', type: 'persona', personaKey: 'security', name: 'Security', why: 'Data matters' },
        { id: 's2', type: 'adhoc', name: 'Neighbour', brief: 'Hears the noise', why: 'Local view' },
      ],
    });
    const calls = stub({
      ...meHandlers,
      'GET /api/sessions': () => ({ sessions: [] }),
      'GET /api/projects': () => ({ projects: [] }),
      'GET /api/agents': () => ({ agents: [] }),
      'GET /api/capabilities': () => ({
        items: [
          {
            kind: 'persona',
            key: 'security',
            name: 'Security',
            description: 'Risk',
            hash: 'h',
            source: 'builtin',
            overrides: false,
          },
        ],
        issues: [],
        indexedAt: null,
      }),
      'GET /api/board-rooms': () => ({
        rooms: [
          {
            id: '0192f3a0-0000-7000-8000-0000000000bb',
            name: 'Product review',
            format: 'pre_mortem',
            roundCap: 3,
            models: {},
            createdAt: AT,
            cast: [
              { kind: 'persona', refId: 'cost-hawk' },
              { kind: 'persona', refId: 'security' },
            ],
          },
        ],
      }),
      'GET /api/workstations': () => ({ workstations: [] }),
      'POST /api/board/suggest': () => ({ state: draft }),
      'GET /api/board/': () => ({ state: draft }),
    });
    mount('/boardroom');
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('new-boardroom'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Topic'), 'Second office?');
    await user.click(within(dialog).getByTestId('suggest-cast'));
    const list = await within(dialog).findByTestId('suggestions');
    expect(list).toHaveTextContent('Security');
    expect(list).toHaveTextContent('from a brief');
    await user.click(within(dialog).getByRole('button', { name: 'Add Neighbour' }));
    expect(within(dialog).getByRole('list', { name: 'Chosen cast' })).toHaveTextContent('Neighbour');
    expect(calls.find((c) => c.url === '/api/board/suggest')?.body).toMatchObject({
      topic: 'Second office?',
      format: 'open',
    });
    // a saved room fills the cast, format and cap
    await user.selectOptions(
      await within(dialog).findByLabelText('Use a saved room'),
      '0192f3a0-0000-7000-8000-0000000000bb',
    );
    expect(within(dialog).getByRole('list', { name: 'Chosen cast' })).toHaveTextContent('Cost Hawk');
    expect(within(dialog).getByLabelText('Format')).toHaveValue('pre_mortem');
    expect(within(dialog).getByLabelText('Round cap')).toHaveValue('3');
  });
});

describe('Boardroom session', () => {
  const mountSession = (s: BoardStateDto, msgs: ThreadMessageDto[], extra: Record<string, Handler> = {}) => {
    const calls = stub({
      ...meHandlers,
      'GET /api/board/': () => ({ state: s }),
      'GET /api/threads/': () => thread(msgs),
      'GET /api/documents/': () => ({
        document: {
          id: DOC,
          kind: 'minutes',
          title: 'Minutes: Launch',
          status: 'draft',
          currentVersion: 1,
          versions: [],
          content: '# Minutes: Launch\n\n## Positions\n\n- Cost Hawk: later',
        },
      }),
      ...extra,
    });
    mount(`/boardroom/${T}`);
    return calls;
  };

  it('shows the group conversation: round separators, the Chair pick, a seat per colour, and the meters', async () => {
    const s = state({
      config: { ...state().config, round: 2, stage: 'round' },
      rounds: [
        ...state().rounds,
        {
          round: 2,
          kind: 'discussion',
          speakers: [
            { participantId: P2, name: 'Cost Hawk' },
            { participantId: P3, name: 'Regulator' },
          ],
          reason: 'They differ',
          instruction: 'Name the gap',
          source: 'chair',
          plannedAt: '2026-10-03T10:01:00.000Z',
          status: 'running',
        },
      ],
      chairStatus: 'Chair picks: Cost Hawk, Regulator — They differ',
      waitingFor: 'speakers',
      busy: true,
    });
    mountSession(s, [
      message(),
      message({
        id: 'm2',
        authorPersonaKey: 'cost-hawk',
        authorName: 'Cost Hawk',
        body: 'What does it cost?',
        data: { participantId: P2, round: 1 },
        createdAt: '2026-10-03T10:00:31.000Z',
      }),
      {
        ...message({
          id: 'u1',
          authorKind: 'user',
          authorPersonaKey: null,
          authorName: 'Owner',
          body: 'Interesting, go on',
          data: {},
          createdAt: '2026-10-03T10:01:10.000Z',
        }),
      },
    ]);
    const turns = await screen.findAllByTestId('board-turn');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toHaveAttribute('data-seat', 'devils-advocate');
    expect(turns[1]).toHaveAttribute('data-seat', 'cost-hawk');
    expect(turns[0]?.className).not.toEqual(turns[1]?.className);
    const seps = screen.getAllByTestId('round-separator');
    expect(seps[0]).toHaveTextContent('Round 1 of 4 · Everyone answers on their own');
    expect(seps[1]).toHaveTextContent('Round 2 of 4 · Discussion');
    expect(screen.getByTestId('chair-picks')).toHaveTextContent(
      'Chair picks: Cost Hawk, Regulator — They differ',
    );
    expect(screen.getByTestId('chair-status')).toHaveTextContent('Chair picks');
    expect(screen.getByTestId('meter-round')).toHaveTextContent('2 of 4');
    expect(screen.getByTestId('meter-cost')).toHaveTextContent('$0.12 of $5.00');
    expect(screen.getByTestId('meter-estimate')).toHaveTextContent('~$0.03 for 3 speakers');
    expect(screen.getByTestId('waiting-for')).toHaveTextContent('The speakers are answering');
    expect(within(screen.getByTestId('cast')).getByText('@regulator')).toBeInTheDocument();
  });

  it('shows the Chair’s delegations and the Delegation control of the session', async () => {
    const s = state({
      delegations: [
        {
          delegateId: '0192f3a0-0000-7000-8000-000000000060',
          callerId: '0192f3a0-0000-7000-8000-000000000061',
          target: 'agent:rex',
          targetName: 'Rex',
          targetKind: 'agent',
          model: 'claude-opus-5-5',
          profile: 'read_only',
          outcome: 'timeout',
          durationMs: 110_000,
          costUsd: null,
          costUnknown: true,
          summary: 'the delegate did not finish within 110 seconds',
          native: false,
          at: '2026-10-03T10:01:00.000Z',
        },
      ],
    });
    mountSession(s, [message()], {
      [`GET /api/sessions/${T}/delegate-grants`]: () => ({
        ownerKind: 'session',
        ownerId: T,
        canManage: false,
        grants: [],
      }),
    });
    const steps = await screen.findByTestId('delegation-steps');
    expect(steps).toHaveTextContent('Delegated to Rex');
    expect(within(steps).getByTestId('delegation-step')).toHaveAttribute('data-outcome', 'timeout');
    expect(steps).toHaveTextContent('cost unknown');
    await userEvent.click(screen.getByTestId('delegate-grants-toggle'));
    expect(
      await screen.findByText(/Only the creator of the session, an Owner or an Admin/),
    ).toBeInTheDocument();
  });

  it('keeps round 1 sealed until every answer is in', async () => {
    const s = state({
      config: { ...state().config, stage: 'round', revealedRound: 0 },
      sealedMessageIds: ['sealed1'],
      sealedProgress: { done: 1, total: 3 },
      hiddenNotes: 1,
      notes: [],
      busy: true,
      waitingFor: 'speakers',
    });
    mountSession(s, [message({ id: 'sealed1', body: 'SECRET ANSWER' })]);
    const sealed = await screen.findByTestId('sealed-round');
    expect(sealed).toHaveTextContent('1 of 3 answers are in');
    expect(screen.queryByText(/SECRET ANSWER/)).toBeNull();
    expect(screen.queryAllByTestId('board-turn')).toHaveLength(0);
    expect(screen.getByTestId('hidden-notes')).toHaveTextContent('1 note sealed');
  });

  it('asks for a decision at a decision point and sends the owner pick', async () => {
    const s = state({
      config: { ...state().config, stage: 'decision' },
      waitingFor: 'decision',
      decisions: [
        {
          id: D1,
          question: 'Pilot or prove demand first?',
          options: [
            { id: 'o1', label: 'Pilot' },
            { id: 'o2', label: 'Prove demand' },
          ],
          round: 1,
          status: 'open',
          answer: null,
          optionId: null,
          askedByName: 'Chair',
          askedAt: '2026-10-03T10:02:00.000Z',
          resolvedAt: null,
        },
      ],
    });
    const calls = mountSession(s, [message()], { 'POST /api/board/': () => ({ state: s }) });
    const user = userEvent.setup();
    const card = await screen.findByTestId('decision-card');
    expect(card).toHaveTextContent('The Chair needs your decision');
    expect(card).toHaveTextContent('Pilot or prove demand first?');
    const decide = within(card).getByTestId('decide');
    expect(decide).toBeDisabled();
    await user.click(within(card).getByTestId('decision-option-o2'));
    await user.type(within(card).getByLabelText('Your decision'), 'with ten users');
    await user.click(decide);
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/board/${T}/decisions/${D1}/resolve`)?.body).toEqual({
        answer: 'with ten users',
        optionId: 'o2',
      }),
    );
    expect(screen.getByTestId('waiting-for')).toHaveTextContent('The Chair needs your decision');
  });

  it('mentions a seat with autocomplete and sends the message', async () => {
    const calls = mountSession(state(), [message()], {
      'POST /api/board/': () => ({
        message: message({ authorKind: 'user' }),
        mentioned: [P2],
        state: state(),
      }),
    });
    const user = userEvent.setup();
    const box = await screen.findByPlaceholderText(/Interject/);
    await user.type(box, 'What do you think @co');
    await user.click(await screen.findByTestId('mention-cost-hawk'));
    expect(box).toHaveValue('What do you think @cost-hawk ');
    await user.type(box, 'about price?');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/board/${T}/say`)?.body).toEqual({
        body: 'What do you think @cost-hawk about price?',
      }),
    );
  });

  it('works the whiteboard: add, move by menu, vote, merge and delete', async () => {
    const s = state({
      notes: [
        note(),
        note({
          id: N2,
          column: 'ideas',
          text: 'Pilot with one partner',
          byName: 'Cost Hawk',
          votes: 1,
          votedByMe: true,
        }),
      ],
    });
    const calls = mountSession(s, [message()], {
      'POST /api/board/': () => ({ state: s }),
      'PATCH /api/board/': () => ({ state: s }),
      'DELETE /api/board/': () => ({ state: s }),
    });
    const user = userEvent.setup();
    const risks = await screen.findByTestId('column-risks');
    expect(within(risks).getByText('Adoption is assumed')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('column-ideas')).getByText('Pilot with one partner'),
    ).toBeInTheDocument();
    // add
    await user.type(
      within(screen.getByTestId('column-questions')).getByLabelText('New questions note'),
      'Who pays?',
    );
    await user.click(
      within(screen.getByTestId('column-questions')).getByRole('button', { name: 'Add to Questions' }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/board/${T}/notes`)?.body).toEqual({
        column: 'questions',
        text: 'Who pays?',
      }),
    );
    // move by menu
    await user.selectOptions(within(risks).getByLabelText('Move to'), 'parked');
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'PATCH' && c.url === `/api/board/${T}/notes/${N1}`)?.body,
      ).toEqual({ column: 'parked' }),
    );
    // drag to another column
    const dt = {
      data: { 'text/plain': N1 } as Record<string, string>,
      setData(k: string, v: string) {
        this.data[k] = v;
      },
      getData(k: string) {
        return this.data[k] ?? '';
      },
      effectAllowed: '',
    };
    fireEvent.drop(screen.getByTestId('column-decisions'), { dataTransfer: dt });
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PATCH' && c.body?.column === 'decisions')).toHaveLength(1),
    );
    // vote
    await user.click(within(screen.getByTestId('column-ideas')).getByTestId('vote-note'));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/board/${T}/notes/${N2}/vote`)).toBe(true));
    // merge
    await user.click(screen.getByTestId('merge-mode'));
    const boxes = screen.getAllByLabelText('Select note to merge');
    await user.click(boxes[0] as HTMLElement);
    expect(screen.getByTestId('merge-selected')).toBeDisabled();
    await user.click(boxes[1] as HTMLElement);
    await user.click(screen.getByTestId('merge-selected'));
    await waitFor(() =>
      expect(calls.find((c) => c.url === `/api/board/${T}/notes/merge`)?.body.noteIds).toHaveLength(2),
    );
    // delete
    await user.click(within(risks).getByRole('button', { name: 'Delete note' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url === `/api/board/${T}/notes/${N1}`)).toBe(true),
    );
  });

  it('ends the session after a confirmation, and shows the minutes with Pull into PRD', async () => {
    const running = state();
    const calls = mountSession(running, [message()], { 'POST /api/board/': () => ({ state: running }) });
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('end-session'));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: 'End session' }));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/board/${T}/end`)).toBe(true));
    await user.click(screen.getByTestId('write-minutes'));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/board/${T}/minutes`)).toBe(true));
  });

  it('shows the minutes of an ended session and pulls them into a PRD', async () => {
    const ended = state({
      config: { ...state().config, stage: 'ended', endReason: 'owner', minutesDocId: DOC },
      waitingFor: 'ended',
      documents: [{ id: DOC, kind: 'minutes', title: 'Minutes: Launch', status: 'draft', currentVersion: 1 }],
    });
    const after = state({
      config: { ...ended.config, prdSessionId: '0192f3a0-0000-7000-8000-0000000000cc' },
      waitingFor: 'ended',
    });
    const calls = mountSession(ended, [message()], {
      'POST /api/board/': () => ({
        discoveryId: '0192f3a0-0000-7000-8000-0000000000cc',
        docId: DOC,
        state: after,
      }),
    });
    const user = userEvent.setup();
    expect(await screen.findByText('This session is over')).toBeInTheDocument();
    expect(screen.queryByTestId('end-session')).toBeNull();
    expect(screen.queryByPlaceholderText(/Interject/)).toBeNull();
    expect(await screen.findByTestId('minutes-body')).toHaveTextContent('Cost Hawk: later');
    await user.click(screen.getByTestId('pull-into-prd'));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/board/${T}/pull-into-prd`)).toBe(true));
    expect(await screen.findByText('the discovery session')).toBeInTheDocument();
  });

  it('warns about a used-up budget and about an offline workstation, and resumes a paused session', async () => {
    const s = state({
      waitingFor: 'budget',
      config: { ...state().config, budgetStopped: true, paused: true },
      workstationOnline: false,
      cost: { costMicros: 5_100_000, costUsd: 5.1, turns: 9, unpricedTurns: 0, budgetUsd: 5, exceeded: true },
    });
    const calls = mountSession(s, [message()], { 'POST /api/board/': () => ({ state: s }) });
    const user = userEvent.setup();
    expect(await screen.findByText('This boardroom reached its budget')).toBeInTheDocument();
    expect(screen.getByText(/workstation is offline/)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Resume' })[0] as HTMLElement);
    await waitFor(() => expect(calls.some((c) => c.url === `/api/board/${T}/resume`)).toBe(true));
  });

  it('uses tabs on a phone: conversation, whiteboard and minutes', async () => {
    setMobile(true);
    mountSession(state(), [message()]);
    const user = userEvent.setup();
    expect(await screen.findByTestId('board-conversation')).toBeInTheDocument();
    expect(screen.queryByTestId('whiteboard')).toBeNull();
    await user.click(screen.getByRole('tab', { name: /Whiteboard/ }));
    expect(await screen.findByTestId('whiteboard')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Minutes' }));
    expect(await screen.findByTestId('minutes-panel')).toBeInTheDocument();
  });
});

describe('R2: fixed seats, limits, ownership, archive', () => {
  const station = {
    id: 'w1',
    userId: 'u',
    name: 'Laptop',
    status: 'active',
    connected: true,
    runtimes: [],
    repos: [],
  };
  const personas = [
    'optimist',
    'devils-advocate',
    'cost-hawk',
    'security',
    'user-advocate',
    'ops',
    'customer-smb',
  ].map((key) => ({
    kind: 'persona',
    key,
    name: key === 'optimist' ? 'Optimist' : key,
    description: key,
    hash: 'h',
    source: 'builtin',
    overrides: false,
  }));
  const dialogHandlers = (extra: Record<string, Handler> = {}) =>
    stub({
      ...meHandlers,
      'GET /api/sessions': () => ({ sessions: [] }),
      'GET /api/projects': () => ({ projects: [] }),
      'GET /api/agents': () => ({ agents: [] }),
      'GET /api/capabilities': () => ({ items: personas, issues: [], indexedAt: null }),
      'GET /api/board-rooms': () => ({ rooms: [] }),
      'GET /api/workstations': () => ({
        workstations: [
          { ...station, id: 'w0', name: 'Old', connected: false },
          station,
          { ...station, id: 'x', userId: 'other' },
        ],
      }),
      'POST /api/board': () => ({ state: state() }),
      'GET /api/board/': () => ({ state: state() }),
      'GET /api/threads/': () => thread([message()]),
      ...extra,
    });

  it('locks the two fixed seats, counts the other seats and enables Start at three to four', async () => {
    const calls = dialogHandlers();
    mount('/boardroom');
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('new-boardroom'));
    const dialog = await screen.findByRole('dialog');
    const start = within(dialog).getByTestId('start-boardroom');
    await user.type(within(dialog).getByLabelText('Topic'), 'Go?');
    const counter = within(dialog).getByTestId('cast-counter');
    expect(counter).toHaveTextContent('0 of 3-4 opinion seats');
    // the fixed ones are checked and cannot be unchecked
    const optimist = await within(dialog).findByRole('checkbox', { name: 'Optimist' });
    expect(optimist).toBeChecked();
    expect(optimist).toBeDisabled();
    expect(within(dialog).getByTestId('cast-problem')).toBeInTheDocument();
    for (const n of ['cost-hawk', 'security'])
      await user.click(within(dialog).getByRole('checkbox', { name: n }));
    expect(start).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: 'user-advocate' }));
    expect(counter).toHaveTextContent('3 of 3-4 opinion seats');
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(within(dialog).getByRole('checkbox', { name: 'ops' }));
    // a fifth other seat is refused
    await user.click(within(dialog).getByRole('checkbox', { name: 'customer-smb' }));
    expect(counter).toHaveTextContent('4 of 3-4 opinion seats');
    await user.click(start);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/board')).toBe(true));
    const cast = calls.find((c) => c.url === '/api/board')?.body.cast as Array<{ refId: string }>;
    expect(cast.map((c) => c.refId)).toEqual([
      'optimist',
      'devils-advocate',
      'cost-hawk',
      'security',
      'user-advocate',
      'ops',
    ]);
  });

  it('offers only my own workstations, online first; cost and time limits are optional', async () => {
    const calls = dialogHandlers();
    mount('/boardroom');
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('new-boardroom'));
    const dialog = await screen.findByRole('dialog');
    const picker = await within(dialog).findByTestId('workstation-picker');
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Laptop', 'Old (offline)']);
    expect(picker).toHaveValue('w1');
    await user.type(within(dialog).getByLabelText('Topic'), 'Go?');
    for (const n of ['cost-hawk', 'security', 'user-advocate'])
      await user.click(await within(dialog).findByRole('checkbox', { name: n }));
    await user.click(within(dialog).getByTestId('start-boardroom'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/board')).toBe(true));
    const body = calls.find((c) => c.url === '/api/board')?.body;
    expect(body).toMatchObject({ workstationId: 'w1' });
    expect(body).not.toHaveProperty('budgetUsd');
    expect(body).not.toHaveProperty('timeLimitMinutes');
  });

  it('puts the fixed seats in front of an older saved room', async () => {
    dialogHandlers({
      'GET /api/board-rooms': () => ({
        rooms: [
          {
            id: '0192f3a0-0000-7000-8000-0000000000bb',
            name: 'Old room',
            format: 'open',
            roundCap: 3,
            models: {},
            createdAt: AT,
            cast: [{ kind: 'persona', refId: 'cost-hawk' }],
          },
        ],
      }),
    });
    mount('/boardroom');
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('new-boardroom'));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(
      await within(dialog).findByLabelText('Use a saved room'),
      '0192f3a0-0000-7000-8000-0000000000bb',
    );
    const chosen = within(dialog).getByRole('list', { name: 'Chosen cast' });
    expect(chosen).toHaveTextContent('Optimist');
    expect(chosen).toHaveTextContent("Devil's Advocate");
    expect(chosen).toHaveTextContent('cost-hawk');
    expect(within(dialog).getByTestId('cast-counter')).toHaveTextContent('1 of 3-4 opinion seats');
  });

  const mountSession = (s: BoardStateDto, extra: Record<string, Handler> = {}) => {
    const calls = stub({
      ...meHandlers,
      'GET /api/board/': () => ({ state: s }),
      'GET /api/threads/': () => thread([message()]),
      'GET /api/sessions': () => ({ sessions: [] }),
      ...extra,
    });
    mount(`/boardroom/${T}`);
    return calls;
  };
  const timeOf = (over: Partial<NonNullable<BoardStateDto['time']>> = {}) => ({
    limitMinutes: 30,
    elapsedMs: 25 * 60_000,
    running: true,
    asOf: AT,
    warned: false,
    up: false,
    ...over,
  });

  it('counts the time down and warns the room with five minutes left', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      mountSession(state({ time: timeOf({ warned: true }) }));
      expect(await screen.findByTestId('countdown-value')).toHaveTextContent('5:00');
      expect(screen.getByTestId('time-warning')).toHaveTextContent('The Chair is steering to wrap-up');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await waitFor(() => expect(screen.getByTestId('countdown-value')).toHaveTextContent('4:5'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('at time-up the creator extends or wraps up into the minutes', async () => {
    const up = state({
      waitingFor: 'time',
      time: timeOf({ elapsedMs: 30 * 60_000, up: true, running: false }),
    });
    const calls = mountSession(up, { [`POST /api/board/${T}/time`]: () => ({ state: up }) });
    const user = userEvent.setup();
    const card = await screen.findByTestId('time-up');
    await user.click(within(card).getByTestId('extend-30'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/time'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/time'))?.body).toEqual({ action: 'extend', minutes: 30 });
    await user.click(within(card).getByRole('button', { name: 'Wrap up now (write minutes)' }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/time'))).toHaveLength(2));
    expect(calls.filter((c) => c.url.endsWith('/time'))[1]?.body).toEqual({ action: 'wrap_up' });
  });

  it('asks the creator what to do when the budget ran out before the minutes summary', async () => {
    const s = state({
      waitingFor: 'budget',
      config: { ...state().config, stage: 'minutes', minutesAsk: 'budget' },
      cost: { costMicros: 5_100_000, costUsd: 5.1, turns: 9, unpricedTurns: 0, budgetUsd: 5, exceeded: true },
    });
    const calls = mountSession(s, {
      [`POST /api/board/${T}/minutes-choice`]: () => ({ state: s }),
      [`PATCH /api/board/${T}`]: () => ({ state: s }),
    });
    const user = userEvent.setup();
    const card = await screen.findByTestId('minutes-budget-card');
    expect(card).toHaveTextContent('The budget is used up before the Chair could write the minutes summary');
    await user.click(within(card).getByTestId('minutes-without-summary'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/minutes-choice'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/minutes-choice'))?.body).toEqual({ choice: 'without_summary' });
    await user.click(within(card).getByTestId('raise-limit'));
    await user.type(within(card).getByLabelText('New cost limit (USD)'), '12');
    await user.click(within(card).getByRole('button', { name: 'Raise' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ budgetUsd: 12 });
  });

  it('hides the controls from a participant who is not the creator, who can still add notes and vote', async () => {
    mountSession(
      state({
        canManage: false,
        config: { ...state().config, stage: 'minutes', minutesDocId: DOC },
        decisions: [
          {
            id: D1,
            question: 'Pilot?',
            options: [],
            round: 1,
            status: 'open',
            answer: null,
            optionId: null,
            askedByName: 'Chair',
            askedAt: AT,
            resolvedAt: null,
          },
        ],
        waitingFor: 'decision',
      }),
    );
    expect(await screen.findByTestId('read-only-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('pause-session')).toBeNull();
    expect(screen.queryByTestId('end-session')).toBeNull();
    expect(screen.queryByTestId('decide')).toBeNull();
    expect(screen.queryByTestId('merge-mode')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete note' })).toBeNull();
    expect(screen.queryByTestId('write-minutes')).toBeNull();
    expect(screen.queryByTestId('pull-into-prd')).toBeNull();
    expect(screen.queryByTestId('set-budget')).toBeNull();
    expect(screen.queryByTestId('delete-session')).toBeNull();
    expect(screen.getByTestId('vote-note')).toBeEnabled();
    expect(screen.getByLabelText('New ideas note')).toBeInTheDocument();
  });

  it('shows the option-scoring tally on the whiteboard with the top option highlighted', async () => {
    mountSession(
      state({
        scores: [
          {
            option: 'Pilot now',
            total: 9,
            average: 4.5,
            scores: [
              { participantId: P1, name: "Devil's Advocate", score: 4, why: '' },
              { participantId: P2, name: 'Cost Hawk', score: 5, why: '' },
            ],
          },
          {
            option: 'Wait',
            total: 5,
            average: 2.5,
            scores: [
              { participantId: P1, name: "Devil's Advocate", score: 2, why: '' },
              { participantId: P2, name: 'Cost Hawk', score: 3, why: '' },
            ],
          },
        ],
      }),
    );
    const table = await screen.findByTestId('score-tally');
    const rows = within(table).getAllByTestId('score-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('data-top', 'true');
    expect(rows[0]).toHaveTextContent('Pilot now');
    expect(rows[0]).toHaveTextContent('9');
    expect(rows[0]).toHaveTextContent('4.5');
    expect(rows[1]).not.toHaveAttribute('data-top');
  });

  it('archives, shows an archived session read-only, and deletes after a confirmation', async () => {
    const ended = state({ config: { ...state().config, stage: 'ended' } });
    const calls = mountSession(ended, {
      [`POST /api/sessions/${T}/archive`]: () => ({ session: {} }),
      [`DELETE /api/sessions/${T}`]: () => ({}),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('archive-session'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/archive'))?.body).toEqual({ archived: true }),
    );
    await user.click(screen.getByTestId('delete-session'));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(await screen.findByText('No boardrooms yet')).toBeInTheDocument();
  });

  it('asks before archiving a running boardroom, then ends and archives it (Q53)', async () => {
    const running = state({ config: { ...state().config, stage: 'round' } });
    const calls = mountSession(running, { [`POST /api/sessions/${T}/archive`]: () => ({ session: {} }) });
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('archive-session'));
    const dlg = await screen.findByRole('dialog');
    expect(dlg).toHaveTextContent('minutes');
    expect(calls.some((c) => c.url.endsWith('/archive'))).toBe(false);
    await user.click(within(dlg).getByRole('button', { name: 'End and archive' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/archive'))?.body).toEqual({ archived: true, endFirst: true }),
    );
  });

  it('shows that a boardroom is writing its minutes before it is archived', async () => {
    mountSession(state({ config: { ...state().config, stage: 'minutes', archiveAfterEnd: true } }));
    expect(await screen.findByTestId('archive-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('archive-session')).toBeNull();
  });

  it('puts an archived boardroom in read-only mode', async () => {
    mountSession(state({ config: { ...state().config, archived: true } }));
    expect(await screen.findByTestId('archived-banner')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Interject|Decide above/)).toBeNull();
    expect(screen.queryByTestId('pause-session')).toBeNull();
    expect(screen.getByTestId('reopen-session')).toBeInTheDocument();
    expect(screen.getByTestId('vote-note')).toBeDisabled();
  });
});
