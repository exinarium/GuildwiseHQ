import { BUSINESS_WORKFLOWS, type WorkflowDefinition } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { CardNewForm } from '../pages/CardNew.tsx';

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

describe('new card in a business organization whose workflows load late', () => {
  it('moves to the first business type and shows its fields without a repository', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (extra: WorkflowDefinition[]) => (
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <CardNewForm
            projectId="0192f3a0-0000-7000-8000-000000000001"
            projectKey="OFFICE"
            projectKeys={['OFFICE']}
            onProject={() => {}}
            workflow={CODE}
            extraWorkflows={extra}
            repos={[]}
            business
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(ui([]));
    rerender(ui([...BUSINESS_WORKFLOWS]));
    expect(screen.getByLabelText('Card type')).toHaveValue('enquiry');
    expect(screen.getByLabelText('Who asked')).toBeInTheDocument();
    expect(screen.queryByLabelText('Repository')).toBeNull();
  });
});
