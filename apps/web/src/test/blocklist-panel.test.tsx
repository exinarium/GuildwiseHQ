import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { PlatformSecurity } from '../pages/platform/PlatformSecurity.tsx';

/** R1: the Block list tab of the platform Security page lists, adds and removes entries. */

const res = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ENTRY = {
  id: '33333333-3333-4333-8333-333333333333',
  kind: 'domain',
  value: 'spam.test',
  note: 'probe',
  createdBy: { id: '44444444-4444-4444-8444-444444444444', displayName: 'Root' },
  createdAt: '2026-11-21T00:00:00.000Z',
};
const ADDED = {
  ...ENTRY,
  id: '55555555-5555-4555-8555-555555555555',
  kind: 'ip',
  value: '203.0.113.0/24',
  note: '',
};

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>
          <PlatformSecurity initialTab="blocklist" />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Block list tab', () => {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  let entries: unknown[] = [];
  beforeEach(() => {
    calls.length = 0;
    entries = [ENTRY];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, url: String(url), body });
        if (method === 'POST' && (body as { value: string }).value === 'nonsense')
          return res(400, {
            error: { code: 'invalid_block_value', message: 'not an IP address or CIDR range' },
          });
        if (method === 'POST') entries = [ADDED, ENTRY];
        if (method === 'DELETE') entries = entries.filter((e) => (e as { id: string }).id !== ENTRY.id);
        return res(method === 'POST' ? 201 : 200, { entries });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists entries, adds one, shows a refused value, and removes one after confirming', async () => {
    const user = userEvent.setup();
    wrap();
    const row = await screen.findByTestId('blocklist-entry');
    expect(row).toHaveTextContent('spam.test');
    expect(row).toHaveTextContent('Blocked domain');
    expect(row).toHaveTextContent('by Root');

    await user.selectOptions(screen.getByLabelText('Kind'), 'ip');
    await user.type(screen.getByLabelText('Value'), 'nonsense');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('not an IP address or CIDR range')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Value'));
    await user.type(screen.getByLabelText('Value'), '203.0.113.0/24');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.getAllByTestId('blocklist-entry')).toHaveLength(2));
    expect(
      calls.find((c) => c.method === 'POST' && c.body && (c.body as any).value !== 'nonsense')?.body,
    ).toEqual({
      kind: 'ip',
      value: '203.0.113.0/24',
    });

    const spam = screen.getAllByTestId('blocklist-entry').find((r) => r.textContent?.includes('spam.test'));
    await user.click(within(spam as HTMLElement).getByRole('button', { name: 'Remove' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.getAllByTestId('blocklist-entry')).toHaveLength(1));
    expect(
      calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/platform/blocklist/${ENTRY.id}`)),
    ).toBe(true);
  });

  it('says so when the list is empty', async () => {
    entries = [];
    wrap();
    expect(await screen.findByText('The block list is empty')).toBeInTheDocument();
  });
});
