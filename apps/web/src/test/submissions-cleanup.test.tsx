import type { FormSubmissionDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SubmissionsList } from '../components/forms/SubmissionsList.tsx';

const FORM = '0192f3a0-0000-7000-8000-000000000009';

function show(subs: FormSubmissionDto[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['forms', 'one', FORM, 'submissions'], subs);
  render(
    <QueryClientProvider client={qc}>
      <SubmissionsList formId={FORM} />
    </QueryClientProvider>,
  );
}

const base = {
  formVersion: 1,
  reference: null,
  errorCode: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  completedAt: null,
  status: 'expired' as const,
};

describe('SubmissionsList cleanup state', () => {
  it('shows removed files as visible text', () => {
    show([
      {
        ...base,
        id: 'a',
        stored: [
          { label: 'id_copy', path: 'F/id.png', cleanup: { state: 'removed', attempts: 0, error: null } },
          { label: 'photo', path: 'F/p.png', cleanup: { state: 'removed', attempts: 0, error: null } },
        ],
        cleanup: { pending: 0, removed: 2, failed: 0 },
      },
    ]);
    expect(screen.getByTestId('submission-cleanup')).toHaveTextContent('Uploaded files: 2 removed');
    expect(screen.getAllByTestId('stored-cleanup-removed')).toHaveLength(2);
  });

  it('shows pending files, with the reason when there is one', () => {
    show([
      {
        ...base,
        id: 'b',
        stored: [
          {
            label: 'id_copy',
            path: 'F/id.png',
            cleanup: { state: 'pending', attempts: 0, error: "The firm's workstation is offline." },
          },
        ],
        cleanup: { pending: 1, removed: 0, failed: 0 },
      },
    ]);
    expect(screen.getByTestId('submission-cleanup')).toHaveTextContent('1 waiting to be removed');
    expect(screen.getByTestId('stored-cleanup-pending')).toHaveTextContent(
      "waiting to be removed (The firm's workstation is offline.)",
    );
  });

  it('shows files that could not be removed with the last error', () => {
    show([
      {
        ...base,
        id: 'c',
        stored: [
          {
            label: 'id_copy',
            path: 'F/id.png',
            cleanup: { state: 'failed', attempts: 8, error: 'Refused.' },
          },
          { label: 'photo', path: 'F/p.png', cleanup: { state: 'removed', attempts: 1, error: null } },
        ],
        cleanup: { pending: 0, removed: 1, failed: 1 },
      },
    ]);
    expect(screen.getByTestId('submission-cleanup')).toHaveTextContent('1 removed · 1 could not be removed');
    expect(screen.getByTestId('stored-cleanup-failed')).toHaveTextContent('could not be removed: Refused.');
  });

  it('shows nothing extra for a submission without a cleanup', () => {
    show([
      {
        ...base,
        id: 'd',
        status: 'complete',
        stored: [{ label: 'Answers (JSON)', path: 'F/a.json' }],
        cleanup: null,
      },
    ]);
    const item = screen.getByTestId('submission-complete');
    expect(within(item).queryByTestId('submission-cleanup')).toBeNull();
    expect(within(item).getByText(/F\/a\.json/)).toBeInTheDocument();
  });
});
