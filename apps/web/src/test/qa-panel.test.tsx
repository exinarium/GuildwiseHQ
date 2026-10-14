import type { CardQa, DeskItemDto, ProjectDetailResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualQaPanel } from '../components/ManualQaPanel.tsx';
import { QaDeskItem } from '../components/QaDeskItem.tsx';
import { QaPanel } from '../components/QaPanel.tsx';
import { countSteps, parseQaSteps } from '../lib/qaSteps.ts';

const CARD = '0192f3a0-0000-7000-8000-0000000000c1';
const ME = '0192f3a0-0000-7000-8000-0000000000a1';
const OTHER = '0192f3a0-0000-7000-8000-0000000000a2';
const PROJECT = '0192f3a0-0000-7000-8000-000000000001';

const STEPS = `## Happy path
- [ ] Export archived items; expect them in the file
- [x] Open the export page
## Edge cases
- [ ] Export an empty project; expect an empty file
Remember to check the **header** row.`;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const qa = (over: Partial<CardQa> = {}): CardQa => ({
  state: 'open',
  assignee: { userId: ME, name: 'Pieter' },
  source: 'owner',
  openedAt: '2026-10-14T10:00:00.000Z',
  steps: STEPS,
  stepsBy: 'Tess',
  decision: null,
  sentBackCount: 0,
  heldComment: null,
  canAct: true,
  members: [
    { userId: ME, name: 'Pieter' },
    { userId: OTHER, name: 'Sam' },
  ],
  deskItemId: null,
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

describe('parseQaSteps', () => {
  it('groups checklist lines under their scenario heading and keeps other lines as notes', () => {
    const list = parseQaSteps(STEPS);
    expect(list.map((s) => s.title)).toEqual(['Happy path', 'Edge cases']);
    expect(countSteps(list)).toBe(3);
    expect(list[0]?.items.map((i) => [i.kind, i.done])).toEqual([
      ['step', false],
      ['step', true],
    ]);
    // emphasis marks are dropped, nothing is interpreted as markup
    expect(list[1]?.items[1]).toMatchObject({ kind: 'note', text: 'Remember to check the header row.' });
  });

  it('tolerates a list with no headings and plain bullets', () => {
    const list = parseQaSteps('- do this\n- [ ] check that <b>x</b>');
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBeNull();
    expect(list[0]?.items.map((i) => i.kind)).toEqual(['note', 'step']);
    expect(list[0]?.items[1]?.text).toBe('check that <b>x</b>');
  });

  it('an empty text gives no scenarios', () => {
    expect(parseQaSteps('  \n\n')).toEqual([]);
  });
});

describe('QA panel', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(json({}));
    vi.stubGlobal('fetch', fetchMock);
    window.localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  const lastCall = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, method: init.method, body: JSON.parse(String(init.body)) };
  };

  it('shows the steps as a checklist by scenario and counts the ticks', async () => {
    const user = userEvent.setup();
    wrap(<QaPanel cardId={CARD} qa={qa()} />);
    expect(screen.getByTestId('qa-state')).toHaveTextContent('Waiting for the test');
    expect(screen.getAllByTestId('qa-scenario')).toHaveLength(2);
    const boxes = screen.getAllByTestId('qa-step');
    expect(boxes).toHaveLength(3);
    expect(screen.getByTestId('qa-progress')).toHaveTextContent('1 of 3 steps ticked');
    await user.click(boxes[0] as HTMLElement);
    expect(screen.getByTestId('qa-progress')).toHaveTextContent('2 of 3 steps ticked');
  });

  it('pass sends the optional note', async () => {
    const user = userEvent.setup();
    wrap(<QaPanel cardId={CARD} qa={qa()} />);
    await user.type(screen.getByTestId('qa-note'), 'looks right');
    await user.click(screen.getByTestId('qa-pass'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastCall()).toEqual({
      url: `/api/cards/${CARD}/qa/pass`,
      method: 'POST',
      body: { note: 'looks right' },
    });
  });

  it('skip sends the reason', async () => {
    const user = userEvent.setup();
    wrap(<QaPanel cardId={CARD} qa={qa()} />);
    await user.type(screen.getByTestId('qa-note'), 'no time');
    await user.click(screen.getByTestId('qa-skip'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastCall()).toEqual({
      url: `/api/cards/${CARD}/qa/skip`,
      method: 'POST',
      body: { reason: 'no time' },
    });
  });

  it('send back needs a comment', async () => {
    const user = userEvent.setup();
    wrap(<QaPanel cardId={CARD} qa={qa()} />);
    await user.click(screen.getByTestId('qa-send-back'));
    expect(screen.getByTestId('qa-send-back-confirm')).toBeDisabled();
    await user.type(screen.getByTestId('qa-send-back-comment'), 'the file is empty');
    await user.click(screen.getByTestId('qa-send-back-confirm'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastCall()).toEqual({
      url: `/api/cards/${CARD}/qa/send-back`,
      method: 'POST',
      body: { comment: 'the file is empty' },
    });
  });

  it('hands over to another member', async () => {
    const user = userEvent.setup();
    wrap(<QaPanel cardId={CARD} qa={qa()} />);
    await user.click(screen.getByTestId('qa-assign'));
    await user.selectOptions(screen.getByTestId('qa-assign-select'), OTHER);
    await user.click(screen.getByTestId('qa-assign-confirm'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastCall()).toEqual({
      url: `/api/cards/${CARD}/qa/assign`,
      method: 'POST',
      body: { userId: OTHER },
    });
  });

  it('is read-only for someone who may not act, and names who tests', () => {
    wrap(<QaPanel cardId={CARD} qa={qa({ canAct: false })} />);
    expect(screen.queryByTestId('qa-actions')).not.toBeInTheDocument();
    expect(screen.getByTestId('qa-assignee')).toHaveTextContent('Waiting for Pieter');
  });

  it('says so when the ticket update is held, and when there are no steps', () => {
    wrap(
      <QaPanel
        cardId={CARD}
        qa={qa({ steps: null, heldComment: { kind: 'resolution', externalKey: 'ABC-1', body: 'Done.' } })}
      />,
    );
    expect(screen.getByText('The update for ABC-1 is held')).toBeInTheDocument();
    expect(screen.getByTestId('qa-no-steps')).toBeInTheDocument();
  });

  it('shows the decision once it is made and offers no actions', () => {
    wrap(
      <QaPanel
        cardId={CARD}
        qa={qa({
          state: 'skipped',
          canAct: false,
          decision: { kind: 'skipped', byName: 'Pieter', note: 'no time', at: '2026-10-14T11:00:00.000Z' },
        })}
      />,
    );
    expect(screen.getByTestId('qa-state')).toHaveTextContent('Skipped (not tested)');
    expect(screen.getByTestId('qa-decision')).toHaveTextContent('Skipped (not tested)');
    expect(screen.queryByTestId('qa-actions')).not.toBeInTheDocument();
  });
});

describe('QA desk item', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(json({}));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const item = { id: 'd1', card: { id: CARD, ref: 'TOY-1' } } as unknown as DeskItemDto;

  it('passes with a note and sends back with a comment', async () => {
    const user = userEvent.setup();
    wrap(<QaDeskItem item={item} />);
    await user.click(screen.getByTestId('qa-desk-pass'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`/api/cards/${CARD}/qa/pass`);
    await user.click(screen.getByTestId('qa-desk-fail'));
    expect(screen.getByTestId('qa-desk-send-back')).toBeDisabled();
    await user.type(screen.getByTestId('qa-desk-note'), 'broken');
    await user.click(screen.getByTestId('qa-desk-send-back'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`/api/cards/${CARD}/qa/send-back`);
    expect(JSON.parse(String(init.body))).toEqual({ comment: 'broken' });
  });
});

describe('manual QA project setting', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(json({}));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const project = (over: Partial<ProjectDetailResponse['project']> = {}) =>
    ({ id: PROJECT, key: 'TOY', myRole: 'owner', ...over }) as ProjectDetailResponse['project'];

  it('is on by default and unticking calls the endpoint', async () => {
    const user = userEvent.setup();
    wrap(<ManualQaPanel projectId={PROJECT} project={project()} canChange />);
    expect(screen.getByTestId('manual-qa-state')).toHaveTextContent('On');
    await user.click(screen.getByTestId('manual-qa-toggle'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT}/manual-qa`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
  });

  it('is read-only when the person cannot change it', () => {
    wrap(<ManualQaPanel projectId={PROJECT} project={project({ manualQa: false })} canChange={false} />);
    expect(screen.getByTestId('manual-qa-state')).toHaveTextContent('Off');
    expect(screen.getByTestId('manual-qa-toggle')).toBeDisabled();
    expect(screen.getByTestId('manual-qa-readonly')).toBeInTheDocument();
  });
});
