import type { FormPublicationDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublishPanel } from '../components/forms/PublishPanel.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { qrMatrix, qrPathData } from '../lib/qr.ts';

const F = '0192f3a0-0000-7000-8000-0000000000a1';
const URL_ = 'https://hq.example.com/f/AbCdEfGhIjKlMnOpQrStUv';
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const pub = (over: Partial<FormPublicationDto> = {}): FormPublicationDto => ({
  status: 'published',
  url: URL_,
  publicId: 'AbCdEfGhIjKlMnOpQrStUv',
  version: 2,
  latestVersion: 2,
  publishedAt: '2026-11-04T08:00:00.000Z',
  archived: false,
  warnings: [],
  ...over,
});

let calls: Array<{ method: string; url: string }>;
let next: FormPublicationDto;
beforeEach(() => {
  calls = [];
  next = pub({ status: 'unpublished', url: null, publicId: null, version: null });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? 'GET', url });
      return json(next);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const show = (p: FormPublicationDto, canEdit = true) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <PublishPanel formId={F} publication={p} canEdit={canEdit} />
      </ToastProvider>
    </QueryClientProvider>,
  );

describe('PublishPanel', () => {
  it('shows the address and a QR code that encodes exactly that address', () => {
    show(pub());
    expect(screen.getByTestId('public-url')).toHaveTextContent(URL_);
    expect(screen.getByTestId('publication-status')).toHaveTextContent('Published');
    const svg = screen.getByRole('img', { name: /QR code/ });
    const { modules } = qrMatrix(URL_);
    expect(svg.querySelector('path')?.getAttribute('d')).toBe(qrPathData(modules));
  });

  it('an unpublished form has Publish and no address or QR code', async () => {
    show(pub({ status: 'unpublished', url: null, publicId: null, version: null }));
    expect(screen.queryByTestId('public-url')).toBeNull();
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
    next = pub();
    await userEvent.setup().click(screen.getByTestId('publish-form'));
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', url: `/api/forms/${F}/publish` }));
  });

  it('offers Publish changes only when a newer version exists', () => {
    const { unmount } = show(pub());
    expect(screen.queryByTestId('publish-form')).toBeNull();
    unmount();
    show(pub({ latestVersion: 3 }));
    expect(screen.getByTestId('publish-form')).toHaveTextContent('Publish changes');
  });

  it('Unpublish asks first, then calls the route', async () => {
    show(pub());
    const u = userEvent.setup();
    await u.click(screen.getByTestId('unpublish-form'));
    expect(calls.some((c) => c.url.endsWith('/unpublish'))).toBe(false);
    expect(await screen.findByText(/will show "form not available"/)).toBeInTheDocument();
    next = pub({ status: 'unpublished', url: null });
    await u.click(screen.getByRole('button', { name: 'Unpublish' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', url: `/api/forms/${F}/unpublish` }));
  });

  it('a new link warns that printed QR codes stop working before it does anything', async () => {
    show(pub());
    const u = userEvent.setup();
    await u.click(screen.getByTestId('reset-link'));
    expect(await screen.findByText(/every printed QR code stop working/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/reset-link'))).toBe(false);
  });

  it('shows the warnings and hides every action from a member', () => {
    show(
      pub({
        warnings: [
          { code: 'destination_offline', fields: ['answers'] },
          { code: 'unsupported_file_types', fields: ['id_copy'] },
        ],
      }),
      false,
    );
    expect(screen.getByTestId('warning-destination_offline')).toHaveTextContent(/workstation .* offline/);
    expect(screen.getByTestId('warning-unsupported_file_types')).toBeInTheDocument();
    expect(screen.queryByTestId('unpublish-form')).toBeNull();
    expect(screen.queryByTestId('reset-link')).toBeNull();
  });

  it('an archived form says the public link is closed', () => {
    show(pub({ archived: true, status: 'published' }));
    expect(screen.getByText(/archived: the public link is closed/)).toBeInTheDocument();
    expect(screen.queryByTestId('publish-form')).toBeNull();
  });
});
