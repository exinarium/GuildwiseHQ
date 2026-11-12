import { type ProjectDetailResponse, reviewSettingsStatus } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewSettingsPanel } from '../components/ReviewSettingsPanel.tsx';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Review = { sizeBudget: number | null; sizeUnit: 'changed_lines' | 'changed_files' | null; riskMap: any };
const empty: Review = { sizeBudget: null, sizeUnit: null, riskMap: null };
const project = (review: Review = empty) =>
  ({
    id: '0192f3a0-0000-7000-8000-0000000000b1',
    reviewSettings: { ...review, status: reviewSettingsStatus(review) },
  }) as unknown as ProjectDetailResponse['project'];

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('review settings panel', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(json({}));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const last = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined };
  };

  it('AC2/AC3: a new project shows nothing set, no preselected unit, and what each check misses', () => {
    wrap(<ReviewSettingsPanel projectId="p1" project={project()} canChange />);
    expect(screen.getByTestId('review-settings-budget')).toHaveValue('');
    expect(screen.getByTestId('review-settings-unit')).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Not set' })).toBeInTheDocument();
    expect(screen.getByTestId('review-settings-map-empty')).toBeInTheDocument();
    expect(screen.getByTestId('review-settings-status-size')).toHaveTextContent(
      'Size checks: inactive: no size budget set; inactive: no size unit set',
    );
    expect(screen.getByTestId('review-settings-status-risk')).toHaveTextContent(
      'Risk from paths: inactive: no path-to-risk map set',
    );
  });

  it('AC1: the owner fills budget, unit and two paths, and Save sends the whole value', async () => {
    const user = userEvent.setup();
    wrap(<ReviewSettingsPanel projectId="p1" project={project()} canChange />);
    await user.type(screen.getByTestId('review-settings-budget'), '400');
    await user.selectOptions(screen.getByTestId('review-settings-unit'), 'changed_lines');

    await user.click(screen.getByTestId('review-settings-add'));
    // the new row's path input has the focus and no class is preselected
    expect(screen.getAllByTestId('review-settings-pattern')[0]).toHaveFocus();
    expect(screen.getAllByTestId('review-settings-risk')[0]).toHaveValue('');
    await user.keyboard('apps/server/src/auth/');
    await user.selectOptions(screen.getAllByTestId('review-settings-risk')[0] as HTMLElement, 'high');

    await user.click(screen.getByTestId('review-settings-add'));
    await user.keyboard('docs/**');
    await user.selectOptions(screen.getAllByTestId('review-settings-risk')[1] as HTMLElement, 'low');

    await user.click(screen.getByTestId('review-settings-save'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(last()).toEqual({
      url: expect.stringContaining('/projects/p1/review-settings'),
      method: 'PUT',
      body: {
        sizeBudget: 400,
        sizeUnit: 'changed_lines',
        riskMap: [
          { pattern: 'apps/server/src/auth', risk: 'high' },
          { pattern: 'docs/**', risk: 'low' },
        ],
      },
    });
  });

  it('shows the saved values and sends null for a cleared budget and an emptied map', async () => {
    const user = userEvent.setup();
    const saved: Review = {
      sizeBudget: 250,
      sizeUnit: 'changed_files',
      riskMap: [{ pattern: 'apps/web', risk: 'medium' }],
    };
    wrap(<ReviewSettingsPanel projectId="p1" project={project(saved)} canChange />);
    expect(screen.getByTestId('review-settings-budget')).toHaveValue('250');
    expect(screen.getByTestId('review-settings-unit')).toHaveValue('changed_files');
    expect(screen.getByTestId('review-settings-pattern')).toHaveValue('apps/web');
    expect(screen.getByTestId('review-settings-status-size')).toHaveTextContent('Size checks: active');

    await user.clear(screen.getByTestId('review-settings-budget'));
    await user.click(screen.getByTestId('review-settings-remove'));
    await user.click(screen.getByTestId('review-settings-save'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(last().body).toEqual({ sizeBudget: null, sizeUnit: 'changed_files', riskMap: null });
  });

  it('shows inline errors for a budget of 0, a row without a class and a duplicate path, and sends nothing', async () => {
    const user = userEvent.setup();
    wrap(<ReviewSettingsPanel projectId="p1" project={project()} canChange />);
    await user.type(screen.getByTestId('review-settings-budget'), '0');
    await user.click(screen.getByTestId('review-settings-add'));
    await user.keyboard('apps/web');
    await user.click(screen.getByTestId('review-settings-add'));
    await user.keyboard('apps/web/');
    await user.selectOptions(screen.getAllByTestId('review-settings-risk')[1] as HTMLElement, 'low');
    await user.click(screen.getByTestId('review-settings-save'));

    expect(screen.getByText('A whole number of 1 or more')).toBeInTheDocument();
    expect(screen.getByText('Choose a class')).toBeInTheDocument();
    expect(screen.getByText('This path is already in the list')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a path that leaves the repository', async () => {
    const user = userEvent.setup();
    wrap(<ReviewSettingsPanel projectId="p1" project={project()} canChange />);
    await user.click(screen.getByTestId('review-settings-add'));
    await user.keyboard('../secrets');
    await user.selectOptions(screen.getByTestId('review-settings-risk'), 'high');
    await user.click(screen.getByTestId('review-settings-save'));
    expect(screen.getByText('No .. in a path')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('AC5: a manager sees the values read-only, with no inputs and no Save', () => {
    const saved: Review = {
      sizeBudget: 400,
      sizeUnit: 'changed_lines',
      riskMap: [{ pattern: 'apps/web', risk: 'high' }],
    };
    wrap(<ReviewSettingsPanel projectId="p1" project={project(saved)} canChange={false} />);
    expect(screen.getByTestId('review-settings-readonly')).toHaveTextContent(
      'Only the project owner can change these settings.',
    );
    expect(screen.getByTestId('review-settings-budget-value')).toHaveTextContent('400');
    expect(screen.getByTestId('review-settings-unit-value')).toHaveTextContent('Changed lines');
    expect(screen.getByTestId('review-settings-map-value')).toHaveTextContent('apps/web: High');
    expect(screen.queryByTestId('review-settings-save')).toBeNull();
    expect(screen.queryByTestId('review-settings-budget')).toBeNull();
  });
});
