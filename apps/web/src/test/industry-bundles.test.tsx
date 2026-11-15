import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meKey } from '../api/queries/auth.ts';
import { ToastProvider } from '../components/ui.tsx';
import { Ledger } from '../pages/Ledger.tsx';

// GWP-234: browse, preview, install and uninstall the industry bundles (Rules & decisions header).

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

const summary = (id: string, name: string, installed: boolean) => ({
  id,
  industry: id,
  name,
  description: `${name} description`,
  version: 1,
  installed,
  installedAt: installed ? '2026-11-14T10:00:00.000Z' : null,
  counts: { rules: 12, playbooks: 2, knowledgeTemplates: 3, sampleData: 2, journeyTemplates: 1 },
});

const previewOf = (id: string, installed: boolean, over: Record<string, unknown> = {}) => ({
  ...summary(id, id === 'law' ? 'Law firms' : 'Accounting firms', installed),
  rulePack: {
    id,
    name: 'Pack',
    description: 'd',
    kind: 'industry',
    industry: id,
    ruleCount: 3,
    installed,
    rules: [
      {
        id: 'r1',
        title: 'rule one',
        body: 'rule one',
        enforcedBy: 'agent_instruction',
        status: 'new',
        existing: [],
      },
      {
        id: 'r2',
        title: 'rule two',
        body: 'rule two',
        enforcedBy: 'server_check',
        status: 'may_conflict',
        existing: [{ id: ID(50), title: 'Our own rule' }],
      },
      {
        id: 'r3',
        title: 'rule three',
        body: 'rule three',
        enforcedBy: 'agent_instruction',
        status: 'covered',
        existing: [{ id: ID(51), title: 'Mine' }],
      },
    ],
  },
  playbooks: [
    {
      key: 'accounting_deadline_brief',
      name: 'Deadlines brief',
      description: 'x',
      status: 'new',
      scheduleId: null,
    },
  ],
  knowledgeTemplates: [{ id: 't1', title: 'Engagement checklist', status: 'present', existingId: ID(60) }],
  sampleData: [{ id: 's1', title: 'Sample: Client profile', status: 'new', existingId: null }],
  journeyTemplates: [{ id: 'jt', name: 'Client onboarding' }],
  blockers: [],
  ...over,
});

const installResult = {
  status: 'installed',
  rulePack: { added: ['a', 'b', 'c'], kept: [], skipped: [], flagged: [] },
  playbooks: { added: [{ key: 'accounting_deadline_brief', scheduleId: ID(70) }], present: [] },
  documents: {
    added: [
      { memberId: 't1', docId: ID(71), kind: 'template' },
      { memberId: 's1', docId: ID(72), kind: 'sample' },
    ],
    present: [],
  },
  journeyTemplates: ['jt'],
};

let accountingInstalled: boolean;
let lawInstalled: boolean;
let listStatus: number;
let installReply: () => Response;
let blockerWithoutProject: boolean;
let calls: Array<{ method: string; url: string; body?: unknown }>;

beforeEach(() => {
  mode = 'business';
  role = 'owner';
  calls = [];
  accountingInstalled = false;
  lawInstalled = true;
  listStatus = 200;
  blockerWithoutProject = false;
  installReply = () => {
    accountingInstalled = true;
    return json(installResult);
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const path = url.split('?')[0] as string;
      const query = url.includes('?') ? (url.split('?')[1] as string) : '';
      if (path === '/api/auth/me') return json(me());
      if (path === '/api/projects')
        return json({
          projects: [
            { id: ID(80), key: 'ONE', name: 'Project one', status: 'active' },
            { id: ID(81), key: 'TWO', name: 'Project two', status: 'active' },
          ],
        });
      if (path === '/api/ledger') return json({ entries: [] });
      if (!path.startsWith('/api/industry-bundles')) return json({});
      calls.push({
        method,
        url: path + (query ? `?${query}` : ''),
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (path === '/api/industry-bundles') {
        if (listStatus !== 200)
          return json({ error: { code: 'boom', message: 'The bundles could not load' } }, listStatus);
        return json({
          bundles: [
            summary('accounting', 'Accounting firms', accountingInstalled),
            summary('law', 'Law firms', lawInstalled),
          ],
        });
      }
      if (path.endsWith('/install')) return installReply();
      if (path === '/api/industry-bundles/law/remove') {
        lawInstalled = false;
        return json({
          removed: { ruleEntries: ['a', 'b'], schedules: [ID(90)], documents: [ID(91)] },
          kept: [{ kind: 'rule', id: ID(92), title: 'Our reworded rule', reason: 'edited' }],
          gone: [{ kind: 'document', id: ID(93) }],
        });
      }
      const id = path.split('/')[3] as string;
      const installed = id === 'law' ? lawInstalled : accountingInstalled;
      const noProject = blockerWithoutProject && !query.includes('projectId');
      return json(
        previewOf(id, installed, {
          blockers: noProject
            ? [{ code: 'project_required', message: 'choose a project for the playbook cards' }]
            : [],
        }),
      );
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

async function openBundles(user: ReturnType<typeof userEvent.setup>) {
  wrap(<Ledger />);
  await user.click(await screen.findByRole('button', { name: 'Industry bundles' }));
}
async function openBundle(user: ReturnType<typeof userEvent.setup>, name: string) {
  await openBundles(user);
  const rows = await screen.findAllByTestId('industry-bundle');
  const row = rows.find((r) => within(r).queryByText(name));
  if (!row) throw new Error(`no row ${name}`);
  await user.click(within(row).getByRole('button'));
  await screen.findByTestId('industry-bundle-preview');
}
const posts = () => calls.filter((c) => c.method === 'POST');

describe('IndustryBundlesDialog', () => {
  it('lists the bundles with their contents and installed state (AC 1)', async () => {
    const user = userEvent.setup();
    await openBundles(user);
    const rows = await screen.findAllByTestId('industry-bundle');
    expect(rows).toHaveLength(2);
    const acc = rows[0] as HTMLElement;
    const law = rows[1] as HTMLElement;
    expect(within(acc).getByTestId('bundle-contents').textContent).toBe(
      '12 rules · 2 playbooks · 3 knowledge templates · 2 sample documents · 1 journey template',
    );
    expect(within(law).getByText('Installed')).toBeTruthy();
    expect(within(acc).queryByText('Installed')).toBeNull();
  });

  it('previews the additions and flags contradictions and near-duplicates (AC 2)', async () => {
    const user = userEvent.setup();
    await openBundle(user, 'Accounting firms');
    for (const name of ['Rules', 'Playbooks', 'Knowledge templates', 'Sample data', 'Journey templates'])
      expect(screen.getByRole('region', { name })).toBeTruthy();
    const status = screen.getAllByTestId('bundle-item-status').map((n) => n.textContent);
    expect(status).toContain('May contradict "Our own rule"');
    expect(status).toContain('Covered by your rule "Mine" (not added)');
    expect(status).toContain('A document with this title already exists, left as it is');
    expect(status).toContain('Will be added, switched off');
    expect(status).toContain('Always available in the Journeys gallery');
    expect(screen.getByTestId('bundle-flags').textContent).toMatch(
      /2 rules may contradict or repeat your own rules/,
    );
  });

  it('installs with one call and then shows the bundle as installed (AC 3)', async () => {
    const user = userEvent.setup();
    await openBundle(user, 'Accounting firms');
    await user.click(screen.getByRole('button', { name: 'Install bundle' }));
    const result = await screen.findByTestId('bundle-result');
    expect(result.textContent).toMatch(/Bundle installed/);
    expect(result.textContent).toMatch(/Added 3 rules, 1 playbook/);
    expect(result.textContent).toMatch(/Client onboarding/);
    expect(posts().filter((c) => c.url === '/api/industry-bundles/accounting/install')).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Uninstall bundle' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Install bundle' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'All bundles' }));
    const rows = await screen.findAllByTestId('industry-bundle');
    await waitFor(() => expect(within(rows[0] as HTMLElement).getByText('Installed')).toBeTruthy());
  });

  it('asks before uninstalling, then lists the kept items (AC 4)', async () => {
    const user = userEvent.setup();
    await openBundle(user, 'Law firms');
    await user.click(screen.getByRole('button', { name: 'Uninstall bundle' }));
    expect(await screen.findByText(/created or edited is kept/)).toBeTruthy();
    expect(posts()).toHaveLength(0);
    const buttons = screen.getAllByRole('button', { name: 'Uninstall bundle' });
    await user.click(buttons[buttons.length - 1] as HTMLElement);
    const kept = await screen.findByTestId('bundle-kept');
    expect(kept.textContent).toMatch(/Our reworded rule \(rule\): you edited it/);
    expect(screen.getByTestId('bundle-result').textContent).toMatch(/Removed 4 items/);
    expect(posts().filter((c) => c.url === '/api/industry-bundles/law/remove')).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Install bundle' })).toBeTruthy());
  });

  it('gives a member the list and the preview but no controls (AC 5)', async () => {
    role = 'member';
    blockerWithoutProject = true;
    const user = userEvent.setup();
    await openBundle(user, 'Accounting firms');
    expect(screen.getAllByTestId('bundle-item').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Install bundle' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Uninstall bundle' })).toBeNull();
    expect(within(screen.getByTestId('industry-bundle-preview')).queryByLabelText('Project')).toBeNull();
  });

  it('shows a server 403 as an error and keeps the preview (AC 5)', async () => {
    installReply = () =>
      json(
        {
          error: {
            code: 'forbidden',
            message: 'only the organization Owner and Admins can install or remove industry bundles',
          },
        },
        403,
      );
    const user = userEvent.setup();
    await openBundle(user, 'Accounting firms');
    await user.click(screen.getByRole('button', { name: 'Install bundle' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/only the organization Owner and Admins/);
    expect(screen.getByTestId('industry-bundle-preview')).toBeTruthy();
  });

  it('shows a load error with a retry (AC 6)', async () => {
    listStatus = 500;
    const user = userEvent.setup();
    await openBundles(user);
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not load/);
    const before = calls.filter((c) => c.url === '/api/industry-bundles').length;
    await user.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() =>
      expect(calls.filter((c) => c.url === '/api/industry-bundles').length).toBeGreaterThan(before),
    );
  });

  it('uses business wording in the business view and software wording otherwise (AC 6)', async () => {
    const user = userEvent.setup();
    await openBundle(user, 'Accounting firms');
    expect(screen.getByRole('region', { name: 'Rules' })).toBeTruthy();
    expect(screen.getByText(/Everything one industry needs in one install: rules,/)).toBeTruthy();
  });

  it('asks for a project when the preview needs one, and installs with it', async () => {
    blockerWithoutProject = true;
    const user = userEvent.setup();
    await openBundle(user, 'Accounting firms');
    const install = screen.getByRole('button', { name: 'Install bundle' }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    await user.selectOptions(
      within(screen.getByTestId('industry-bundle-preview')).getByLabelText('Project'),
      ID(81),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/industry-bundles/accounting?projectId=${ID(81)}`)).toBe(true),
    );
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Install bundle' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Install bundle' }));
    await screen.findByTestId('bundle-result');
    expect(posts()[0]?.body).toEqual({ projectId: ID(81) });
  });
});

describe('IndustryBundlesDialog in the software view', () => {
  it('words the rules as standing orders', async () => {
    mode = 'dev';
    const user = userEvent.setup();
    await openBundle(user, 'Accounting firms');
    expect(screen.getByRole('region', { name: 'Standing orders' })).toBeTruthy();
  });
});
