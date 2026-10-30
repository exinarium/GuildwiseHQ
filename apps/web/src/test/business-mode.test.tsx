import { codeWorkflowV1, type ProjectDto, researchWorkflowV1 } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConvertProjectDialog } from '../components/ConvertProjectDialog.tsx';
import { HireDialog } from '../components/agents/HireDialog.tsx';
import { PacksTab } from '../components/capabilities/PacksTab.tsx';
import { DevOnly } from '../components/DevOnly.tsx';
import { buildNav } from '../components/shell/nav-config.ts';
import { ToastProvider } from '../components/ui.tsx';
import { ARTICLES, helpArticlesFor } from '../help/articles.ts';
import { seatAllowed } from '../lib/orgMode.ts';

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
let orgRole = 'owner';
const fetchMock = vi.fn();

beforeEach(() => {
  mode = 'dev';
  orgRole = 'owner';
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
  it('offers no developer seat in business mode', () => {
    expect(seatAllowed('builder', true)).toBe(false);
    expect(seatAllowed('tester', true)).toBe(false);
    expect(seatAllowed('analyst', true)).toBe(true);
    expect(seatAllowed('own', true)).toBe(true);
    expect(seatAllowed('builder', false)).toBe(true);
  });
  it('drops the developer help articles in business mode only', () => {
    expect(helpArticlesFor(false)).toEqual(ARTICLES);
    const slugs = helpArticlesFor(true).map((a) => a.slug);
    for (const s of ['devops-and-hygiene', 'testing-and-finalization', 'project-conversion'])
      expect(slugs).not.toContain(s);
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
  it('shows "not available" instead of the page in a business organization, with a way to the settings for managers', async () => {
    mode = 'business';
    wrap(
      <DevOnly>
        <p>Releases page</p>
      </DevOnly>,
    );
    expect(await screen.findByTestId('not-available-business')).toHaveTextContent(
      'Not available in Business mode',
    );
    expect(screen.queryByText('Releases page')).toBeNull();
    expect(screen.getByRole('link', { name: 'Organization settings' })).toBeInTheDocument();
  });
  it('does not send a member to the settings page', async () => {
    mode = 'business';
    orgRole = 'member';
    wrap(
      <DevOnly>
        <p>x</p>
      </DevOnly>,
    );
    await screen.findByTestId('not-available-business');
    expect(screen.queryByRole('link', { name: 'Organization settings' })).toBeNull();
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
  it('omits builder, reviewer and tester in business mode', async () => {
    mode = 'business';
    const options = await renderForm();
    await waitFor(() => expect(options()).not.toMatch(/Builder/));
    expect(options()).toMatch(/Architect/);
    expect(options()).not.toMatch(/Reviewer/);
    expect(options()).not.toMatch(/Tester/);
  });
});

describe('packs tab', () => {
  it('offers adding a pack by git URL in dev mode', async () => {
    wrap(<PacksTab />);
    expect(await screen.findByRole('button', { name: 'Add a pack by git URL' })).toBeInTheDocument();
  });
  it('has no add-by-URL control in business mode', async () => {
    mode = 'business';
    wrap(<PacksTab />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add a pack by git URL' })).toBeNull());
    expect(screen.queryByTestId('packs-format-note')).toBeNull();
  });
});

describe('hire dialog with a developer role prefilled', () => {
  it('falls back to a hireable role in business mode', async () => {
    mode = 'business';
    wrap(<HireDialog open onOpenChange={() => {}} prefill={{ roleKey: 'builder', projectId: ID(70) }} />);
    const form = await screen.findByRole('form', { name: 'Hire agent' });
    await waitFor(() => expect(within(form).getByLabelText('Role')).toHaveValue('architect'));
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
  it('offers no repository workflow and no repository form in business mode', async () => {
    mode = 'business';
    open();
    expect(await screen.findByText('There is no other workflow to convert to.')).toBeInTheDocument();
    expect(screen.queryByTestId('convert-workflow-code')).toBeNull();
    expect(screen.queryByTestId('convert-repo-url')).toBeNull();
    expect(screen.queryByTestId('convert-new-name')).toBeNull();
  });
});
