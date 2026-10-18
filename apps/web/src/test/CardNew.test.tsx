import { codeWorkflowV1 } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardNewForm } from '../pages/CardNew.tsx';

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const REPO = '0192f3a0-0000-7000-8000-000000000002';

function setup(mockUi = true, expert = false, projectDefault?: 'merge' | 'pr') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  // expert mode shows the per-card completion action (it is off by default)
  qc.setQueryData(['me'], { user: { gitExpert: expert } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CardNewForm
          projectId={PROJECT}
          projectKey="TOY"
          projectKeys={['TOY']}
          onProject={() => {}}
          workflow={codeWorkflowV1}
          repos={[{ id: REPO, name: 'toy' }]}
          mockUi={mockUi}
          projectDefault={projectDefault}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup({ applyAccept: false });
}

describe('CardNew mock fields', () => {
  it('are not offered to real users', () => {
    setup(false);
    for (const label of ['Mock script', 'Mock test environment', 'Mock outbound draft'])
      expect(screen.queryByLabelText(label)).toBeNull();
    expect(screen.getByLabelText('Requirements')).toBeInTheDocument();
  });

  it('are offered in mock mode', () => {
    setup(true);
    for (const label of ['Mock script', 'Mock test environment', 'Mock outbound draft'])
      expect(screen.getByLabelText(label)).toBeInTheDocument();
  });
});

describe('CardNew validation', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ card: { id: 'x', ref: 'TOY-1' } }), { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('requires a title for both actions and does not call the API', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(screen.getByText('Title is required')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Specify' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Specify lists every missing required field of the build stage', async () => {
    const user = setup();
    await user.type(screen.getByLabelText('Title'), 'Add login throttle');
    await user.click(screen.getByRole('button', { name: 'Specify' }));
    for (const label of [
      'Context',
      'Requirements',
      'Acceptance criteria',
      'Affected areas',
      'Constraints',
      'Test plan',
      'Repository',
    ]) {
      expect(screen.getByText(`${label} is required to specify this card`)).toBeInTheDocument();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Save draft only needs a title and posts specify=false', async () => {
    const user = setup();
    await user.type(screen.getByLabelText('Title'), 'Rough idea');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/cards');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      projectId: PROJECT,
      title: 'Rough idea',
      cardType: 'feature',
      specify: false,
    });
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('a complete form posts specify=true with parsed list and mock fields', async () => {
    const user = setup(true, true);
    await user.type(screen.getByLabelText('Title'), 'Full card');
    await user.selectOptions(screen.getByLabelText('Repository'), REPO);
    await user.selectOptions(screen.getByLabelText('Completion action'), 'pr');
    for (const label of ['Context', 'Requirements', 'Affected areas', 'Constraints', 'Test plan']) {
      await user.type(screen.getByLabelText(label), `${label} text`);
    }
    await user.type(screen.getByLabelText('Acceptance criteria'), 'one{Enter}two');
    await user.click(screen.getByLabelText('Mock script'));
    await user.paste('{"review":["changes","ok"]}');
    await user.click(screen.getByRole('button', { name: 'Specify' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.specify).toBe(true);
    expect(body.fields.acceptanceCriteria).toEqual(['one', 'two']);
    expect(body.fields.mock).toEqual({ review: ['changes', 'ok'] });
    expect(body.repoId).toBe(REPO);
    expect(body.completionAction).toBe('pr');
  });

  it('offers the project default first and sends no completion action unless it is changed', async () => {
    const user = setup(true, true, 'pr');
    const select = screen.getByLabelText('Completion action') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(within(select).getByRole('option', { name: /Project default \(.+\)/ })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'Follows the project');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body).not.toHaveProperty('completionAction');
  });

  it('does not offer the retired push-the-branch action (backlog #61)', () => {
    setup(true, true);
    const select = screen.getByLabelText('Completion action') as HTMLSelectElement;
    const values = within(select)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(expect.arrayContaining(['pr', 'merge']));
    expect(values).not.toContain('push_branch');
  });

  it('rejects a malformed mock script', async () => {
    const user = setup();
    await user.type(screen.getByLabelText('Title'), 'Bad mock');
    await user.click(screen.getByLabelText('Mock script'));
    await user.paste('{nope');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    const field = screen.getByLabelText('Mock script');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(within(field.parentElement as HTMLElement).getByText('Invalid JSON')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
