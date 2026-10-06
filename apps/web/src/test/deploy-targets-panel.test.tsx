import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeployTargetsPanel } from '../components/DeployTargetsPanel.tsx';

const U = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('DeployTargetsPanel', () => {
  it('lists every project member workstation for a remote host', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/workstations'))
        return json({
          workstations: [
            {
              id: U(1),
              name: 'Desk',
              ownerId: U(9),
              ownerName: 'Ann',
              mine: true,
              connected: true,
              hasDevops: true,
            },
            {
              id: U(2),
              name: 'Laptop',
              ownerId: U(8),
              ownerName: 'Bob',
              mine: false,
              connected: false,
              hasDevops: false,
            },
          ],
        });
      return json({ targets: [] });
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DeployTargetsPanel projectId={U(5)} />
      </QueryClientProvider>,
    );
    await userEvent.selectOptions(screen.getByLabelText('Kind'), 'remote_ssh');
    const select = await screen.findByLabelText('Workstation that deploys');
    await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(3));
    const labels = [...select.querySelectorAll('option')].map((o) => o.textContent?.replace(/\s+/g, ' '));
    expect(labels[1]).toBe('Desk (yours)');
    expect(labels[2]).toBe('Laptop (Bob), no DevOps engineer, offline');
  });
});
