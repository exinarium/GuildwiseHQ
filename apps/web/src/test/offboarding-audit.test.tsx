import type { OffboardingReport, OffboardingStep } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditTab } from '../components/orgsettings/AuditTab.tsx';
import { MembersTab } from '../components/orgsettings/MembersTab.tsx';
import { ToastProvider } from '../components/ui.tsx';

afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function wrap(ui: React.ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ToastProvider>{ui}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const MEMBER = {
  userId: '22222222-2222-4222-8222-222222222222',
  displayName: 'Mia Member',
  email: 'mia@example.test',
  role: 'member',
  allProjects: false,
  projects: [],
  twoFactorEnabled: false,
  avatar: null,
};
const step = (
  key: OffboardingStep['key'],
  label: string,
  status: OffboardingStep['status'],
  detail: string,
  count = 1,
): OffboardingStep => ({
  key,
  label,
  status,
  detail,
  count,
});

describe('removing a member runs the offboarding checklist', () => {
  it('previews the checklist, removes, and shows the report with its notes', async () => {
    const report: OffboardingReport = {
      orgId: '0192f3a0-0000-7000-8000-0000000000a1',
      userId: MEMBER.userId,
      userName: 'Mia Member',
      transferredTo: '0192f3a0-0000-7000-8000-0000000000a2',
      privatePurgeAfter: '2026-11-23T10:00:00.000Z',
      steps: [
        step('sessions', 'Sign-in sessions', 'done', 'Signed out everywhere (2 sessions).', 2),
        step(
          'org_key_shares',
          'Organization key copies',
          'done',
          'Cleared 1 copy of the organization key on their workstations.',
        ),
        step(
          'private_items',
          'Private items',
          'flagged',
          '1 private chat and 0 private packs are flagged and deleted after 30 days.',
        ),
      ],
      notes: ['They set the organization key for anthropic. Rotate it if you do not trust the person.'],
    };
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        calls.push({ method, url: u });
        if (method === 'DELETE') return json(200, { members: [], offboarding: report });
        if (u.endsWith('/removal-preview'))
          return json(200, {
            userId: MEMBER.userId,
            displayName: 'Mia Member',
            projects: [],
            agents: [],
            releasedCards: [],
            transferredCards: [],
            privatePurgeDays: 30,
            offboarding: [
              step('sessions', 'Sign-in sessions', 'done', 'Will be signed out everywhere (2 sessions).', 2),
              step(
                'private_items',
                'Private items',
                'flagged',
                '1 private chat and 0 private packs will be flagged and deleted after 30 days.',
              ),
            ],
          });
        if (u.endsWith('/org/members')) return json(200, { members: [MEMBER] });
        if (u.endsWith('/org') || u.includes('/org?')) return json(200, { id: 'o1', name: 'Acme' });
        return json(200, { projects: [] });
      }),
    );
    const user = userEvent.setup();
    wrap(<MembersTab me={{ userId: '11111111-1111-4111-8111-111111111111', role: 'owner' }} />);
    await user.click(await screen.findByRole('button', { name: 'Actions for Mia Member' }));
    await user.click(await screen.findByRole('menuitem', { name: /Remove from organization/ }));
    const pre = await screen.findByTestId('removal-offboarding');
    expect(within(pre).getByText(/Will be signed out everywhere/)).toBeInTheDocument();
    expect(screen.getByText(/deleted after 30 days. Everything else is done now/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Remove from organization' }));
    const rep = await screen.findByTestId('offboarding-report');
    expect(within(rep).getByText(/Signed out everywhere \(2 sessions\)/)).toBeInTheDocument();
    expect(within(rep).getByText(/Cleared 1 copy of the organization key/)).toBeInTheDocument();
    expect(screen.getByTestId('offboarding-notes')).toHaveTextContent(
      /Rotate it if you do not trust the person/,
    );
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByTestId('offboarding-report')).not.toBeInTheDocument());
  });
});

describe('the audit export', () => {
  it('downloads the chosen range, format and person through the API', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/audit/export')) {
          urls.push(u);
          return new Response('at,type\r\n', {
            status: 200,
            headers: { 'content-disposition': 'attachment; filename="audit-2026-10-01-to-2026-10-31.csv"' },
          });
        }
        return json(200, { members: [MEMBER] });
      }),
    );
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const user = userEvent.setup();
    wrap(<AuditTab />);
    await screen.findByRole('option', { name: 'Mia Member' });
    await user.selectOptions(screen.getByLabelText('Person'), MEMBER.userId);
    await user.selectOptions(screen.getByLabelText('Format'), 'json');
    await user.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(urls).toHaveLength(1));
    const q = new URL(urls[0] ?? '', 'http://x').searchParams;
    expect(q.get('format')).toBe('json');
    expect(q.get('actorUserId')).toBe(MEMBER.userId);
    expect(q.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(q.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(await screen.findByText(/Exported audit-2026-10-01-to-2026-10-31\.csv/)).toBeInTheDocument();
    click.mockRestore();
  });

  it('shows the server’s reason when the export is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/audit/export')
          ? json(400, {
              error: {
                code: 'range_too_long',
                message: 'an export covers at most 366 days: export in pieces',
              },
            })
          : json(200, { members: [] }),
      ),
    );
    const user = userEvent.setup();
    wrap(<AuditTab />);
    await user.click(await screen.findByRole('button', { name: 'Download' }));
    expect(await screen.findByText(/at most 366 days/)).toBeInTheDocument();
  });
});
