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
import { render, screen, waitFor, within } from '@testing-library/react';
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
  cost: { costMicros: 120_000, costUsd: 0.12, turns: 3, budgetUsd: 5, exceeded: false },
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

  it('puts Discovery and Documents in the navigation for managers', () => {
    const manager = buildNav({ projectKey: null, canManage: true });
    expect(manager.sections.flatMap((s) => s.items).map((i) => i.id)).toEqual(
      expect.arrayContaining(['discovery', 'documents']),
    );
    const member = buildNav({ projectKey: null, canManage: false });
    const ids = member.sections.flatMap((s) => s.items).map((i) => i.id);
    expect(ids).not.toContain('discovery');
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
      cost: { costMicros: 500_000, costUsd: 0.5, turns: 2, budgetUsd: null, exceeded: false },
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
    await user.selectOptions(within(dialog).getByLabelText('Time box'), '30');
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
        cost: { costMicros: 5_100_000, costUsd: 5.1, turns: 9, budgetUsd: 5, exceeded: true },
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
