import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { Forms } from '../pages/Forms.tsx';

const F1 = '0192f3a0-0000-7000-8000-0000000000c1';
const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let role = 'owner';
let calls: Array<{ method: string; url: string }>;
let archived = false;

beforeEach(() => {
  role = 'owner';
  archived = false;
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (method !== 'GET') calls.push({ method, url });
      if (url.startsWith('/api/auth/me'))
        return json({
          user: { id: 'u1', displayName: 'Pieter', email: 'p@x.test' },
          isAdmin: role === 'owner',
          visibleProjectIds: [],
          activeOrg: { id: 'o1', name: 'Acme', role, status: 'active', plan: 'team', planName: 'Team', features: {} },
        });
      if (url === '/api/forms?status=active')
        return json({
          forms: archived
            ? []
            : [
                {
                  id: F1,
                  title: 'Rental application',
                  latestVersion: 3,
                  status: 'active',
                  fieldCount: 10,
                  updatedAt: new Date().toISOString(),
                  updatedByName: 'Pieter',
                },
              ],
        });
      if (url === '/api/forms?status=archived') return json({ forms: [] });
      if (url.endsWith('/archive')) {
        archived = true;
        return json(null, 204);
      }
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/forms']}>
          <Routes>
            <Route path="/forms" element={<Forms />} />
            <Route path="/forms/new" element={<p>builder</p>} />
            <Route path="/forms/:id" element={<p>builder of a form</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('forms list', () => {
  it('lists forms with fields, version and who updated them', async () => {
    mount();
    const row = await screen.findByTestId(`form-row-${F1}`);
    expect(row).toHaveTextContent('Rental application');
    expect(row).toHaveTextContent('10 fields · version 3');
    expect(row).toHaveTextContent('by Pieter');
  });

  it('offers New form to admins only', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByTestId(`form-row-${F1}`);
    await user.click(await screen.findByTestId('new-form'));
    expect(await screen.findByText('builder')).toBeInTheDocument();
  });

  it('hides New form and the row menu from a member', async () => {
    role = 'member';
    mount();
    await screen.findByTestId(`form-row-${F1}`);
    await waitFor(() => expect(screen.queryByTestId('new-form')).toBeNull());
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
  });

  it('archives a form from its menu', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: 'Actions for Rental application' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', url: `/api/forms/${F1}/archive` }));
    expect(await screen.findByText('No forms yet')).toBeInTheDocument();
  });

  it('shows an empty state for archived forms', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('tab', { name: 'Archived' }));
    expect(await screen.findByText('No archived forms')).toBeInTheDocument();
  });
});
