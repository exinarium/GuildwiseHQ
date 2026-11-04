import type { DeskItemDto, JourneyDefinition } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormOfflineLinkBlock } from '../components/desk/FormOfflineLinkBlock.tsx';
import { InstanceWaitPanel } from '../components/journeys/InstanceWaitPanel.tsx';
import { ToastProvider } from '../components/ui.tsx';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const W1 = '0192f3a0-0000-7000-8000-0000000000a1';
const I1 = '0192f3a0-0000-7000-8000-0000000000b1';
const R1 = '0192f3a0-0000-7000-8000-0000000000c1';

let posts: string[];
let waits: unknown;
beforeEach(() => {
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (init.method === 'POST') {
        posts.push(url);
        return url.endsWith('/email') ? json({ email: 'ann@client.example' }) : json({ ok: true });
      }
      if (url.endsWith('/waits')) return json(waits);
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
const def = (): JourneyDefinition =>
  ({
    name: 'J',
    description: '',
    recordType: 'client',
    firstStepId: 'w',
    steps: [{ kind: 'wait', id: 'w', label: 'Documents' }],
    handoffs: [],
  }) as unknown as JourneyDefinition;
const wait = (offline: unknown) => ({
  id: W1,
  visit: 1,
  stepId: 'w',
  kind: 'form',
  status: 'open',
  startedAt: null,
  deadlineAt: null,
  nextFireAt: null,
  remindersSent: 0,
  remindersMax: null,
  linkUrl: null,
  linkExpiresAt: null,
  fellBack: false,
  resolution: null,
  resolvedAt: null,
  events: [],
  offline,
});

describe('the instance wait panel', () => {
  it('shows the "documents pending, runner offline" badge with its start time, then the emailed link', async () => {
    waits = {
      waits: [
        wait({
          requestId: R1,
          status: 'held',
          since: '2026-11-04T10:00:00.000Z',
          linkSentAt: null,
          linkExpiresAt: null,
        }),
      ],
      calls: [],
    };
    const first = wrap(<InstanceWaitPanel instanceId={I1} def={def()} active />);
    expect(await screen.findByText('Documents pending, runner offline')).toBeTruthy();
    expect(screen.getByTestId('wait-offline').textContent).toMatch(/Runner offline since/);
    expect(screen.getByTestId('wait-offline').textContent).toMatch(/emailed when the runner is back/);
    first.unmount();

    waits = {
      waits: [
        wait({
          requestId: R1,
          status: 'sent',
          since: '2026-11-04T10:00:00.000Z',
          linkSentAt: '2026-11-04T12:00:00.000Z',
          linkExpiresAt: '2026-11-11T12:00:00.000Z',
        }),
      ],
      calls: [],
    };
    wrap(<InstanceWaitPanel instanceId={I1} def={def()} active />);
    await waitFor(() =>
      expect(screen.getByTestId('wait-offline').textContent).toMatch(/Secure link emailed/),
    );
  });

  it('shows no badge for a wait without an offline case or with a closed one', async () => {
    waits = {
      waits: [
        wait(null),
        {
          ...wait({
            requestId: R1,
            status: 'submitted',
            since: '2026-11-04T10:00:00.000Z',
            linkSentAt: null,
            linkExpiresAt: null,
          }),
          id: 'w2',
        },
      ],
      calls: [],
    };
    wrap(<InstanceWaitPanel instanceId={I1} def={def()} active />);
    await screen.findAllByTestId(/^wait-/);
    expect(screen.queryByText('Documents pending, runner offline')).toBeNull();
  });
});

describe('the desk notice of a case', () => {
  const item = (subkind = 'form_offline_link', data: Record<string, string> = {}): DeskItemDto =>
    ({
      id: 'd1',
      kind: 'alert',
      subkind,
      status: 'open',
      canAnswer: true,
      data: {
        requestId: R1,
        formId: 'f1',
        formTitle: 'Rental application',
        clientReference: 'CL-1042',
        recordName: 'Ann Client',
        attemptedAt: '2026-11-04T10:00:00.000Z',
        linkSentAt: '2026-11-04T12:00:00.000Z',
        linkExpiresAt: '2026-11-11T12:00:00.000Z',
        journeyName: 'Rentals',
        instanceId: I1,
        waitId: W1,
        ...data,
      },
    }) as unknown as DeskItemDto;

  it('shows who, when and which journey, and never an email address until Show email is pressed', async () => {
    const u = userEvent.setup();
    wrap(<FormOfflineLinkBlock item={item()} />);
    const block = screen.getByTestId('form-offline-desk-item');
    expect(block.textContent).toContain('CL-1042, Ann Client');
    expect(block.textContent).toContain('Rental application');
    expect(block.textContent).toContain('Rentals');
    expect(block.textContent).not.toContain('@');
    await u.click(screen.getByTestId('form-offline-show'));
    expect((await screen.findByTestId('form-offline-email')).textContent).toContain('ann@client.example');
    await u.click(screen.getByTestId('form-offline-resend'));
    await waitFor(() => expect(posts).toContain(`/api/forms/offline-requests/${R1}/resend`));
  });

  it('Continue journey asks first, then calls the existing wait route', async () => {
    const u = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    wrap(<FormOfflineLinkBlock item={item()} />);
    await u.click(screen.getByTestId('form-offline-continue'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('secure link will stop working'));
    await waitFor(() => expect(posts).toContain(`/api/journey-waits/${W1}/continue`));
    confirm.mockRestore();
  });

  it('a public-URL case has no Continue button, and a "not sent" notice has no actions', () => {
    const first = wrap(
      <FormOfflineLinkBlock item={item('form_offline_link', { waitId: '', instanceId: '' })} />,
    );
    expect(screen.queryByTestId('form-offline-continue')).toBeNull();
    first.unmount();
    wrap(<FormOfflineLinkBlock item={item('form_offline_hold_expired')} />);
    expect(screen.queryByTestId('form-offline-show')).toBeNull();
  });
});
