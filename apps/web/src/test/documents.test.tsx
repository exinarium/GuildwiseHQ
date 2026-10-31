import type { DocumentDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { DocumentsList, DocumentView } from '../pages/Documents.tsx';
import { initSocket } from '../ws/socket.ts';

const DOC = '0192f3a0-0000-7000-8000-0000000000e1';
const AT = '2026-10-03T10:00:00.000Z';

const doc = (over: Partial<DocumentDto> = {}): DocumentDto => ({
  id: DOC,
  orgId: 'o',
  projectId: null,
  kind: 'prd',
  title: 'PRD: Invoicing',
  slug: 'prd-invoicing',
  status: 'approved',
  currentVersion: 1,
  approvedVersion: 1,
  sourceThreadIds: [],
  publishState: 'queued',
  publishedVersion: 1,
  vaultPath: null,
  createdBy: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

type Call = { method: string; url: string; body?: unknown };
type Handler = (init: RequestInit) => { status?: number; body: unknown };
function stub(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const isFile = init.body instanceof File;
      calls.push({
        method,
        url,
        ...(init.body ? { body: isFile ? init.body : JSON.parse(String(init.body)) } : {}),
      });
      const key = Object.keys(handlers)
        .filter((k) => `${method} ${url}`.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const r = key ? (handlers[key] as Handler)(init) : { body: {} };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
  return calls;
}
const me = (role: string) => ({
  'GET /api/auth/me': () => ({
    body: {
      user: { id: 'u', email: 'o@example.com', displayName: 'Owner' },
      activeOrg: { id: 'o', name: 'Org', role },
    },
  }),
});
const TAGS = {
  'GET /api/documents/tags': () => ({
    body: {
      tags: [
        { tag: 'design', count: 2 },
        { tag: 'hr', count: 1 },
      ],
    },
  }),
};

const mount = (path: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/documents" element={<DocumentsList />} />
            <Route path="/documents/:id" element={<DocumentView />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  const sock = initSocket(new QueryClient());
  sock.enableMockTransport();
  sock.start();
});
afterEach(() => vi.unstubAllGlobals());

describe('Documents list: tags, search and tag filter', () => {
  it('shows tags and the file name on a row, with at most three tags and a count', async () => {
    stub({
      ...me('owner'),
      ...TAGS,
      'GET /api/documents?': () => ({ body: { documents: [] } }),
      'GET /api/documents': () => ({
        body: {
          documents: [
            doc({
              kind: 'file',
              tags: ['a', 'b', 'c', 'd'],
              file: { name: 'plan.pdf', contentType: 'application/pdf', size: 10, sha256: 'x', image: false },
            }),
            doc({ id: 'x2', title: 'No tags' }),
          ],
        },
      }),
    });
    mount('/documents');
    const rows = await screen.findAllByTestId('document-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('plan.pdf');
    expect(rows[0]).toHaveTextContent('Uploaded file');
    expect(within(rows[0] as HTMLElement).getByTestId('document-tags')).toHaveTextContent('+1');
    expect(within(rows[1] as HTMLElement).queryByTestId('document-tags')).toBeNull();
  });

  it('sends the search text and the selected tags, and clears them again', async () => {
    const calls = stub({
      ...me('owner'),
      ...TAGS,
      'GET /api/documents': () => ({ body: { documents: [doc({ tags: ['design'] })] } }),
    });
    mount('/documents');
    const user = userEvent.setup();
    await screen.findAllByTestId('document-row');
    const search = screen.getByRole('searchbox', { name: 'Search documents' });
    expect(search).toHaveAttribute('inputmode', 'search');
    await user.type(search, 'roadmap');
    await waitFor(() => expect(calls.some((c) => c.url.includes('q=roadmap'))).toBe(true));
    await user.click(await screen.findByRole('button', { name: '#design' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('tags=design') && c.url.includes('q=roadmap'))).toBe(true),
    );
    await user.click(screen.getByRole('button', { name: '#hr' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('tags=design%2Chr'))).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(search).toHaveValue('');
  });

  it('tells you when nothing matches, with a way back', async () => {
    stub({ ...me('owner'), ...TAGS, 'GET /api/documents': () => ({ body: { documents: [] } }) });
    mount('/documents');
    const user = userEvent.setup();
    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: '#design' }));
    expect(await screen.findByText('No documents match')).toBeInTheDocument();
  });
});

describe('Upload dialog', () => {
  const file = () => new File(['# Handbook'], 'Handbook.md', { type: 'text/markdown' });

  it('is offered to Owners and Admins only', async () => {
    stub({ ...me('member'), ...TAGS, 'GET /api/documents': () => ({ body: { documents: [] } }) });
    mount('/documents');
    await screen.findByText('No documents yet');
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
  });

  it('uploads the file with its title, project and tags, then closes', async () => {
    const calls = stub({
      ...me('owner'),
      ...TAGS,
      'GET /api/projects': () => ({
        body: { projects: [{ id: '0192f3a0-0000-7000-8000-0000000000f1', name: 'Toy', key: 'TOY' }] },
      }),
      'GET /api/documents': () => ({ body: { documents: [] } }),
      'POST /api/documents/upload': () => ({ status: 201, body: { document: doc() } }),
    });
    mount('/documents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Upload' }));
    const dialog = await screen.findByRole('dialog');
    await user.upload(within(dialog).getByLabelText('File'), file());
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Handbook');
    await user.type(within(dialog).getByLabelText('Tags'), 'HR Policy{Enter}');
    expect(within(dialog).getByRole('button', { name: 'Remove tag hr-policy' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Upload' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.startsWith('/api/documents/upload'))).toBe(true),
    );
    const post = calls.find((c) => c.method === 'POST') as Call;
    expect(post.url).toContain('tags=hr-policy');
    expect(post.url).toContain('title=Handbook');
    expect(post.url).toContain('name=Handbook.md');
    expect((post.body as File).name).toBe('Handbook.md');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows the server’s reason inside the dialog and keeps it open', async () => {
    stub({
      ...me('owner'),
      ...TAGS,
      'GET /api/projects': () => ({ body: { projects: [] } }),
      'GET /api/documents': () => ({ body: { documents: [] } }),
      'POST /api/documents/upload': () => ({
        status: 422,
        body: {
          error: { code: 'document_rejected', message: 'run.png: the content is not a valid .png file' },
        },
      }),
    });
    mount('/documents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Upload' }));
    const dialog = await screen.findByRole('dialog');
    await user.upload(within(dialog).getByLabelText('File'), new File(['x'], 'run.png'));
    await user.click(within(dialog).getByRole('button', { name: 'Upload' }));
    expect(await within(dialog).findByText(/not a valid \.png file/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('Document view: tags and file', () => {
  const view = (extra: Partial<DocumentDto> = {}) => ({
    document: { ...doc(extra), content: 'Body', versions: [] },
  });

  it('shows the tags and lets a manager edit them', async () => {
    const calls = stub({
      ...me('owner'),
      ...TAGS,
      [`GET /api/documents/${DOC}`]: () => ({ body: view({ tags: ['design'] }) }),
      [`PUT /api/documents/${DOC}/tags`]: () => ({ body: view({ tags: ['design', 'q4'] }) }),
    });
    mount(`/documents/${DOC}`);
    const user = userEvent.setup();
    const tags = await screen.findAllByTestId('document-tags');
    expect(tags[0]).toHaveTextContent('design');
    await user.click(await screen.findByRole('button', { name: 'Edit tags' }));
    await user.type(screen.getByLabelText('Tags'), 'Q4{Enter}');
    await user.click(screen.getByRole('button', { name: 'Save tags' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect((calls.find((c) => c.method === 'PUT') as Call).body).toEqual({ tags: ['design', 'q4'] });
  });

  it('does not offer tag editing to a member', async () => {
    stub({ ...me('member'), ...TAGS, [`GET /api/documents/${DOC}`]: () => ({ body: view() }) });
    mount(`/documents/${DOC}`);
    expect(await screen.findByText('No tags')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit tags' })).toBeNull();
  });

  it('shows the file with a download link and an image preview', async () => {
    stub({
      ...me('owner'),
      ...TAGS,
      [`GET /api/documents/${DOC}`]: () => ({
        body: view({
          kind: 'file',
          file: { name: 'diagram.png', contentType: 'image/png', size: 2048, sha256: 'x', image: true },
        }),
      }),
    });
    mount(`/documents/${DOC}`);
    const panel = await screen.findByTestId('document-file');
    expect(within(panel).getByRole('link', { name: /Download/ })).toHaveAttribute(
      'href',
      `/api/documents/${DOC}/file?download=1`,
    );
    expect(within(panel).getByRole('img', { name: 'diagram.png' })).toHaveAttribute(
      'src',
      `/api/documents/${DOC}/file`,
    );
    expect(panel).toHaveTextContent('2.0 KB');
  });
});
