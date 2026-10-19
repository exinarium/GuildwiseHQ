import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectLinksTab } from '../components/orgsettings/ProjectLinksTab.tsx';

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const P1 = '0192f3a0-0000-7000-8000-0000000000a1';
const P2 = '0192f3a0-0000-7000-8000-0000000000a2';
const project = (id: string, key: string, name: string) => ({
  id,
  key,
  name,
  myRole: 'owner',
  status: 'active',
  kind: 'project',
});

let links: Array<Record<string, unknown>>;
let calls: Array<{ method: string; url: string; body?: any }>;
beforeEach(() => {
  calls = [];
  links = [
    {
      id: '0192f3a0-0000-7000-8000-0000000000b1',
      from: { projectId: P1, label: 'SHOP' },
      to: { projectId: null, label: 'status-page.example' },
      kind: 'uses',
      note: null,
      origin: 'owner',
      assertedAt: '2026-10-19T10:00:00.000Z',
    },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url === '/api/projects')
        return json({ projects: [project(P1, 'SHOP', 'Web shop'), project(P2, 'BILL', 'Billing')] });
      if (url === '/api/org-graph/links' && method === 'GET') return json({ links });
      if (url === '/api/org-graph/links' && method === 'POST') {
        links = [
          ...links,
          {
            id: '0192f3a0-0000-7000-8000-0000000000b2',
            from: { projectId: P1, label: 'SHOP' },
            to: { projectId: P2, label: 'BILL' },
            kind: 'depends_on',
            note: null,
            origin: 'owner',
            assertedAt: '2026-10-19T11:00:00.000Z',
          },
        ];
        return json({ links }, 201);
      }
      if (url.startsWith('/api/org-graph/links/') && method === 'DELETE') {
        links = [];
        return json({ links });
      }
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ProjectLinksTab />
    </QueryClientProvider>,
  );

describe('ProjectLinksTab (links the Owner asserts; nothing derived from code)', () => {
  it('lists the links with the names the Owner typed, and says the code suggestions stay on the workstation', async () => {
    mount();
    const row = await screen.findByTestId('org-link-0192f3a0-0000-7000-8000-0000000000b1');
    expect(row).toHaveTextContent('SHOP');
    expect(row).toHaveTextContent('uses');
    expect(row).toHaveTextContent('status-page.example');
    expect(screen.getByText(/what your code suggests stays on your workstation/)).toBeTruthy();
  });

  it('adds a link between two projects, and one to a name typed by the Owner', async () => {
    mount();
    await screen.findByTestId('org-links');
    await userEvent.click(screen.getByRole('button', { name: 'Add the link' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      from: { projectId: P1 },
      to: { projectId: P2 },
      kind: 'depends_on',
    });
    await userEvent.selectOptions(screen.getByLabelText('To'), '__name__');
    await userEvent.type(screen.getByLabelText('Name of the second end'), '  billing-api ');
    await userEvent.click(screen.getByRole('button', { name: 'Add the link' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'POST')[1]?.body).toMatchObject({ to: { name: 'billing-api' } });
  });

  it('removes a link', async () => {
    mount();
    await userEvent.click(
      await screen.findByRole('button', { name: /Remove the link SHOP to status-page.example/ }),
    );
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')?.url).toBe(
      '/api/org-graph/links/0192f3a0-0000-7000-8000-0000000000b1',
    );
  });
});
