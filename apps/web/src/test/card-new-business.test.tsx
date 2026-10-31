import { BUSINESS_WORKFLOWS, type WorkflowDefinition } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardNewForm } from '../pages/CardNew.tsx';

afterEach(() => vi.unstubAllGlobals());

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const CODE = {
  key: 'code',
  version: 1,
  name: 'Code',
  builtIn: true,
  fieldSet: 'code',
  customFields: [],
  cardTypes: ['feature', 'bug'],
  initialStage: 'intake',
  stages: [],
} as unknown as WorkflowDefinition;

function renderForm(business: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CardNewForm
          projectId={PROJECT}
          projectKey="OFFICE"
          projectKeys={['OFFICE']}
          onProject={() => {}}
          workflow={CODE}
          extraWorkflows={[...BUSINESS_WORKFLOWS]}
          repos={[]}
          business={business}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('new card in a business organization', () => {
  it('offers the six business types, by label, and no developer type', () => {
    renderForm(true);
    const options = within(screen.getByLabelText('Card type'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Enquiry', 'Follow-up', 'Document request', 'Reminder', 'Report', 'Quote']);
    expect(screen.getByLabelText('Card type')).toHaveValue('enquiry');
  });

  it('shows the type fields and no repository, completion action or docs', () => {
    renderForm(true);
    for (const label of ['Who asked', 'Channel', 'Question', 'Due by'])
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.getByLabelText('Due by')).toHaveAttribute('type', 'date');
    expect(screen.queryByLabelText('Repository')).toBeNull();
    expect(screen.queryByLabelText('Completion action')).toBeNull();
    expect(screen.queryByText('Docs needed')).toBeNull();
  });
});

describe('new card in a developer organization', () => {
  it('offers the developer types only', () => {
    renderForm(false);
    const options = within(screen.getByLabelText('Card type'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['feature', 'bug']);
    expect(screen.getByLabelText('Card type')).toHaveValue('feature');
  });
});
