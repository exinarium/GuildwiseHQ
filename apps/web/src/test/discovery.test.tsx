import type {
  DiscoveryProposalDto,
  DiscoveryStateDto,
  DocumentDto,
  NoteDto,
  QuestionDto,
  SessionDto,
  ThreadMessageDto,
} from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNav } from '../components/shell/nav-config.ts';
import { ToastProvider } from '../components/ui.tsx';
import { answerText, buildTimeline, formatUsd, questionsToReview, waitingText } from '../lib/discovery.ts';
import { DiscoveryList } from '../pages/Discovery.tsx';
import { DiscoverySession } from '../pages/DiscoverySession.tsx';
import { DocumentsList, DocumentView } from '../pages/Documents.tsx';
import { initSocket } from '../ws/socket.ts';

const T = '0192f3a0-0000-7000-8000-0000000000d1';
const Q1 = '0192f3a0-0000-7000-8000-0000000000d2';
const P1 = '0192f3a0-0000-7000-8000-0000000000d3';
const DOC = '0192f3a0-0000-7000-8000-0000000000d4';
const N1 = '0192f3a0-0000-7000-8000-0000000000d5';
const INTAKE = '0192f3a0-0000-7000-8000-0000000000d6';
const AT = '2026-10-03T10:00:00.000Z';

const question = (over: Partial<QuestionDto> = {}): QuestionDto => ({
  id: Q1,
  threadId: T,
  seq: 1,
  question: 'Who is it for?',
  why: 'It decides the scope',
  options: [
    { id: 'o1', label: 'Freelancers' },
    { id: 'o2', label: 'Agencies' },
  ],
  allowFreeText: true,
  phase: 'frame',
  status: 'open',
  askedByName: 'Analyst',
  answer: null,
  proposed: null,
  askedAt: '2026-10-03T10:01:00.000Z',
  answeredAt: null,
  ...over,
});
const note = (over: Partial<NoteDto> = {}): NoteDto => ({
  id: N1,
  threadId: T,
  section: 'ideas',
  text: 'Recurring invoices',
  byKind: 'persona',
  byName: 'Analyst',
  createdAt: AT,
  updatedAt: AT,
  ...over,
});
const proposal = (over: Partial<DiscoveryProposalDto> = {}): DiscoveryProposalDto => ({
  id: P1,
  threadId: T,
  seq: 2,
  title: 'Add reminders',
  change: 'Send a reminder after 7 days',
  rationale: 'Late payers',
  docId: null,
  section: 'decisions',
  status: 'open',
  resolutionText: null,
  askedByName: 'Analyst',
  createdAt: '2026-10-03T10:02:00.000Z',
  resolvedAt: null,
  ...over,
});
const state = (over: Partial<DiscoveryStateDto> = {}): DiscoveryStateDto => ({
  threadId: T,
  title: 'Invoicing idea',
  projectId: null,
  config: {
    stance: 'facilitator',
    phase: 'diverge',
    ceoMode: 'owner_only',
    playbook: 'brainstorm',
    idea: 'Invoices',
    timeBoxMinutes: 30,
    paused: false,
    model: null,
    budgetStopped: false,
    ceoPrep: null,
    intakeId: null,
    prdValidation: null,
  },
  progress: { elapsedMinutes: 12, remainingMinutes: 18, fraction: 0.4 },
  cost: { costMicros: 120_000, costUsd: 0.12, turns: 3, unpricedTurns: 0, budgetUsd: 5, exceeded: false },
  ceoAvailable: false,
  facilitatorName: 'Analyst',
  ceoName: null,
  workstationOnline: true,
  questions: [question()],
  notes: [note()],
  proposals: [],
  documents: [],
  turns: [],
  busy: false,
  waitingFor: 'owner',
  createdAt: AT,
  ...over,
});
const message = (over: Partial<ThreadMessageDto> = {}): ThreadMessageDto => ({
  id: '0192f3a0-0000-7000-8000-0000000000e1',
  threadId: T,
  authorKind: 'agent',
  authorUserId: null,
  authorAgentId: null,
  authorPersonaKey: 'analyst',
  authorName: 'Analyst',
  kind: 'chat',
  body: 'Hello! Tell me about it.',
  data: {},
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
/** Answers the first matching `METHOD url-prefix`; the longest prefix wins. */
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
const thread = (messages: ThreadMessageDto[] = [message()]) => ({
  threadId: T,
  kind: 'discovery',
  hasMore: false,
  messages,
});

const mount = (path: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/discovery" element={<DiscoveryList />} />
            <Route path="/discovery/:id" element={<DiscoverySession />} />
            <Route path="/documents" element={<DocumentsList />} />
            <Route path="/documents/:id" element={<DocumentView />} />
            <Route path="/intake/:id" element={<p>the intake</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
};
/** A workstation of the signed-in user (id 'u'). */
const myStation = (id: string, name: string, connected = true, userId = 'u') => ({
  id,
  userId,
  name,
  status: 'active',
  connected,
  runtimes: [],
  repos: [],
});
const meHandlers = {
  'GET /api/auth/me': () => ({
    user: { id: 'u', email: 'o@example.com', displayName: 'Owner' },
    activeOrg: { id: 'o', name: 'Org', role: 'owner' },
  }),
};

describe('discovery helpers', () => {
  it('orders messages, questions and proposals in time and drops withdrawn questions', () => {
    const items = buildTimeline(
      [message({ createdAt: '2026-10-03T10:00:30.000Z' })],
      [question(), question({ id: 'q2', status: 'withdrawn', askedAt: '2026-10-03T10:00:50.000Z' })],
      [proposal()],
    );
    expect(items.map((i) => i.kind)).toEqual(['message', 'question', 'proposal']);
  });

  it('words the answer, the waiting state, money and the review list', () => {
    expect(
      answerText(
        question({
          status: 'answered',
          answer: { kind: 'pick', optionId: 'o2', text: 'mostly', source: 'owner' },
        }),
      ),
    ).toBe('Agencies: mostly');
    expect(
      answerText(
        question({
          status: 'skipped',
          answer: { kind: 'skip', optionId: null, text: null, source: 'owner' },
        }),
      ),
    ).toBe('Skipped');
    expect(
      answerText(
        question({ status: 'parked', answer: { kind: 'park', optionId: null, text: null, source: 'owner' } }),
      ),
    ).toBe('Parked for later');
    expect(waitingText({ waitingFor: 'owner', facilitatorName: 'Ana', ceoName: null })).toBe('Your turn');
    expect(waitingText({ waitingFor: 'facilitator', facilitatorName: 'Ana', ceoName: null })).toBe(
      'Ana is working',
    );
    expect(waitingText({ waitingFor: 'budget', facilitatorName: 'Ana', ceoName: null })).toMatch(/budget/);
    expect(formatUsd(0.123)).toBe('$0.12');
    expect(formatUsd(42.4)).toBe('$42.4');
    expect(questionsToReview([question({ status: 'proposed' }), question({ status: 'open' })])).toHaveLength(
      1,
    );
  });

  it('puts Discovery and Documents in the navigation for every member', () => {
    const manager = buildNav({ projectKey: null, canManage: true });
    expect(manager.sections.flatMap((s) => s.items).map((i) => i.id)).toEqual(
      expect.arrayContaining(['discovery', 'documents']),
    );
    const member = buildNav({ projectKey: null, canManage: false });
    const ids = member.sections.flatMap((s) => s.items).map((i) => i.id);
    expect(ids).toContain('discovery');
    expect(ids).toContain('documents');
  });
});

describe('Discovery list and the new session dialog', () => {
  const session = (over: Partial<SessionDto> = {}): SessionDto =>
    ({
      threadId: T,
      kind: 'discovery',
      title: 'Invoicing idea',
      projectId: null,
      facilitatorAgentId: null,
      workstationId: null,
      workstationOnline: true,
      config: { discovery: true, phase: 'converge', stance: 'partner', paused: true },
      createdBy: null,
      createdAt: AT,
      lastMessageAt: AT,
      cost: {
        costMicros: 500_000,
        costUsd: 0.5,
        turns: 2,
        unpricedTurns: 0,
        budgetUsd: null,
        exceeded: false,
      },
      participants: [],
      ...over,
    }) as SessionDto;

  it('lists the sessions with phase, stance and cost', async () => {
    stub({ ...meHandlers, 'GET /api/sessions': () => ({ sessions: [session()] }) });
    mount('/discovery');
    const row = await screen.findByTestId('discovery-row');
    expect(row).toHaveTextContent('Invoicing idea');
    expect(row).toHaveTextContent('Converge');
    expect(row).toHaveTextContent('Paused');
    expect(row).toHaveTextContent('Partner');
    expect(row).toHaveTextContent('$0.50');
  });

  it('starts a session from the dialog and opens it', async () => {
    const calls = stub({
      ...meHandlers,
      'GET /api/sessions': () => ({ sessions: [] }),
      'GET /api/projects': () => ({
        projects: [{ id: '0192f3a0-0000-7000-8000-0000000000aa', key: 'TOY', name: 'Toy' }],
      }),
      'GET /api/ceo/status': () => ({ state: 'active' }),
      'GET /api/workstations': () => ({
        workstations: [myStation('w1', 'Laptop'), myStation('w2', 'Desk', false)],
      }),
      'POST /api/discovery': () => ({ state: state() }),
      'GET /api/discovery/': () => ({ state: state() }),
      'GET /api/threads/': () => thread(),
    });
    mount('/discovery');
    const user = userEvent.setup();
    expect(await screen.findByText('No discovery sessions yet')).toBeInTheDocument();
    await user.click(await screen.findByTestId('new-discovery'));
    const dialog = await screen.findByRole('dialog');
    const start = within(dialog).getByRole('button', { name: 'Start' });
    expect(start).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Title'), 'Invoicing idea');
    await user.type(within(dialog).getByLabelText('Starting idea (optional)'), 'Invoices for freelancers');
    await user.selectOptions(within(dialog).getByLabelText('How should the analyst work?'), 'partner');
    // the CEO is there, so the CEO modes are offered
    await waitFor(() => expect(within(dialog).getByLabelText('CEO')).toBeInTheDocument());
    await user.selectOptions(within(dialog).getByLabelText('CEO'), 'joint');
    await user.selectOptions(within(dialog).getByLabelText('Time limit'), '30');
    // only the user's own workstations are offered, the online one first and chosen
    expect(within(dialog).getByLabelText('Workstation')).toHaveValue('w1');
    expect(within(dialog).queryByTestId('prep-cap')).toBeNull();
    await user.selectOptions(within(dialog).getByLabelText('Start from'), 'prd');
    await user.selectOptions(
      within(dialog).getByLabelText('Project (optional)'),
      '0192f3a0-0000-7000-8000-0000000000aa',
    );
    await user.click(start);
    expect(await screen.findByTestId('discovery-session')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/discovery')?.body).toEqual({
      title: 'Invoicing idea',
      stance: 'partner',
      ceoMode: 'joint',
      playbook: 'prd',
      idea: 'Invoices for freelancers',
      projectId: '0192f3a0-0000-7000-8000-0000000000aa',
      timeBoxMinutes: 30,
      workstationId: 'w1',
    });
  });

  it('hides the CEO modes when there is no CEO', async () => {
    stub({
      ...meHandlers,
      'GET /api/sessions': () => ({ sessions: [] }),
      'GET /api/projects': () => ({ projects: [] }),
      'GET /api/ceo/status': () => ({ state: 'none' }),
    });
    mount('/discovery');
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('new-discovery'));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByLabelText('Start from')).toBeInTheDocument());
    expect(within(dialog).queryByLabelText('CEO')).not.toBeInTheDocument();
  });
});

describe('Discovery session page', () => {
  const base = (s: DiscoveryStateDto, extra: Record<string, Handler> = {}) =>
    stub({
      ...meHandlers,
      [`GET /api/discovery/${T}`]: () => ({ state: s }),
      'GET /api/threads/': () => thread(),
      ...extra,
    });

  it('says when the cost of some turns is unknown instead of counting them as free', async () => {
    base(
      state({
        cost: {
          costMicros: 120_000,
          costUsd: 0.12,
          turns: 3,
          unpricedTurns: 2,
          budgetUsd: null,
          exceeded: false,
        },
      }),
    );
    mount(`/discovery/${T}`);
    expect(await screen.findByTestId('cost-unknown')).toHaveTextContent('Cost unknown for 2 turns');
  });

  it('shows what the facilitator delegated as sub-steps, and a Delegation control that is off until opened', async () => {
    base(
      state({
        delegations: [
          {
            delegateId: '0192f3a0-0000-7000-8000-000000000050',
            callerId: '0192f3a0-0000-7000-8000-000000000051',
            target: 'devils-advocate',
            targetName: "Devil's Advocate",
            targetKind: 'persona',
            model: 'claude-haiku-4-5',
            profile: 'read_only',
            outcome: 'ok',
            durationMs: 3100,
            costUsd: 0.004,
            costUnknown: false,
            summary: 'The pricing is the weak spot.',
            native: false,
            narrowedFrom: null,
            at: '2026-10-03T10:00:30.000Z',
          },
        ],
      }),
      {
        [`GET /api/sessions/${T}/delegate-grants`]: () => ({
          ownerKind: 'session',
          ownerId: T,
          canManage: true,
          grants: [],
        }),
      },
    );
    mount(`/discovery/${T}`);
    const steps = await screen.findByTestId('delegation-steps');
    expect(steps).toHaveTextContent("Delegated to Devil's Advocate");
    expect(steps).toHaveTextContent('claude-haiku-4-5 · reads only · 3.1 s · $0.0040');
    expect(steps).toHaveTextContent('The pricing is the weak spot.');
    expect(screen.queryByTestId('delegate-grants')).toBeNull();
    await userEvent.click(screen.getByTestId('delegate-grants-toggle'));
    expect(await screen.findByTestId('delegate-grants-none')).toHaveTextContent(
      'This session cannot delegate',
    );
  });

  it('shows the conversation, the question card, the phase, the meters and the panel', async () => {
    base(state());
    mount(`/discovery/${T}`);
    expect(await screen.findByText('Hello! Tell me about it.')).toBeInTheDocument();
    const card = await screen.findByTestId('question-card');
    expect(within(card).getByText('Who is it for?')).toBeInTheDocument();
    expect(within(card).getByText(/It decides the scope/)).toBeInTheDocument();
    expect(within(card).getByTestId('option-o1')).toHaveTextContent('Freelancers');
    expect(screen.getByTestId('waiting-for')).toHaveTextContent('Your turn');
    expect(screen.getByTestId('phase-diverge')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByTestId('meter-cost')).toHaveTextContent('$0.12');
    expect(screen.getByTestId('meter-cost')).toHaveTextContent('of $5.00');
    expect(screen.getByTestId('meter-time')).toHaveTextContent('12 min');
    expect(screen.getByTestId('meter-time')).toHaveTextContent('of 30');
    const panel = screen.getByTestId('session-panel');
    expect(within(panel).getByTestId('panel-ideas')).toHaveTextContent('Recurring invoices');
    for (const s of ['Ideas', 'Assumptions', 'Open questions', 'Decisions', 'Parked'])
      expect(within(panel).getByRole('region', { name: s })).toBeInTheDocument();
  });

  it('answers with a quick pick, free text, skip and park', async () => {
    const calls = base(state(), {
      [`POST /api/discovery/${T}/questions/${Q1}/answer`]: () => ({
        state: state({
          questions: [
            question({
              status: 'answered',
              answer: { kind: 'pick', optionId: 'o2', text: null, source: 'owner' },
            }),
          ],
          waitingFor: 'facilitator',
          busy: true,
        }),
      }),
    });
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('option-o2'));
    await waitFor(() => expect(screen.getByTestId('question-answer')).toHaveTextContent('Agencies'));
    const post = (i: number) =>
      calls.filter((c) => c.method === 'POST' && c.url.endsWith('/answer'))[i]?.body;
    expect(post(0)).toEqual({ kind: 'pick', optionId: 'o2' });
  });

  it('sends free text, skip and park', async () => {
    const calls = base(state());
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    const card = await screen.findByTestId('question-card');
    const send = within(card).getByTestId('answer-send');
    expect(send).toBeDisabled();
    await user.type(within(card).getByLabelText('Or in your own words'), 'Solo designers');
    await user.click(send);
    await user.click(within(card).getByTestId('answer-skip'));
    await user.click(within(card).getByTestId('answer-park'));
    const bodies = calls.filter((c) => c.url.endsWith('/answer')).map((c) => c.body);
    expect(bodies).toEqual([{ kind: 'text', text: 'Solo designers' }, { kind: 'skip' }, { kind: 'park' }]);
  });

  it('shows the CEO proposal as a suggestion the owner confirms, edits or overrides', async () => {
    const proposed = {
      text: 'Freelancers',
      optionId: 'o1',
      rationale: 'Smallest market to win',
      byName: 'Ada',
      mode: 'joint' as const,
      at: AT,
    };
    const calls = base(
      state({
        ceoAvailable: true,
        ceoName: 'Ada',
        config: { ...state().config, ceoMode: 'joint' },
        questions: [question({ proposed })],
      }),
    );
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    const box = await screen.findByTestId('ceo-proposal');
    expect(box).toHaveTextContent('Proposed by Ada');
    expect(box).toHaveTextContent('a suggestion, not an answer');
    expect(box).toHaveTextContent('Smallest market to win');
    expect(screen.getByTestId('option-o1')).toHaveTextContent("CEO's pick");
    await user.click(screen.getByTestId('ceo-confirm'));
    await user.click(screen.getByTestId('ceo-edit'));
    const edit = screen.getByLabelText('Your edit');
    await user.clear(edit);
    await user.type(edit, 'Freelancers in the EU');
    await user.click(screen.getByRole('button', { name: 'Use my edit' }));
    await user.click(screen.getByTestId('option-o2')); // override
    const bodies = calls.filter((c) => c.url.endsWith('/answer')).map((c) => c.body);
    expect(bodies).toEqual([
      { kind: 'confirm' },
      { kind: 'confirm', edited: true, text: 'Freelancers in the EU', optionId: 'o1' },
      { kind: 'pick', optionId: 'o2' },
    ]);
  });

  it('applies, rejects and redirects a proposal', async () => {
    const calls = base(
      state({
        questions: [],
        proposals: [
          proposal(),
          proposal({ id: 'p2', title: 'Second', createdAt: '2026-10-03T10:03:00.000Z' }),
        ],
      }),
    );
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    const cards = await screen.findAllByTestId('proposal-card');
    expect(cards[0]).toHaveTextContent('Nothing changes until you choose Apply');
    expect(cards[0]).toHaveTextContent('Panel: Decisions');
    await user.click(within(cards[0] as HTMLElement).getByTestId('proposal-apply'));
    await user.click(within(cards[1] as HTMLElement).getByTestId('proposal-redirect'));
    const redirect = screen.getByRole('button', { name: 'Send to the facilitator' });
    expect(redirect).toBeDisabled();
    await user.type(screen.getByLabelText('What would you rather do?'), 'Make it a decision instead');
    await user.click(redirect);
    const bodies = calls
      .filter((c) => c.url.includes('/proposals/'))
      .map((c) => [c.url.split('/').slice(-2)[0], c.body]);
    expect(bodies).toEqual([
      [P1, { resolution: 'apply' }],
      ['p2', { resolution: 'redirect', text: 'Make it a decision instead' }],
    ]);
  });

  it('lets the owner add, move, edit and delete panel notes', async () => {
    const calls = base(state());
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    const panel = await screen.findByTestId('session-panel');
    await user.type(within(panel).getByLabelText('Add to Assumptions'), 'Users pay late');
    await user.click(
      within(within(panel).getByRole('region', { name: 'Assumptions' })).getByRole('button', { name: 'Add' }),
    );
    await user.selectOptions(within(panel).getByLabelText('Move to'), 'parked');
    await user.click(within(panel).getByLabelText('Edit note text'));
    const edit = within(panel).getByLabelText('Edit note');
    await user.clear(edit);
    await user.type(edit, 'Recurring invoices v2{Enter}');
    await user.click(within(panel).getByLabelText('Delete note'));
    const sent = calls.filter((c) => c.url.includes('/notes')).map((c) => [c.method, c.body]);
    expect(sent).toEqual([
      ['POST', { section: 'assumptions', text: 'Users pay late' }],
      ['PATCH', { section: 'parked' }],
      ['PATCH', { text: 'Recurring invoices v2' }],
      ['DELETE', undefined],
    ]);
  });

  it('overrides the phase, pauses and resumes', async () => {
    const calls = base(state());
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('phase-capture'));
    await user.click(screen.getByTestId('pause-session'));
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url.split('/').pop(), c.body])).toEqual([
      ['phase', { phase: 'capture' }],
      ['pause', {}],
    ]);
  });

  it('shows the paused state with Resume', async () => {
    base(state({ waitingFor: 'paused', config: { ...state().config, paused: true } }));
    mount(`/discovery/${T}`);
    expect(
      await screen.findByText(
        'The clock is stopped and nothing new starts. Your answers are kept; come back whenever you like.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('resume-session')).toBeInTheDocument();
    expect(screen.getByTestId('waiting-for')).toHaveTextContent('Paused');
  });

  it('says plainly when the budget is used up and lets a manager raise it', async () => {
    const calls = base(
      state({
        waitingFor: 'budget',
        config: { ...state().config, budgetStopped: true },
        cost: {
          costMicros: 5_100_000,
          costUsd: 5.1,
          turns: 9,
          unpricedTurns: 0,
          budgetUsd: 5,
          exceeded: true,
        },
      }),
      { [`PATCH /api/discovery/${T}`]: () => ({ state: state() }) },
    );
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    const alert = await screen.findByText(/This session reached its budget/);
    expect(alert.closest('[class*="danger"]')).not.toBeNull();
    expect(screen.getByText(/No new turn starts until you raise the budget/)).toBeInTheDocument();
    expect(screen.getByTestId('waiting-for')).toHaveTextContent('budget');
    await waitFor(() => expect(screen.getByTestId('set-budget')).toBeInTheDocument());
    await user.click(screen.getByTestId('set-budget'));
    const field = screen.getByLabelText('Budget (USD)');
    await user.clear(field);
    await user.type(field, '20');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ budgetUsd: 20 });
  });

  it('offers to retry a turn that failed and warns when the workstation is offline', async () => {
    const calls = base(
      state({
        workstationOnline: false,
        questions: [],
        turns: [
          {
            id: 't1',
            threadId: T,
            participantId: null,
            speakerName: 'Analyst',
            status: 'failed',
            attempts: 3,
            round: null,
            replyToMessageId: null,
            messageId: null,
            error: 'gave up after 3 attempts',
            workstationId: null,
            queuedAt: AT,
            startedAt: AT,
            finishedAt: AT,
          },
        ],
      }),
      { [`POST /api/discovery/${T}/continue`]: () => ({ state: state() }) },
    );
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    expect(await screen.findByText(/workstation is offline/)).toBeInTheDocument();
    expect(screen.getByText('gave up after 3 attempts')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/continue'))).toBe(true));
  });

  it('writes to the analyst', async () => {
    const calls = base(state({ questions: [] }), {
      [`POST /api/discovery/${T}/say`]: () => ({
        message: message({ authorKind: 'user', body: 'hi' }),
        state: state({ questions: [] }),
      }),
    });
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Message'), 'Think about teams');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/say'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/say'))?.body).toEqual({ body: 'Think about teams' });
  });

  it('works on a phone: conversation, panel and draft are tabs', async () => {
    setMobile(true);
    base(state());
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    expect(await screen.findByTestId('question-card')).toBeInTheDocument();
    expect(screen.queryByTestId('session-panel')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /Panel/ }));
    expect(screen.getByTestId('session-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('question-card')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Draft' }));
    expect(screen.getByTestId('session-drafts')).toBeInTheDocument();
  });
});

describe('the draft: versions, checklist, approval and the hand-over', () => {
  const doc = (over: Partial<DocumentDto> = {}) => ({
    id: DOC,
    orgId: T,
    projectId: null,
    kind: 'prd',
    title: 'PRD: Invoicing',
    slug: 'prd-invoicing',
    status: 'draft',
    currentVersion: 2,
    approvedVersion: null,
    sourceThreadIds: [T],
    publishState: 'none',
    publishedVersion: null,
    vaultPath: null,
    createdBy: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  });
  const full = (over: Partial<DocumentDto> = {}) => ({
    ...doc(over),
    content: '# PRD\n\n## Goals\n\nFaster invoices.',
    versions: [
      {
        id: 'v2',
        documentId: DOC,
        version: 2,
        note: 'second',
        savedBy: { kind: 'persona', id: 'analyst' },
        createdAt: AT,
      },
      {
        id: 'v1',
        documentId: DOC,
        version: 1,
        note: null,
        savedBy: { kind: 'persona', id: 'analyst' },
        createdAt: AT,
      },
    ],
  });
  const withDoc = (status: DocumentDto['status'], extra: Partial<DiscoveryStateDto> = {}) =>
    state({
      questions: [],
      documents: [{ id: DOC, kind: 'prd', title: 'PRD: Invoicing', status, currentVersion: 2 }],
      ...extra,
    });

  it('renders the PRD as markdown with a version picker and the checklist result', async () => {
    const validation = {
      docId: DOC,
      version: 2,
      summary: 'Two gaps',
      at: AT,
      items: [
        { criterion: 'Goals have a measure', status: 'fail' as const, note: 'No target' },
        { criterion: 'Non-goals listed', status: 'pass' as const, note: '' },
      ],
    };
    const st = withDoc('draft', { config: { ...state().config, prdValidation: validation } });
    stub({
      ...meHandlers,
      [`GET /api/discovery/${T}`]: () => ({ state: st }),
      'GET /api/threads/': () => thread(),
      [`GET /api/documents/${DOC}/versions/1`]: () => ({
        version: { ...full().versions[1], content: 'OLD TEXT', id: 'v1' },
      }),
      [`GET /api/documents/${DOC}`]: () => ({ document: full() }),
    });
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    const drafts = await screen.findByTestId('session-drafts');
    expect(await within(drafts).findByRole('heading', { name: 'Goals' })).toBeInTheDocument();
    expect(within(drafts).getByTestId('doc-status')).toHaveTextContent('Draft');
    const v = within(drafts).getByTestId('prd-validation');
    expect(v).toHaveTextContent('Two gaps');
    expect(v).toHaveTextContent('fail');
    expect(v).toHaveTextContent('Goals have a measure');
    await user.selectOptions(within(drafts).getByTestId('version-picker'), '1');
    expect(await within(drafts).findByText('OLD TEXT')).toBeInTheDocument();
  });

  it('approves the PRD (review, then approved), then hands it to the BA and links the intake', async () => {
    let status: DocumentDto['status'] = 'draft';
    const calls = stub({
      ...meHandlers,
      [`GET /api/discovery/${T}`]: () => ({ state: withDoc(status) }),
      'GET /api/threads/': () => thread(),
      [`POST /api/documents/${DOC}/status`]: (init) => {
        status = JSON.parse(String(init.body)).status;
        return { document: full({ status }) };
      },
      [`GET /api/documents/${DOC}`]: () => ({ document: full({ status }) }),
      [`POST /api/discovery/${T}/validate`]: () => ({ state: withDoc(status) }),
      [`POST /api/discovery/${T}/hand-to-ba`]: () => {
        status = 'handed_off';
        return {
          intakeId: INTAKE,
          state: withDoc('handed_off', { config: { ...state().config, intakeId: INTAKE } }),
        };
      },
    });
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    expect(screen.queryByTestId('hand-to-ba')).not.toBeInTheDocument();
    await user.click(await screen.findByTestId('validate-prd'));
    await user.click(await screen.findByTestId('approve-doc'));
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith('/status')).map((c) => c.body.status)).toEqual([
        'in_review',
        'approved',
      ]),
    );
    // the page refetches: the approved PRD offers Hand to BA
    const handoff = await screen.findByTestId('hand-to-ba');
    await user.click(handoff);
    const open = await screen.findByTestId('open-intake');
    expect(open).toHaveAttribute('href', `/intake/${INTAKE}`);
    expect(calls.some((c) => c.url.endsWith('/hand-to-ba'))).toBe(true);
  });

  it('offers to draft when there is none', async () => {
    const calls = stub({
      ...meHandlers,
      [`GET /api/discovery/${T}`]: () => ({ state: state({ questions: [] }) }),
      'GET /api/threads/': () => thread(),
      [`POST /api/discovery/${T}/draft`]: () => ({ state: state({ questions: [] }) }),
    });
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('draft-prd'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/draft'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/draft'))?.body).toEqual({ kind: 'prd' });
  });
});

describe('Documents pages', () => {
  const d = (over: Partial<DocumentDto> = {}): DocumentDto => ({
    id: DOC,
    orgId: T,
    projectId: null,
    kind: 'prd',
    title: 'PRD: Invoicing',
    slug: 'prd-invoicing',
    status: 'approved',
    currentVersion: 3,
    approvedVersion: 3,
    sourceThreadIds: [T],
    publishState: 'queued',
    publishedVersion: 3,
    vaultPath: 'org/docs/prd-invoicing.md',
    createdBy: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  });

  it('lists documents with kind, status and version, and filters', async () => {
    const calls = stub({
      ...meHandlers,
      'GET /api/documents': () => ({
        documents: [d(), d({ id: 'x2', kind: 'brief', title: 'Brief', status: 'draft', currentVersion: 1 })],
      }),
    });
    mount('/documents');
    const user = userEvent.setup();
    const rows = await screen.findAllByTestId('document-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('PRD: Invoicing');
    expect(rows[0]).toHaveTextContent('Approved');
    expect(rows[0]).toHaveTextContent('v3');
    await user.click(screen.getByRole('button', { name: 'PRD' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('kind=prd'))).toBe(true));
  });

  it('shows one document with markdown, its versions and the sessions it came from', async () => {
    stub({
      ...meHandlers,
      [`GET /api/documents/${DOC}`]: () => ({
        document: {
          ...d(),
          content: '# Title\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
          versions: [
            {
              id: 'v3',
              documentId: DOC,
              version: 3,
              note: null,
              savedBy: { kind: 'user', id: 'u' },
              createdAt: AT,
            },
            {
              id: 'v2',
              documentId: DOC,
              version: 2,
              note: null,
              savedBy: { kind: 'user', id: 'u' },
              createdAt: AT,
            },
          ],
        },
      }),
    });
    mount(`/documents/${DOC}`);
    expect(await screen.findByTestId('document-view')).toBeInTheDocument();
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getByTestId('document-status')).toHaveTextContent('Approved');
    expect(screen.getByTestId('version-picker')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'a discovery session' })).toHaveAttribute(
      'href',
      `/discovery/${T}`,
    );
    expect(screen.getByText(/Copied to the vault as org\/docs\/prd-invoicing.md/)).toBeInTheDocument();
  });
});

describe('R2: ownership, limits, archive and hand-off', () => {
  const base = (s: DiscoveryStateDto, extra: Record<string, Handler> = {}) =>
    stub({
      ...meHandlers,
      [`GET /api/discovery/${T}`]: () => ({ state: s }),
      'GET /api/threads/': () => thread(),
      'GET /api/sessions': () => ({ sessions: [] }),
      ...extra,
    });
  const timeOf = (over: Partial<NonNullable<DiscoveryStateDto['time']>> = {}) => ({
    limitMinutes: 30,
    elapsedMs: 25 * 60_000,
    running: true,
    asOf: AT,
    warned: false,
    up: false,
    ...over,
  });

  it('shows a participant who is not the creator a read-only view: they can talk and add notes, not steer', async () => {
    base(state({ canManage: false, proposals: [proposal()] }));
    mount(`/discovery/${T}`);
    expect(await screen.findByTestId('read-only-hint')).toHaveTextContent(
      'The session creator manages this session',
    );
    // no pause, no phase change, no answer buttons, no proposal gate, no note editing
    expect(screen.queryByTestId('pause-session')).toBeNull();
    expect(screen.getByTestId('phase-converge')).toBeDisabled();
    expect(screen.queryByTestId('option-o1')).toBeNull();
    expect(screen.queryByTestId('answer-skip')).toBeNull();
    expect(screen.queryByTestId('proposal-apply')).toBeNull();
    expect(screen.getByTestId('proposal-readonly')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit note text' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete note' })).toBeNull();
    expect(screen.queryByTestId('set-budget')).toBeNull();
    expect(screen.queryByTestId('delete-session')).toBeNull();
    // they can still talk and add notes
    expect(screen.getByPlaceholderText(/Write to the analyst|Answer above/)).toBeInTheDocument();
    expect(screen.getByLabelText('Add to Ideas')).toBeInTheDocument();
    // the session composer has the / menu of playbooks
    expect(screen.getByTestId('slash-button')).toBeInTheDocument();
  });

  it('treats a state without canManage as manageable (an older server)', async () => {
    base(state());
    mount(`/discovery/${T}`);
    expect(await screen.findByTestId('pause-session')).toBeInTheDocument();
    expect(screen.queryByTestId('read-only-hint')).toBeNull();
  });

  it('counts down the time limit each second, warns at five minutes and turns red when it is up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      base(state({ time: timeOf({ warned: true }) }));
      mount(`/discovery/${T}`);
      const value = await screen.findByTestId('countdown-value');
      expect(value).toHaveTextContent('5:00');
      expect(screen.getByTestId('meter-countdown')).toHaveAttribute('data-state', 'warn');
      expect(screen.getByTestId('time-warning')).toHaveTextContent('About 5 minutes left');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      await waitFor(() => expect(screen.getByTestId('countdown-value')).toHaveTextContent('4:5'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows no countdown without a limit', async () => {
    base(state({ time: timeOf({ limitMinutes: null }) }));
    mount(`/discovery/${T}`);
    await screen.findByTestId('session-meters');
    expect(screen.queryByTestId('meter-countdown')).toBeNull();
  });

  it('asks the creator at time-up: extend by 15 or wrap up', async () => {
    const up = state({
      waitingFor: 'time',
      time: timeOf({ elapsedMs: 30 * 60_000, up: true, running: false }),
    });
    const calls = base(up, { [`POST /api/discovery/${T}/time`]: () => ({ state: up }) });
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    const card = await screen.findByTestId('time-up');
    expect(card).toHaveTextContent('The time limit is up');
    expect(screen.getByTestId('meter-countdown')).toHaveAttribute('data-state', 'up');
    await user.click(within(card).getByTestId('extend-15'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/time'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/time'))?.body).toEqual({ action: 'extend', minutes: 15 });
    await user.click(within(card).getByRole('button', { name: 'Wrap up now (capture)' }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/time'))).toHaveLength(2));
    expect(calls.filter((c) => c.url.endsWith('/time'))[1]?.body).toEqual({ action: 'wrap_up' });
  });

  it('tells a non-manager to wait at time-up', async () => {
    base(state({ canManage: false, waitingFor: 'time', time: timeOf({ up: true, running: false }) }));
    mount(`/discovery/${T}`);
    const card = await screen.findByTestId('time-up');
    expect(card).toHaveTextContent('Waiting for the session creator to extend or wrap up.');
    expect(within(card).queryByTestId('extend-10')).toBeNull();
  });

  it('edits the time limit with the cost limit; an empty field removes it', async () => {
    const calls = base(state({ time: timeOf() }), {
      [`PATCH /api/discovery/${T}`]: () => ({ state: state() }),
    });
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('set-budget'));
    await user.clear(screen.getByLabelText('Time limit (minutes)'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ timeBoxMinutes: null });
  });

  it('shows an archived session read-only and lets the creator reopen it', async () => {
    const calls = base(state({ config: { ...state().config, archived: true } }), {
      [`POST /api/sessions/${T}/archive`]: () => ({ session: {} }),
    });
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    expect(await screen.findByTestId('archived-banner')).toHaveTextContent('read-only');
    expect(screen.queryByPlaceholderText(/Write to the analyst|Answer above/)).toBeNull();
    expect(screen.queryByTestId('pause-session')).toBeNull();
    expect(screen.queryByTestId('option-o1')).toBeNull();
    await user.click(screen.getByTestId('reopen-session'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/archive'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/archive'))?.body).toEqual({ archived: false });
  });

  it('archives and deletes a session (delete asks first and returns to the list)', async () => {
    const calls = base(state(), {
      [`POST /api/sessions/${T}/archive`]: () => ({ session: {} }),
      [`DELETE /api/sessions/${T}`]: () => ({}),
    });
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('archive-session'));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/archive'))?.body).toEqual({ archived: true }),
    );
    await user.click(screen.getByTestId('delete-session'));
    const dlg = await screen.findByRole('dialog');
    expect(dlg).toHaveTextContent('Delete this session?');
    await user.click(within(dlg).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(await screen.findByText('No discovery sessions yet')).toBeInTheDocument();
  });

  it('queues the hand-off when no BA is online, and recommends hiring one when there is none', async () => {
    const approved = {
      id: DOC,
      kind: 'prd' as const,
      title: 'PRD',
      status: 'approved' as const,
      currentVersion: 1,
    };
    const queued = state({
      questions: [],
      baStatus: 'none',
      documents: [{ ...approved, status: 'handed_off' }],
      config: {
        ...state().config,
        handoff: { state: 'queued', at: AT, by: 'u', reason: 'no_ba' },
      },
    });
    let current = state({ questions: [], baStatus: 'none', documents: [approved] });
    const calls = base(current, {
      [`GET /api/discovery/${T}`]: () => ({ state: current }),
      [`GET /api/documents/${DOC}`]: () => ({}),
      'GET /api/workstations': () => ({ workstations: [myStation('w1', 'Laptop')] }),
      [`POST /api/discovery/${T}/hand-to-ba`]: () => {
        current = queued;
        return { intakeId: null, queued: true, state: queued };
      },
      'POST /api/agents': () => ({}),
    });
    mount(`/discovery/${T}`);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('hand-to-ba'));
    expect(await screen.findByTestId('handoff-queued')).toHaveTextContent(
      'Handed off. Waiting for a BA to come online; the intake starts on its own.',
    );
    const hire = await screen.findByTestId('hire-ba');
    expect(hire).toHaveTextContent('no BA yet');
    // not a one-click hire any more: the button opens the full hire dialog, prefilled (role, seniority and the session's project)
    const link = within(hire).getByTestId('hire-ba-button');
    expect(link).toHaveAttribute('href', expect.stringMatching(/^\/agents\?hire=ba&seniority=junior/));
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/agents')).toBe(false);
  });

  it('asks for the CEO pre-draft turn cap only in prep mode, between 2 and 40', async () => {
    const calls = stub({
      ...meHandlers,
      'GET /api/sessions': () => ({ sessions: [] }),
      'GET /api/projects': () => ({ projects: [] }),
      'GET /api/ceo/status': () => ({ state: 'active' }),
      'GET /api/workstations': () => ({ workstations: [myStation('w1', 'Laptop')] }),
      'POST /api/discovery': () => ({ state: state() }),
      'GET /api/discovery/': () => ({ state: state() }),
      'GET /api/threads/': () => thread(),
    });
    mount('/discovery');
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('new-discovery'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Prep');
    await waitFor(() => expect(within(dialog).getByLabelText('CEO')).toBeInTheDocument());
    expect(within(dialog).queryByTestId('prep-cap')).toBeNull();
    await user.selectOptions(within(dialog).getByLabelText('CEO'), 'ceo_prep');
    const cap = within(dialog).getByTestId('prep-cap');
    expect(cap).toHaveValue(12);
    const start = within(dialog).getByRole('button', { name: 'Start' });
    await user.clear(cap);
    await user.type(cap, '1');
    expect(start).toBeDisabled();
    await user.clear(cap);
    await user.type(cap, '41');
    expect(start).toBeDisabled();
    await user.clear(cap);
    await user.type(cap, '20');
    expect(start).toBeEnabled();
    // no budget by default: nothing about cost is sent
    await user.click(start);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/discovery')).toBe(true),
    );
    const body = calls.find((c) => c.method === 'POST' && c.url === '/api/discovery')?.body;
    expect(body).toMatchObject({ ceoMode: 'ceo_prep', prepTurnCap: 20 });
    expect(body).not.toHaveProperty('budgetUsd');
    expect(body).not.toHaveProperty('timeBoxMinutes');
  });

  it('offers the New button to every member', async () => {
    stub({
      'GET /api/auth/me': () => ({
        user: { id: 'u', email: 'm@example.com', displayName: 'Member' },
        activeOrg: { id: 'o', name: 'Org', role: 'member' },
      }),
      'GET /api/sessions': () => ({ sessions: [] }),
    });
    mount('/discovery');
    expect(await screen.findByTestId('new-discovery')).toBeInTheDocument();
  });
});
