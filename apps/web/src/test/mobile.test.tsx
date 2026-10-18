import type { DeskItemDto, WorkflowDefinition } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { MoveToSheet } from '../components/cards/MoveToSheet.tsx';
import { DiffView } from '../components/DiffView.tsx';
import { NewCardFiles } from '../components/NewCardFiles.tsx';
import { BottomSheet } from '../components/ui/BottomSheet.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { DeskCard, DeskItem } from '../pages/Desk.tsx';
import { IntakeNew } from '../pages/Intake.tsx';
import { initSocket } from '../ws/socket.ts';

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
beforeEach(() => setMobile(true));
afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.unstubAllGlobals();
});

const wrap = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const desk = (over: Partial<DeskItemDto> = {}): DeskItemDto =>
  ({
    id: '0192f3a0-0000-7000-8000-000000000001',
    kind: 'approval',
    subkind: 'large_merge',
    status: 'open',
    routedTo: 'manager',
    title: 'Merge the big change?',
    body: 'It touches 40 files.',
    doing: null,
    options: [],
    recommendation: null,
    blocking: true,
    pinned: false,
    urgent: false,
    affectedCardIds: [],
    affectedCount: 1,
    askedBy: {
      kind: 'agent',
      agentId: '0192f3a0-0000-7000-8000-0000000000a1',
      agentName: 'Ada',
      role: 'builder',
    },
    card: {
      id: '0192f3a0-0000-7000-8000-0000000000c1',
      ref: 'TOY-7',
      title: 'Big',
      stage: 'build',
      status: 'blocked',
      projectKey: 'TOY',
    },
    projectId: '0192f3a0-0000-7000-8000-0000000000b1',
    dedupEntries: [],
    answer: null,
    answerOption: null,
    answeredAt: null,
    answeredByName: null,
    decisionPolicy: 'owner_only',
    canAnswer: true,
    createdAt: '2026-10-03T10:00:00.000Z',
    ...over,
  }) as DeskItemDto;

describe('mobile desk', () => {
  it('shows a compact card with priority, project, card and age, and opens on tap', async () => {
    const onOpen = vi.fn();
    wrap(<DeskCard item={desk()} now={Date.parse('2026-10-03T12:00:00.000Z')} onOpen={onOpen} />);
    const btn = screen.getByRole('button', { name: 'Merge the big change?' });
    expect(btn).toHaveTextContent('Blocking');
    expect(btn).toHaveTextContent('TOY-7');
    expect(btn).toHaveTextContent('2h ago');
    await userEvent.click(btn);
    expect(onOpen).toHaveBeenCalled();
  });

  it('approving is tap plus confirm: nothing is sent until the confirmation sheet is accepted', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    wrap(<DeskItem item={desk()} bare />);
    await userEvent.click(screen.getByTestId('desk-approve'));
    expect(fetchMock).not.toHaveBeenCalled();
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Approve merge' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/desk/0192f3a0-0000-7000-8000-000000000001/resolve');
    expect(JSON.parse(String(init.body))).toMatchObject({ resolution: 'approved' });
  });

  it('on desktop approving stays one tap', async () => {
    setMobile(false);
    const fetchMock = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    wrap(<DeskItem item={desk()} />);
    await userEvent.click(screen.getByTestId('desk-approve'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});

const DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-old
+new ${'long '.repeat(40)}
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-x
+y
`;

describe('mobile approval diff', () => {
  it('is a unified accordion: files start closed with +/- counts, wrap toggle, old line column hidden', async () => {
    wrap(<DiffView diff={DIFF} />);
    const toggles = screen.getAllByTestId('diff-file-toggle');
    expect(toggles).toHaveLength(2);
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'false');
    expect(toggles[0]).toHaveTextContent('+1');
    expect(toggles[0]).toHaveTextContent('-1');
    expect(screen.getByTestId('diff-wrap')).toBeChecked();
    await userEvent.click(toggles[0] as HTMLElement);
    const body = screen.getByTestId('diff-file-body');
    expect(body.querySelector('td.max-md\\:hidden')).not.toBeNull();
    expect(body.querySelector('td.whitespace-pre-wrap')).not.toBeNull();
    await userEvent.click(screen.getByTestId('diff-wrap'));
    expect(body.querySelector('td.whitespace-pre-wrap')).toBeNull();
  });

  it('a single file opens at once', () => {
    wrap(<DiffView diff={DIFF.split('diff --git a/b.ts')[0] as string} />);
    expect(screen.getByTestId('diff-file-toggle')).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('BottomSheet', () => {
  it('is a modal dialog that closes on Escape', async () => {
    const onOpenChange = vi.fn();
    wrap(
      <BottomSheet open onOpenChange={onOpenChange} title="Hello" footer={<button type="button">Go</button>}>
        body
      </BottomSheet>,
    );
    const dlg = screen.getByRole('dialog', { name: 'Hello' });
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('Move to... sheet', () => {
  const wf = {
    key: 'code-v6',
    version: 1,
    name: 'Code',
    stages: [
      { id: 'build', label: 'Build', column: 'in_progress', kind: 'agent' },
      { id: 'review', label: 'Review', column: 'review', kind: 'agent' },
    ],
  } as unknown as WorkflowDefinition;

  it('lists the stages, requires a reason and posts the same move request as the desktop dialog', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    wrap(
      <MoveToSheet
        open
        onClose={onClose}
        workflow={wf}
        card={{ id: 'card-1', ref: 'TOY-1', stage: 'build' }}
      />,
    );
    expect(screen.getByTestId('move-to-build')).toBeDisabled();
    await userEvent.click(screen.getByTestId('move-to-review'));
    await userEvent.click(screen.getByRole('button', { name: 'Move card' }));
    expect(screen.getByText('A reason is required')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Reason'), 'ready for review');
    await userEvent.click(screen.getByRole('button', { name: 'Move card' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/cards/card-1/move');
    expect(JSON.parse(String(init.body))).toEqual({ toStage: 'review', reason: 'ready for review' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('mobile chat composer', () => {
  it('sticks to the bottom of the conversation and sends', async () => {
    const qc = new QueryClient();
    const socket = initSocket(qc);
    socket.enableMockTransport();
    socket.start();
    const sendChat = vi.spyOn(socket, 'sendChat').mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        json(
          String(url).startsWith('/api/chats')
            ? { chats: [] }
            : { threadId: 't1', kind: 'chat', hasMore: false, messages: [] },
        ),
      ),
    );
    wrap(<ChatPanel threadId="t1" agentName="Ada" online />);
    const form = await screen.findByRole('form', { name: 'Compose' });
    expect(form.className).toContain('max-md:sticky');
    await userEvent.type(screen.getByLabelText('Message'), 'hi there');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sendChat).toHaveBeenCalledWith('t1', 'hi there', expect.any(String));
  });
});

describe('mobile intake', () => {
  it('has a full-width large submit and a camera-friendly file input', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json([])),
    );
    wrap(<IntakeNew />);
    const submit = screen.getByRole('button', { name: 'Start intake' });
    expect(submit.className).toContain('max-md:w-full');
    expect(submit.className).toContain('h-11');
    wrap(<NewCardFiles files={[]} onChange={() => undefined} />);
    expect(screen.getByTestId('new-card-file-input').getAttribute('accept')).toContain('image/*');
  });
});
