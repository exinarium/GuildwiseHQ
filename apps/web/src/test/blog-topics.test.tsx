import { DIAGNOSTICS_CONSENT_VERSION, type OrgDetailResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeneralTab } from '../components/orgsettings/GeneralTab.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { PlatformBlog } from '../pages/platform/PlatformBlog.tsx';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const wrap = (ui: React.ReactNode, path = '/') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

const topic = (over: Record<string, unknown> = {}) => ({
  id: '33333333-3333-4333-8333-333333333333',
  question: 'How can AI agents authorize production deploys safely?',
  area: 'deploy',
  origin: 'platform',
  status: 'queued',
  reason: null,
  postId: null,
  slug: null,
  queuedAt: '2026-10-19T08:00:00.000Z',
  updatedAt: '2026-10-19T08:00:00.000Z',
  ...over,
});

let topics: ReturnType<typeof topic>[] = [];
let calls: Array<{ url: string; method: string; body?: string }> = [];
let addReply: () => Response = () => json({});

beforeEach(() => {
  calls = [];
  topics = [
    topic(),
    topic({
      id: '44444444-4444-4444-8444-444444444444',
      question: 'What does an AI code review cost per pull request?',
      area: 'cost',
      origin: 'customer',
      status: 'published',
      slug: 'ai-code-review-cost',
    }),
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: String(init.body) } : {}) });
      if (url.startsWith('/api/platform/blog/topics')) {
        if (init?.method === 'POST' && url.endsWith('/topics')) return addReply();
        return json({ topics, queued: topics.filter((t) => t.status === 'queued').length });
      }
      if (url.startsWith('/api/org')) return json({});
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('Platform > Blog > Topics', () => {
  it('lists the queue with status and source, and never shows an organization', async () => {
    wrap(<PlatformBlog />, '/platform/blog?tab=topics');
    const table = await screen.findByTestId('topics-table');
    expect(within(table).getByText('How can AI agents authorize production deploys safely?')).toBeTruthy();
    const row = screen.getByTestId('topic-row-33333333-3333-4333-8333-333333333333');
    expect(within(row).getByText('Queued')).toBeTruthy();
    expect(within(table).getByText('Published')).toBeTruthy();
    expect(within(table).getByText('Community')).toBeTruthy();
    expect(within(table).getByText('ai-code-review-cost').getAttribute('href')).toBe(
      '/blog/ai-code-review-cost',
    );
  });

  it('adds a typed question', async () => {
    addReply = () => json({ topicId: 'x', status: 'queued', topics, queued: 1 });
    wrap(<PlatformBlog />, '/platform/blog?tab=topics');
    const user = userEvent.setup();
    await user.type(
      await screen.findByTestId('topic-question'),
      'How should agents handle secrets in builds?',
    );
    await user.selectOptions(screen.getByTestId('topic-area'), 'secrets');
    await user.click(screen.getByTestId('topic-add'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/topics'))).toBe(true),
    );
    const sent = JSON.parse(calls.find((c) => c.method === 'POST')?.body ?? '{}');
    expect(sent).toMatchObject({ question: 'How should agents handle secrets in builds?', area: 'secrets' });
  });

  it('shows the findings when the question is refused, and offers to confirm an unknown name', async () => {
    addReply = () =>
      json(
        {
          error: {
            code: 'topic_rejected',
            message: 'no',
            details: [{ code: 'unknown_proper_noun', detail: 'Zebrafish', overridable: true }],
          },
        },
        400,
      );
    wrap(<PlatformBlog />, '/platform/blog?tab=topics');
    const user = userEvent.setup();
    await user.type(
      await screen.findByTestId('topic-question'),
      'How can agents deploy to Zebrafish safely?',
    );
    await user.click(screen.getByTestId('topic-add'));
    const findings = await screen.findByTestId('topic-findings');
    expect(within(findings).getByText(/not a known public technology/)).toBeTruthy();
    await user.click(within(findings).getByTestId('topic-confirm-terms'));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toContain('"allowTerms":["Zebrafish"]'),
    );
  });

  it('removes a queued topic with a reason', async () => {
    wrap(<PlatformBlog />, '/platform/blog?tab=topics');
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('topic-reject-33333333-3333-4333-8333-333333333333'));
    await user.type(screen.getByTestId('topic-reason-33333333-3333-4333-8333-333333333333'), 'off brand');
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/33333333-3333-4333-8333-333333333333/reject'))).toBe(true),
    );
  });
});

const org = (over: Partial<OrgDetailResponse> = {}) =>
  ({
    id: '55555555-5555-4555-8555-555555555555',
    name: 'Acme',
    role: 'owner',
    status: 'active',
    plan: 'team',
    planName: 'Team',
    features: {},
    requireTwoFactor: false,
    diagnosticsSharing: false,
    diagnosticsSharingAvailable: true,
    simulation: false,
    banners: [],
    owner: { id: '66666666-6666-4666-8666-666666666666', displayName: 'Owner', email: 'o@example.com' },
    createdAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }) as OrgDetailResponse;

describe('Settings > General: Share diagnostic data with Guildwise', () => {
  it('is hidden while the consent is not available for the organization', () => {
    wrap(
      <GeneralTab
        org={org({ diagnosticsSharingAvailable: false })}
        userId="66666666-6666-4666-8666-666666666666"
      />,
    );
    expect(screen.queryByTestId('diagnostics-sharing')).toBeNull();
  });

  it('shows the consent text before the Owner agrees, and sends the version they saw', async () => {
    wrap(<GeneralTab org={org()} userId="66666666-6666-4666-8666-666666666666" />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('diagnostics-sharing-toggle'));
    expect(await screen.findByTestId('diagnostics-consent-text')).toBeTruthy();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'I agree, share' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === 'PATCH')?.body ?? '{}')).toEqual({
      diagnosticsSharing: true,
      consentVersion: DIAGNOSTICS_CONSENT_VERSION,
    });
  });

  it('is read-only for an Admin', () => {
    wrap(<GeneralTab org={org({ role: 'admin' })} userId="77777777-7777-4777-8777-777777777777" />);
    expect((screen.getByTestId('diagnostics-sharing-toggle') as HTMLInputElement).disabled).toBe(true);
  });
});
