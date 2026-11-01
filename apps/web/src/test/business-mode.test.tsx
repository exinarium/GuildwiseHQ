import {
  type CardDetailResponse,
  codeWorkflowV1,
  type DeskItemDto,
  type ProjectDto,
  researchWorkflowV1,
} from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMe } from '../api/queries/auth.ts';
import { HireDialog } from '../components/agents/HireDialog.tsx';
import { SeatOptions } from '../components/agents/SeatOptions.tsx';
import { BuildSomething } from '../components/BuildSomething.tsx';
import { ConvertProjectDialog } from '../components/ConvertProjectDialog.tsx';
import { PacksTab } from '../components/capabilities/PacksTab.tsx';
import { DevOnly } from '../components/DevOnly.tsx';
import { ScheduleWizard } from '../components/schedules/ScheduleWizard.tsx';
import { buildNav } from '../components/shell/nav-config.ts';
import { UserMenu } from '../components/shell/UserMenu.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { ARTICLES, DEV_ONLY_HELP_SLUGS, helpArticlesFor } from '../help/articles.ts';
import { ACTION_TILES, actionTilesFor } from '../lib/schedules.ts';
import { useOrgTerms } from '../lib/terms.ts';
import { CardDetailView } from '../pages/CardDetail.tsx';
import { DeskItem } from '../pages/Desk.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const USER = ID(1);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const role = (key: string, name: string) => ({
  definition: {
    key,
    name,
    seniorityLevels: ['senior', 'junior'],
    defaultModel: { runtime: 'claude-code', model: 'sonnet', effort: 'medium' },
  },
  orgId: null,
  status: 'active',
  extensions: null,
});

let mode: 'dev' | 'business' = 'dev';
let override: 'dev' | 'business' | null = null;
let orgRole = 'owner';
let withBusinessRoles = false;
const fetchMock = vi.fn();

beforeEach(() => {
  mode = 'dev';
  override = null;
  orgRole = 'owner';
  withBusinessRoles = false;
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    const path = url.split('?')[0] as string;
    if (path === '/api/auth/me' || path === '/api/me')
      return json({
        user: {
          id: USER,
          email: 'o@x.test',
          displayName: 'Olga',
          kind: 'user',
          twoFactorEnabled: false,
          status: 'active',
          createdAt: '2026-10-01T10:00:00.000Z',
          lastLoginAt: null,
        },
        account: { kind: 'user' },
        isAdmin: true,
        orgs: [{ id: USER, name: 'Olga org', role: orgRole, status: 'active' }],
        activeOrg: {
          id: USER,
          name: 'Olga org',
          role: orgRole,
          status: 'active',
          plan: 'founding',
          planName: 'Founding',
          features: {},
          mode,
          viewOverride: override,
          banners: [],
        },
        guestIn: [],
        guestProjectIds: [],
        visibleProjectIds: [],
        pendingInvitations: 0,
        twoFactor: { enabled: false, required: false, setupRequired: false },
        mustChangePassword: false,
        features: { mockUi: false },
      });
    if (path === '/api/roles')
      return json({
        roles: [
          role('architect', 'Architect'),
          role('builder', 'Builder'),
          role('reviewer', 'Reviewer'),
          role('tester', 'Tester'),
          role('devops', 'DevOps'),
          role('ba', 'Business analyst'),
          ...(withBusinessRoles
            ? [role('billing_clerk', 'Billing Clerk'), role('front_desk', 'Front Desk')]
            : []),
        ],
      });
    if (path === '/api/workflows')
      return json({
        workflows: [codeWorkflowV1, researchWorkflowV1].map((definition, i) => ({
          id: ID(200 + i),
          orgId: null,
          status: 'active',
          definition,
        })),
      });
    if (path === '/api/packs')
      return json({ packs: [], workstationsOnline: 1, workstations: [], readableNow: true });
    if (path === '/api/projects')
      return json({ projects: [{ id: ID(70), key: 'APP', name: 'App', orgId: USER, orgName: null }] });
    if (path === '/api/workstations') return json({ workstations: [] });
    if (path === '/api/agents') return json({ agents: [] });
    if (path === `/api/projects/${ID(70)}`)
      return json({
        project: { id: ID(70), key: 'APP', name: 'App', workflowKey: 'enquiry' },
        repos: [],
        environments: [],
      });
    if (path === '/api/agents/name-suggestions') return json({ names: [] });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const ids = (business: boolean) =>
  buildNav({ projectKey: 'APP', hasEnvironments: true, canManage: true, business })
    .sections.flatMap((s) => s.items)
    .map((i) => i.id);

describe('the sidebar', () => {
  it('keeps Environments and Releases in dev mode, exactly as before', () => {
    expect(ids(false)).toEqual(expect.arrayContaining(['environments', 'releases']));
    expect(ids(false)).toEqual(ids(undefined as unknown as boolean));
  });
  it('leaves out the deploy surfaces in business mode and keeps the rest', () => {
    const b = ids(true);
    expect(b).not.toContain('environments');
    expect(b).not.toContain('releases');
    expect(b).toEqual(expect.arrayContaining(['board', 'desk', 'agents', 'workstations']));
    expect(b.length).toBe(ids(false).length - 2);
  });
});

describe('seats and help', () => {
  it('offers every seat in every view, the other view under More', () => {
    const seats = [
      { key: 'builder', name: 'Builder' },
      { key: 'front_desk', name: 'Front Desk' },
      { key: 'architect', name: 'Architect' },
    ];
    const { container } = wrap(
      <select>
        <SeatOptions seats={seats} />
      </select>,
    );
    expect(container.querySelectorAll('option')).toHaveLength(3);
    expect(container.querySelector('optgroup[label="More"]')?.textContent).toBe('Front Desk');
  });
  it('keeps every help article in every view, the software ones last in business', () => {
    expect(helpArticlesFor(false)).toEqual(ARTICLES);
    const b = helpArticlesFor(true);
    expect(b).toHaveLength(ARTICLES.length);
    const dev = b.map((a) => a.slug).filter((s) => DEV_ONLY_HELP_SLUGS.includes(s));
    expect(b.slice(-dev.length).map((a) => a.slug)).toEqual(dev);
  });
});

describe('DevOnly', () => {
  it('shows the page in a dev organization', async () => {
    wrap(
      <DevOnly>
        <p>Releases page</p>
      </DevOnly>,
    );
    expect(await screen.findByText('Releases page')).toBeInTheDocument();
  });
  it('(d) shows a gentle note instead of the page in the Business view, with a way to the Software view', async () => {
    mode = 'business';
    wrap(
      <DevOnly>
        <p>Releases page</p>
      </DevOnly>,
    );
    expect(await screen.findByTestId('not-available-business')).toHaveTextContent(
      'Switch to Software view to see this',
    );
    expect(screen.queryByText('Releases page')).toBeNull();
    expect(screen.queryByText(/not available/i)).toBeNull();
  });
  it('(c) a member whose own view is Software sees the page although the organization default is Business', async () => {
    mode = 'business';
    override = 'dev';
    wrap(
      <DevOnly>
        <p>Releases page</p>
      </DevOnly>,
    );
    expect(await screen.findByText('Releases page')).toBeInTheDocument();
  });
  it('(c) a member whose own view is Business is gated although the organization default is Software', async () => {
    override = 'business';
    wrap(
      <DevOnly>
        <p>Releases page</p>
      </DevOnly>,
    );
    await screen.findByTestId('not-available-business');
  });
  it('one click switches to the Software view, for a plain member too, and only stores the preference', async () => {
    mode = 'business';
    orgRole = 'member';
    wrap(
      <DevOnly>
        <p>x</p>
      </DevOnly>,
    );
    await userEvent.click(await screen.findByTestId('switch-to-software-view'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/org/view',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ view: 'dev' }) }),
      ),
    );
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');
    expect(writes.map(([u]) => u)).toEqual(['/api/org/view']);
  });
});

describe('hire dialog roles', () => {
  const renderForm = async () => {
    wrap(<HireDialog open onOpenChange={() => {}} />);
    const form = await screen.findByRole('form', { name: 'Hire agent' });
    return () =>
      within(within(form).getByLabelText('Role'))
        .getAllByRole('option')
        .map((o) => o.textContent)
        .join(' ');
  };
  it('lists the developer roles in dev mode', async () => {
    const options = await renderForm();
    await waitFor(() => expect(options()).toMatch(/Architect/));
    expect(options()).toMatch(/Builder/);
    expect(options()).toMatch(/Tester/);
  });
  it('keeps builder, reviewer and tester in the Business view, under More', async () => {
    mode = 'business';
    const options = await renderForm();
    await waitFor(() => expect(options()).toMatch(/Architect/));
    expect(options()).toMatch(/Builder/);
    expect(options()).toMatch(/Reviewer/);
    expect(options()).toMatch(/Tester/);
    const group = document.querySelector('optgroup[label="More"]');
    expect(group?.textContent).toMatch(/Builder/);
    expect(group?.textContent).not.toMatch(/Architect/);
  });
});

describe('hire dialog business roles', () => {
  it('lists the business roles first, in the research table order, in business mode', async () => {
    mode = 'business';
    withBusinessRoles = true;
    wrap(<HireDialog open onOpenChange={() => {}} />);
    const form = await screen.findByRole('form', { name: 'Hire agent' });
    const names = () =>
      within(within(form).getByLabelText('Role'))
        .getAllByRole('option')
        .map((o) => o.textContent ?? '');
    await waitFor(() => expect(names()[0]).toMatch(/Front Desk/));
    expect(names()[1]).toMatch(/Billing Clerk/);
  });
});

describe('packs tab', () => {
  it('offers adding a pack by git URL in dev mode', async () => {
    wrap(<PacksTab />);
    expect(await screen.findByRole('button', { name: 'Add a pack by git URL' })).toBeInTheDocument();
  });
  it('still offers adding a pack by git URL in the Business view', async () => {
    mode = 'business';
    wrap(<PacksTab />);
    expect(await screen.findByRole('button', { name: 'Add a pack by git URL' })).toBeInTheDocument();
  });
});

describe('hire dialog with a developer role prefilled', () => {
  it('keeps the prefilled developer role in the Business view', async () => {
    mode = 'business';
    wrap(<HireDialog open onOpenChange={() => {}} prefill={{ roleKey: 'builder', projectId: ID(70) }} />);
    const form = await screen.findByRole('form', { name: 'Hire agent' });
    await waitFor(() => expect(within(form).getByLabelText('Role')).toHaveValue('builder'));
  });
});

describe('convert dialog', () => {
  const project = {
    id: ID(70),
    key: 'APP',
    name: 'App',
    workflowKey: 'research',
    startedAs: 'research',
  } as ProjectDto;
  const open = () => wrap(<ConvertProjectDialog project={project} repos={[]} open onOpenChange={() => {}} />);
  it('offers the code workflow and the repository forms in dev mode', async () => {
    open();
    expect(await screen.findByTestId('convert-workflow-code')).toBeInTheDocument();
    expect(await screen.findByTestId('convert-repo-url')).toBeInTheDocument();
  });
  it('still offers the code workflow and the repository forms in the Business view', async () => {
    mode = 'business';
    open();
    expect(await screen.findByTestId('convert-workflow-code')).toBeInTheDocument();
    expect(await screen.findByTestId('convert-repo-url')).toBeInTheDocument();
  });
});

/** The shell loads `me` in the app; a test that renders a piece alone does it here. */
function LoadMe() {
  useMe();
  return null;
}

const meLoaded = () =>
  waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([u]) => ['/api/auth/me', '/api/me'].includes(String(u).split('?')[0] ?? '')),
    ).toBe(true),
  );

describe('Ask DevOps on a card', () => {
  const NOW = '2026-10-01T10:00:00.000Z';
  const detail = {
    card: {
      id: ID(10),
      ref: 'APP-4',
      title: 'Send the quote',
      cardType: 'feature',
      stage: 'build',
      status: 'queued',
      assignee: null,
      updatedAt: NOW,
      queuedAt: null,
      riskTier: null,
      blocked: false,
      reworkRound: 0,
      priority: 3,
      projectId: ID(70),
      number: 4,
      workflowKey: 'code',
      workflowVersion: 1,
      column: 'Build',
      fields: {},
      ownerUserId: USER,
      decisionPolicy: 'owner_only',
      riskTierOverridden: false,
      docsNeeded: false,
      completionAction: null,
      repoId: null,
      baseBranch: null,
      branchName: null,
      homeWorkstationId: null,
      parentCardId: null,
      origin: 'manual',
      scheduled: false,
      claimedByAgentId: null,
      claimedByAgentName: null,
      claimedAt: null,
      blockedSince: null,
      dependencies: [],
      createdAt: NOW,
      finalizedAt: null,
    },
    handoffs: [],
    transitions: [],
    activity: [],
    threadId: ID(11),
    thread: [],
    currentShift: null,
    permissions: {
      canEdit: false,
      canSpecify: false,
      canMove: true,
      canRelease: false,
      canCancel: true,
      canComment: true,
    },
    blockers: [],
  } as unknown as CardDetailResponse;
  const open = () => wrap(<CardDetailView data={detail} workflow={codeWorkflowV1} />);
  it('is offered in dev mode', async () => {
    open();
    await meLoaded();
    expect(screen.getAllByRole('button', { name: 'Ask DevOps' }).length).toBeGreaterThan(0);
  });
  it('stays in the Business view, in business words', async () => {
    mode = 'business';
    open();
    await meLoaded();
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Ask for technical help' }).length).toBeGreaterThan(0),
    );
    expect(screen.queryAllByRole('button', { name: 'Ask DevOps' })).toHaveLength(0);
  });
  const openOnPhone = async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    open();
    await meLoaded();
    await userEvent.setup().click(await screen.findByTestId('card-actions'));
    return screen.findByTestId('card-actions-sheet');
  };
  it('is in the phone actions sheet in dev mode', async () => {
    const sheet = await openOnPhone();
    expect(within(sheet).getByRole('button', { name: 'Ask DevOps' })).toBeInTheDocument();
  });
  it('is in the phone actions sheet in the Business view too', async () => {
    mode = 'business';
    const sheet = await openOnPhone();
    expect(await within(sheet).findByRole('button', { name: 'Ask for technical help' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: /Move/ })).toBeInTheDocument();
  });
});

describe('Ask DevOps on a desk item', () => {
  const item = {
    id: ID(50),
    kind: 'alert',
    subkind: 'runner_offline',
    status: 'open',
    routedTo: 'manager',
    title: 'The runner is offline',
    body: 'The workstation stopped reporting.',
    doing: '',
    options: [],
    recommendation: null,
    blocking: false,
    pinned: false,
    urgent: false,
    affectedCardIds: [],
    affectedCount: 0,
    askedBy: { kind: 'system' },
    card: null,
    projectId: null,
    dedupEntries: [],
    answer: null,
    answerOption: null,
    answeredAt: null,
    answeredByName: null,
    decisionPolicy: null,
    canAnswer: true,
    createdAt: '2026-10-01T10:00:00.000Z',
  } as unknown as DeskItemDto;
  it('is offered in dev mode (the default)', () => {
    wrap(<DeskItem item={item} />);
    expect(screen.getByRole('button', { name: 'Ask DevOps about this' })).toBeInTheDocument();
  });
  it('stays in the Business view, in business words, and the item still shows', async () => {
    mode = 'business';
    wrap(
      <>
        <LoadMe />
        <DeskItem item={item} />
      </>,
    );
    await meLoaded();
    expect(
      await screen.findByRole('button', { name: 'Ask for technical help with this' }),
    ).toBeInTheDocument();
    expect(screen.getByText('The runner is offline')).toBeInTheDocument();
  });
});

describe('automation wizard actions', () => {
  async function actionStep() {
    const user = userEvent.setup();
    wrap(<ScheduleWizard open onOpenChange={() => {}} />);
    const wizard = await screen.findByTestId('schedule-wizard');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', expect.anything()));
    await user.click(screen.getByTestId('wizard-next'));
    return within(wizard);
  }
  it('offers Ask DevOps and the regression run in dev mode (the default)', async () => {
    const w = await actionStep();
    expect(await w.findByTestId('tile-create_card')).toBeInTheDocument();
    expect(w.getByTestId('tile-devops_request')).toHaveTextContent('Ask DevOps');
    expect(w.getByTestId('tile-regression_run')).toBeInTheDocument();
  });
  it('tucks Ask DevOps and the regression run under More actions in the Business view', async () => {
    mode = 'business';
    const w = await actionStep();
    expect(await w.findByTestId('tile-create_card')).toBeInTheDocument();
    await waitFor(() => expect(w.getByTestId('more-actions')).toBeInTheDocument());
    const more = within(w.getByTestId('more-actions'));
    expect(more.getByTestId('tile-devops_request')).toBeInTheDocument();
    expect(more.getByTestId('tile-regression_run')).toBeInTheDocument();
    expect(w.getByTestId('tile-ba_task')).toBeInTheDocument();
  });
  it('lists every tile in every view; the Business view only moves two under More', () => {
    const all = ACTION_TILES.map((t) => t.id);
    expect(actionTilesFor(false)).toEqual({ main: ACTION_TILES, more: [] });
    const b = actionTilesFor(true);
    expect(b.more.map((t) => t.id).sort()).toEqual(['devops_request', 'regression_run']);
    expect([...b.main, ...b.more].map((t) => t.id).sort()).toEqual([...all].sort());
  });
});

describe('the view toggle in the user menu', () => {
  const menu = () =>
    wrap(<UserMenu name="Olga" email="o@x.test" roleLabel="Owner" avatar={null} onSignOut={() => {}} />);
  it('is easy to reach and picks the view for this member only', async () => {
    mode = 'business';
    menu();
    await userEvent.click(await screen.findByTestId('user-menu'));
    expect(await screen.findByTestId('view-current')).toHaveTextContent('Business view');
    await userEvent.click(screen.getByTestId('view-dev'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/org/view',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ view: 'dev' }) }),
      ),
    );
  });
  it('can go back to the organization default', async () => {
    override = 'dev';
    mode = 'business';
    menu();
    await userEvent.click(await screen.findByTestId('user-menu'));
    expect(await screen.findByTestId('view-default')).toHaveTextContent(
      'Organization default (Business view)',
    );
    await userEvent.click(screen.getByTestId('view-default'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/org/view',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ view: null }) }),
      ),
    );
  });
});

describe('Build something', () => {
  const project = {
    id: ID(70),
    key: 'APP',
    name: 'App',
    workflowKey: 'enquiry',
    myRole: 'owner',
  } as ProjectDto;
  it('walks a business project through workstation, repository and builder using the existing flows', async () => {
    mode = 'business';
    wrap(<BuildSomething project={project} />);
    await userEvent.click(await screen.findByTestId('build-something-open'));
    const steps = await screen.findByTestId('build-steps');
    expect(within(steps).getByTestId('build-workstation')).toHaveAttribute('href', '/workstations?add=1');
    expect(within(steps).getByTestId('build-builder')).toHaveAttribute(
      'href',
      `/agents?hire=builder&projectId=${ID(70)}`,
    );
    expect(within(steps).getByTestId('build-step-workstation')).toHaveAttribute('data-done', 'false');
    // nothing was written: no view switch, no install
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET')).toEqual([]);
  });
});

describe('the words follow the view, not the organization default', () => {
  function Words() {
    const t = useOrgTerms();
    return <p data-testid="words">{`${t.ledger} / ${t.askDevOps}`}</p>;
  }
  const show = async () => {
    wrap(
      <>
        <LoadMe />
        <Words />
      </>,
    );
    await meLoaded();
  };
  it('uses the business words when the member picked the Business view in a Software organization', async () => {
    override = 'business';
    await show();
    await waitFor(() =>
      expect(screen.getByTestId('words')).toHaveTextContent('Rules & decisions / Ask for technical help'),
    );
  });
  it('uses the software words when the member picked the Software view in a Business organization', async () => {
    mode = 'business';
    override = 'dev';
    await show();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('words')).toHaveTextContent('Ledger / Ask DevOps');
  });
});
