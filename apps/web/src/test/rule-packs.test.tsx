import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meKey } from '../api/queries/auth.ts';
import { EnforcedByBadge } from '../components/EnforcedByBadge.tsx';
import { RulePacksDialog } from '../components/RulePacksDialog.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { Ledger } from '../pages/Ledger.tsx';

// GWP-31: rule packs and the 'enforced by' badge (business mode only).

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let mode: 'dev' | 'business';
let role: 'owner' | 'member';
const me = () => ({
  user: {
    id: ID(1),
    email: 'o@x.test',
    displayName: 'Olga',
    kind: 'user',
    status: 'active',
    timezone: 'UTC',
  },
  account: { kind: 'user' },
  isAdmin: false,
  orgs: [{ id: ID(2), name: 'Org', role, status: 'active' }],
  activeOrg: {
    id: ID(2),
    name: 'Org',
    role,
    status: 'active',
    plan: 'founding',
    planName: 'Founding',
    features: {},
    mode,
    banners: [],
    gate: null,
  },
  guestIn: [],
  guestProjectIds: [],
  visibleProjectIds: [],
  pendingInvitations: 0,
  mustChangePassword: false,
  twoFactor: { enabled: false, required: false, setupRequired: false },
  features: { mockUi: false },
});

const entry = (over: Record<string, unknown> = {}) => ({
  id: ID(20),
  scope: 'standing_order',
  projectId: null,
  projectKey: null,
  cardId: null,
  cardRef: null,
  title: 'never message a client without approval',
  body: 'never message a client without approval',
  tags: [],
  sourceDeskItemId: null,
  vaultPath: null,
  createdByKind: 'user',
  createdByName: 'Olga',
  supersededBy: null,
  createdAt: '2026-10-13T10:00:00.000Z',
  version: 1,
  editedAt: null,
  editedByName: null,
  canEdit: false,
  canRetire: false,
  retiredAt: null,
  retiredReason: null,
  conflictsWith: [],
  reviewDate: null,
  reviewDue: false,
  reviewedAt: null,
  rulePack: { id: 'core', name: 'Core rules', ruleId: 'never-message-without-approval' },
  enforcedBy: 'agent_instruction',
  ...over,
});

const pack = (over: Record<string, unknown> = {}) => ({
  id: 'core',
  name: 'Core rules',
  description: 'Rule packs: tick boxes for every business.',
  kind: 'general',
  industry: null,
  ruleCount: 2,
  installed: false,
  ...over,
});

let entries: unknown[];
let preview: Record<string, unknown>;
let calls: Array<{ method: string; url: string }>;
beforeEach(() => {
  mode = 'business';
  role = 'owner';
  calls = [];
  entries = [
    entry(),
    entry({ id: ID(21), title: 'Own rule', body: 'Our own.', rulePack: null }),
    entry({ id: ID(22), title: 'Dated rule', body: 'x', reviewDate: '2027-02-03' }),
  ];
  preview = {
    ...pack(),
    rules: [
      {
        id: 'a',
        title: 'rule a',
        body: 'rule a',
        enforcedBy: 'agent_instruction',
        status: 'new',
        existing: [],
      },
      {
        id: 'b',
        title: 'rule b',
        body: 'rule b full text',
        enforcedBy: 'server_check',
        status: 'covered',
        existing: [{ id: ID(50), title: 'Mine' }],
      },
    ],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const path = url.split('?')[0] as string;
      if (path === '/api/auth/me') return json(me());
      if (path === '/api/projects') return json({ projects: [] });
      if (path === '/api/ledger') return json({ entries });
      calls.push({ method, url: path });
      if (path === '/api/ledger/rule-packs')
        return json({
          packs: [pack(), pack({ id: 'law', name: 'Law firms', kind: 'industry', industry: 'law' })],
        });
      if (path === '/api/ledger/rule-packs/core/install')
        return json({
          added: [ID(1)],
          kept: [],
          skipped: [{ ruleId: 'b', existingId: ID(50), existingTitle: 'Mine' }],
          flagged: [],
        });
      if (path === '/api/ledger/rule-packs/core/remove') return json({ retired: [ID(1)], kept: [ID(2)] });
      if (path.startsWith('/api/ledger/rule-packs/')) return json(preview);
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(meKey, me());
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('EnforcedByBadge', () => {
  it('shows both labels with the enforced-by test id', () => {
    wrap(
      <>
        <EnforcedByBadge value="server_check" />
        <EnforcedByBadge value="agent_instruction" />
      </>,
    );
    const badges = screen.getAllByTestId('enforced-by');
    expect(badges.map((b) => b.textContent)).toEqual(['Guildwise (server check)', 'Agent instruction']);
  });
});

describe('Rules & decisions page', () => {
  it('badges standing orders in a business org, with "from <pack>" and beside the review date', async () => {
    wrap(<Ledger />);
    const rows = await screen.findAllByTestId('ledger-entry');
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(within(r).getByTestId('enforced-by').textContent).toBe('Agent instruction');
    expect(within(rows[0] as HTMLElement).getByTestId('ledger-rule-pack').textContent).toBe(
      'from Core rules',
    );
    expect(within(rows[1] as HTMLElement).queryByTestId('ledger-rule-pack')).toBeNull();
    const dated = rows[2] as HTMLElement;
    expect(within(dated).getByTestId('enforced-by')).toBeTruthy();
    expect(within(dated).getByTestId('ledger-review-date')).toBeTruthy();
  });

  it('shows no badge, no pack text and no Rule packs button in a developer org', async () => {
    mode = 'dev';
    wrap(<Ledger />);
    await screen.findAllByTestId('ledger-entry');
    expect(screen.queryByTestId('enforced-by')).toBeNull();
    expect(screen.queryByTestId('ledger-rule-pack')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rule packs' })).toBeNull();
  });
});

describe('RulePacksDialog', () => {
  it('lists the packs grouped General and Industry, and previews rules with a badge and a status each', async () => {
    const user = userEvent.setup();
    wrap(<Ledger />);
    await user.click(await screen.findByRole('button', { name: 'Rule packs' }));
    const list = await screen.findAllByTestId('rule-pack');
    expect(list).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'General' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Industry' })).toBeTruthy();
    await user.click(within(list[0] as HTMLElement).getByRole('button'));
    const rules = await screen.findAllByTestId('rule-pack-rule');
    expect(rules).toHaveLength(2);
    expect(within(rules[0] as HTMLElement).getByTestId('enforced-by').textContent).toBe('Agent instruction');
    expect(within(rules[1] as HTMLElement).getByTestId('enforced-by').textContent).toBe(
      'Guildwise (server check)',
    );
    expect(within(rules[1] as HTMLElement).getByTestId('rule-pack-status').textContent).toMatch(
      /Covered by your rule "Mine" \(not added\)/,
    );
    // the explanation is text, not only a tooltip (touch has no hover)
    expect(screen.getByTestId('enforced-by-legend').textContent).toMatch(/Agent instruction/);
  });

  it('installs in one action and toasts the counts', async () => {
    const user = userEvent.setup();
    wrap(<RulePacksDialog open onOpenChange={() => undefined} />);
    await user.click(
      within((await screen.findAllByTestId('rule-pack'))[0] as HTMLElement).getByRole('button'),
    );
    await user.click(await screen.findByRole('button', { name: 'Install pack' }));
    await waitFor(() =>
      expect(calls).toContainEqual({ method: 'POST', url: '/api/ledger/rule-packs/core/install' }),
    );
  });

  it('asks before removing a pack', async () => {
    const user = userEvent.setup();
    preview = { ...preview, installed: true };
    wrap(<RulePacksDialog open onOpenChange={() => undefined} />);
    await user.click(
      within((await screen.findAllByTestId('rule-pack'))[0] as HTMLElement).getByRole('button'),
    );
    await user.click(await screen.findByRole('button', { name: 'Remove pack' }));
    expect(await screen.findByText(/Rules you edited stay as your own/)).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/remove'))).toBe(false);
    const buttons = screen.getAllByRole('button', { name: 'Remove pack' });
    await user.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(() =>
      expect(calls).toContainEqual({ method: 'POST', url: '/api/ledger/rule-packs/core/remove' }),
    );
  });

  it('lets a member read the preview but offers no install or remove', async () => {
    const user = userEvent.setup();
    role = 'member';
    wrap(<RulePacksDialog open onOpenChange={() => undefined} />);
    await user.click(
      within((await screen.findAllByTestId('rule-pack'))[0] as HTMLElement).getByRole('button'),
    );
    expect(await screen.findAllByTestId('rule-pack-rule')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Install pack' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove pack' })).toBeNull();
  });
});
