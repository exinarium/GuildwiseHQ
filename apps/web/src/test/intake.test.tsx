import type { DeskItemDto, IntakeDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EscalationTrail } from '../components/EscalationTrail.tsx';
import { describeSource, hasTrail, intakeStatusText, trailLabel } from '../lib/intake.ts';
import { DeskItem } from '../pages/Desk.tsx';
import { IntakeNew, IntakeView } from '../pages/Intake.tsx';
import { initSocket } from '../ws/socket.ts';

const ID = '0192f3a0-0000-7000-8000-0000000000f1';
const THREAD = '0192f3a0-0000-7000-8000-0000000000f2';
const DESK = '0192f3a0-0000-7000-8000-0000000000f3';

const intake = (over: Partial<IntakeDto> = {}): IntakeDto => ({
  id: ID,
  threadId: THREAD,
  externalSystem: 'jira',
  externalKey: 'ABC-123',
  status: 'open',
  mappedProjectId: null,
  mappedProjectKey: null,
  mappingDeskItemId: null,
  baAgentId: '0192f3a0-0000-7000-8000-0000000000a9',
  baAgentName: 'Ben',
  workstationOnline: true,
  cards: [],
  createdAt: '2026-10-03T10:00:00.000Z',
  ...over,
});

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  const sock = initSocket(new QueryClient());
  sock.enableMockTransport();
  sock.start();
});

function stub(handlers: Record<string, (init: RequestInit) => unknown>) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const key = Object.keys(handlers).find((k) => `${method} ${url}`.startsWith(k));
      const body = key ? handlers[key]?.(init) : {};
      return new Response(JSON.stringify(body), { status: method === 'POST' ? 201 : 200 });
    }),
  );
  return calls;
}

const mount = (path: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/intake" element={<IntakeNew />} />
          <Route path="/intake/:id" element={<IntakeView />} />
          <Route path="/desk" element={<p>the desk</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('intake helpers', () => {
  it('recognises what the manager pasted', () => {
    expect(describeSource('ABC-123').label).toMatch(/Jira ticket ABC-123/);
    expect(describeSource('see acme/web#12').label).toMatch(/GitHub issue acme\/web#12/);
    expect(describeSource('build a dark mode').ref).toBeNull();
    expect(intakeStatusText({ status: 'mapped', mappedProjectKey: 'TOY' })).toBe('Mapped to TOY');
    expect(intakeStatusText({ status: 'unmapped', mappedProjectKey: null })).toMatch(/pick the project/);
    expect(intakeStatusText({ status: 'open', mappedProjectKey: null })).toBe('Open');
  });

  it('words the escalation trail', () => {
    const at = '2026-10-03T10:00:00.000Z';
    expect(trailLabel({ at, step: 'asked', agentName: 'Bea', role: 'builder' })).toBe('Bea (builder) asked');
    expect(trailLabel({ at, step: 'peer', agentName: 'Sam', role: 'builder' })).toBe('Sam (builder)');
    expect(trailLabel({ at, step: 'desk' })).toBe('the desk');
    expect(trailLabel({ at, step: 'answered', agentName: 'Ben', role: 'ba' })).toBe('answered by Ben (ba)');
    expect(trailLabel({ at, step: 'merged', note: 'Bea (builder) asked the same: merged' })).toBe(
      'Bea (builder) asked the same: merged',
    );
    expect(trailLabel({ at, step: 'merged' })).toBe('merged with a similar open question');
    expect(hasTrail({ escalationTrail: [{ at, step: 'asked' }] })).toBe(false);
    expect(
      hasTrail({
        escalationTrail: [
          { at, step: 'asked' },
          { at, step: 'desk' },
        ],
      }),
    ).toBe(true);
  });
});

describe('Intake page', () => {
  it('starts an intake from a pasted ticket and opens the conversation', async () => {
    const calls = stub({
      'GET /api/intakes/': () => ({ intake: intake() }),
      'POST /api/intakes': () => ({ intake: intake() }),
      'GET /api/intakes': () => ({ intakes: [] }),
      'GET /api/threads/': () => ({ threadId: THREAD, kind: 'intake', hasMore: false, messages: [] }),
    });
    mount('/intake');
    const user = userEvent.setup();
    const start = screen.getByRole('button', { name: 'Start intake' });
    expect(start).toBeDisabled();
    await user.type(screen.getByLabelText('Ticket or need'), 'ABC-123');
    expect(screen.getByTestId('intake-source')).toHaveTextContent('Jira ticket ABC-123');
    await user.click(start);
    expect(await screen.findByText('Intake ABC-123')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ note: 'ABC-123' });
    expect(await screen.findByTestId('chat-panel')).toBeInTheDocument();
    expect(screen.getByTestId('intake-no-cards')).toBeInTheDocument();
  });

  it('shows the cards the BA created, linked to the card pages, and the BA being offline', async () => {
    stub({
      'GET /api/intakes/': () => ({
        intake: intake({
          status: 'mapped',
          mappedProjectKey: 'TOY',
          workstationOnline: false,
          cards: [
            {
              id: '0192f3a0-0000-7000-8000-0000000000c1',
              ref: 'TOY-7',
              title: 'Add the login page',
              stage: 'build',
              status: 'queued',
              projectKey: 'TOY',
            },
          ],
        }),
      }),
      'GET /api/threads/': () => ({ threadId: THREAD, kind: 'intake', hasMore: false, messages: [] }),
    });
    mount(`/intake/${ID}`);
    expect(await screen.findByTestId('intake-status')).toHaveTextContent('Mapped to TOY');
    const card = screen.getByTestId('intake-card-TOY-7');
    expect(card).toHaveTextContent('Add the login page');
    expect(within(card).getByRole('link')).toHaveAttribute('href', '/cards/TOY-7');
    expect(await screen.findByTestId('chat-offline')).toHaveTextContent('Ben is offline');
  });

  it('points an unmapped intake at the desk question', async () => {
    stub({
      'GET /api/intakes/': () => ({ intake: intake({ status: 'unmapped', mappingDeskItemId: DESK }) }),
      'GET /api/threads/': () => ({ threadId: THREAD, kind: 'intake', hasMore: false, messages: [] }),
    });
    mount(`/intake/${ID}`);
    const note = await screen.findByTestId('intake-mapping-note');
    expect(within(note).getByRole('link', { name: 'Pick the project' })).toHaveAttribute(
      'href',
      `/desk#desk-item-${DESK}`,
    );
  });
});

const deskBase: DeskItemDto = {
  id: DESK,
  kind: 'question',
  subkind: null,
  status: 'open',
  routedTo: 'manager',
  title: 'Tabs or spaces?',
  body: '',
  doing: '',
  options: [
    { id: 'o1', label: 'tabs' },
    { id: 'o2', label: 'spaces' },
  ],
  recommendation: null,
  blocking: true,
  pinned: true,
  urgent: true,
  affectedCardIds: [],
  affectedCount: 1,
  askedBy: { kind: 'agent', agentId: null, agentName: 'Bea', role: 'builder' },
  card: null,
  projectId: null,
  dedupEntries: [],
  answer: null,
  answerOption: null,
  answeredAt: null,
  answeredByName: null,
  decisionPolicy: null,
  canAnswer: true,
  createdAt: '2026-10-03T10:00:00.000Z',
};

const renderItem = (i: DeskItemDto) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DeskItem item={i} now={Date.parse('2026-10-03T12:00:00.000Z')} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('desk: escalation trail', () => {
  const at = '2026-10-03T10:00:00.000Z';
  it('shows who looked at the question on its way to the desk', () => {
    renderItem({
      ...deskBase,
      escalationTrail: [
        { at, step: 'asked', agentName: 'Bea', role: 'builder' },
        { at, step: 'peer', agentName: 'Sam', role: 'builder' },
        { at, step: 'ba', agentName: 'Ben', role: 'ba', note: 'I could not find it in the ledger' },
        { at, step: 'desk', note: 'only the manager can decide style' },
      ],
    });
    const steps = screen.getAllByTestId('trail-step');
    expect(steps.map((s) => s.getAttribute('data-step'))).toEqual(['asked', 'peer', 'ba', 'desk']);
    expect(steps[0]).toHaveTextContent('Bea (builder) asked');
    expect(steps[1]).toHaveTextContent('Sam (builder)');
    expect(steps[2]).toHaveTextContent('Ben (ba): I could not find it in the ledger');
    expect(steps[3]).toHaveTextContent('the desk: only the manager can decide style');
  });

  it('shows nothing for a question that went straight to the desk', () => {
    renderItem({ ...deskBase, escalationTrail: [{ at, step: 'asked', agentName: 'Bea', role: 'builder' }] });
    expect(screen.queryByTestId('escalation-trail')).toBeNull();
    const { container } = render(<EscalationTrail item={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('desk: mapping question', () => {
  const mapping: DeskItemDto = {
    ...deskBase,
    subkind: 'unmapped_ticket',
    title: 'Which project does ABC-777 belong to?',
    blocking: false,
    pinned: false,
    urgent: false,
    affectedCount: 0,
    intakeId: ID,
    options: [
      { id: '0192f3a0-0000-7000-8000-0000000000b1', label: 'TOY: Toy' },
      { id: '0192f3a0-0000-7000-8000-0000000000b2', label: 'WEB: Web app' },
    ],
  };

  it('offers the projects, links to the intake and answers with the chosen project and a ledger decision', async () => {
    const calls = stub({ 'POST /api/desk/': () => ({ ok: true }) });
    renderItem(mapping);
    expect(screen.getByText('Unmapped ticket')).toBeInTheDocument();
    expect(screen.getByTestId('mapping-intake-link')).toHaveAttribute('href', `/intake/${ID}`);
    expect(screen.queryByRole('form', { name: 'Answer' })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Map to project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick the project');
    await user.click(screen.getByRole('radio', { name: 'WEB: Web app' }));
    await user.click(screen.getByRole('button', { name: 'Map to project' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.url).toBe(`/api/desk/${DESK}/answer`);
    expect(calls[0]?.body).toEqual({
      answer: 'WEB: Web app',
      optionId: '0192f3a0-0000-7000-8000-0000000000b2',
      ledger: { scope: 'decision', title: 'ABC-777 belongs to WEB: Web app' },
    });
  });
});
