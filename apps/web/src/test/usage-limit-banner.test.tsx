import { codeWorkflowV1 } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatUntil, UsageLimitBanner } from '../components/UsageLimitBanner.tsx';
import { Board } from '../pages/Board.tsx';
import { ProjectSettings } from '../pages/ProjectSettings.tsx';

afterEach(() => vi.unstubAllGlobals());

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const ORG = '0192f3a0-0000-7000-8000-0000000000a1';
const ENTRY = '0192f3a0-0000-7000-8000-0000000000b1';
const UNTIL = new Date(Date.now() + 2 * 3_600_000).toISOString();

const dto = (usageLimit?: object) => ({
  id: PROJECT,
  orgId: ORG,
  key: 'TOY',
  name: 'Toy',
  workflowKey: 'code',
  rank: 1,
  branchPrefix: 'aom/',
  workingBranch: 'main',
  subCategories: [],
  vaultFolder: null,
  architecturalGlobs: [],
  e2eGlobs: [],
  status: 'active',
  createdAt: '2026-10-01T10:00:00.000Z',
  myRole: 'owner',
  mergeLargeWithoutApproval: false,
  mergeLargeChanged: null,
  prBranchPrefix: 'pieter',
  ...(usageLimit ? { usageLimit } : {}),
});

function stub(usageLimit?: object) {
  const body = (url: string): unknown => {
    if (url.startsWith('/api/workflows'))
      return { workflows: [{ id: ENTRY, orgId: null, status: 'active', definition: codeWorkflowV1 }] };
    if (url === '/api/projects') return { projects: [dto(usageLimit)] };
    if (url.startsWith('/api/board')) return { projectId: PROJECT, workflowKey: 'code', columns: [] };
    if (url.startsWith('/api/projects/'))
      return { project: dto(usageLimit), repos: [], members: [], mergePolicyHistory: [] };
    return {};
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => new Response(JSON.stringify(body(url)), { status: 200 })),
  );
}

function renderAt(path: string, route: string, el: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={el} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const LIMIT = { until: UNTIL, workstationName: 'Pieter laptop', label: '18:00 (Africa/Johannesburg)' };

describe('paused by the model usage limit (#73)', () => {
  it('the board header says until when and on which workstation', async () => {
    stub(LIMIT);
    renderAt('/p/TOY/board', '/p/:projectKey/board', <Board />);
    const banner = await screen.findByTestId('usage-limit-banner');
    expect(banner).toHaveTextContent(`Paused until ${formatUntil(UNTIL)} (usage limit on Pieter laptop)`);
    expect(banner).toHaveTextContent('without penalty');
  });

  it('the project page shows it too', async () => {
    stub(LIMIT);
    renderAt('/projects/' + PROJECT + '/settings', '/projects/:id/settings', <ProjectSettings />);
    expect(await screen.findByTestId('usage-limit-banner')).toHaveTextContent('Pieter laptop');
  });

  it('shows nothing for a project that is not paused', async () => {
    stub();
    renderAt('/p/TOY/board', '/p/:projectKey/board', <Board />);
    await screen.findByText('Toy');
    expect(screen.queryByTestId('usage-limit-banner')).toBeNull();
  });

  it('names the day when the reset is not today', () => {
    const now = new Date('2026-10-15T10:00:00');
    expect(formatUntil('2026-10-15T18:00:00', now)).toBe('18:00');
    expect(formatUntil('2026-10-17T09:00:00', now)).toMatch(/^Sat 17 Oct 09:00$/);
    const { container } = render(<UsageLimitBanner limit={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('per-project Claude accounts', () => {
  const limit = (over: object) => ({ until: UNTIL, workstationName: 'Pieter laptop', label: null, ...over });

  it('a paused project names the account', () => {
    render(<UsageLimitBanner limit={limit({ accountKey: 'work', mode: 'paused' }) as never} />);
    const banner = screen.getByTestId('usage-limit-banner');
    expect(banner).toHaveTextContent(
      `Paused until ${formatUntil(UNTIL)} (account work: usage limit on Pieter laptop)`,
    );
    expect(banner).toHaveTextContent('The Claude account work behind this project hit its usage limit');
  });

  it('a project on fallback says it runs on the main account meanwhile', () => {
    render(<UsageLimitBanner limit={limit({ accountKey: 'work', mode: 'fallback' }) as never} />);
    const banner = screen.getByTestId('usage-limit-banner');
    expect(banner).toHaveTextContent(
      `Running on the main account while work is out until ${formatUntil(UNTIL)}`,
    );
    expect(banner).toHaveTextContent('go back by themselves');
    expect(banner).not.toHaveTextContent('Paused');
  });

  it('a value without account or mode reads as before', () => {
    render(<UsageLimitBanner limit={limit({}) as never} />);
    expect(screen.getByTestId('usage-limit-banner')).toHaveTextContent(
      `Paused until ${formatUntil(UNTIL)} (usage limit on Pieter laptop)`,
    );
  });
});
