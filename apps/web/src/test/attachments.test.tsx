import type { CardAttachmentDto, WorkstationDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentsPanel } from '../components/AttachmentsPanel.tsx';
import { JiraStatusLine } from '../components/JiraStatusLine.tsx';
import { NewCardFiles } from '../components/NewCardFiles.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const CARD = ID(1);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const attachment = (n: number, over: Partial<CardAttachmentDto> = {}): CardAttachmentDto => ({
  id: ID(10 + n),
  cardId: CARD,
  name: `file${n}.png`,
  contentType: 'image/png',
  size: 2048,
  sha256: 'a'.repeat(64),
  image: true,
  addedByName: 'Pieter',
  addedByAgent: false,
  source: null,
  createdAt: '2026-10-13T08:00:00.000Z',
  ...over,
});

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
const calls: Call[] = [];
let respond: (c: Call) => Response = () => json({});
beforeEach(() => {
  calls.length = 0;
  respond = () => json({});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const c = {
        method: init.method ?? 'GET',
        url,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body,
      };
      calls.push(c);
      return respond(c);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (el: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  );
};

const png = (name = 'shot.png', size = 10) => new File([new Uint8Array(size)], name, { type: 'image/png' });

describe('the attachments section of a card', () => {
  it('lists the files with name, size, who and when, previews images and offers download', () => {
    const svg = attachment(2, {
      name: 'SlideOutHistory.svg',
      contentType: 'image/svg+xml',
      source: 'jira DCPL-4276',
      addedByName: 'Ben',
      addedByAgent: true,
    });
    const pdf = attachment(3, {
      name: 'spec.pdf',
      contentType: 'application/pdf',
      image: false,
      size: 3 * 1024 * 1024,
    });
    wrap(<AttachmentsPanel cardId={CARD} attachments={[attachment(1), svg, pdf]} canAttach />);
    const panel = screen.getByTestId('attachments');
    expect(within(panel).getByRole('heading', { name: /Attachments \(3\)/ })).toBeTruthy();
    const items = within(screen.getByTestId('attachment-list')).getAllByRole('listitem');
    expect(items).toHaveLength(3);

    // an image previews through the card's attachment URL
    const preview = within(items[0] as HTMLElement).getByRole('img', { name: 'Preview of file1.png' });
    expect(preview.getAttribute('src')).toBe(`/api/cards/${CARD}/attachments/${ID(11)}`);
    // who, when, size, and where an agent got it
    expect(within(items[1] as HTMLElement).getByText(/2\.0 KB · Ben \(agent\)/)).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText(/from jira DCPL-4276/)).toBeTruthy();
    // a document is not previewed
    expect(within(items[2] as HTMLElement).queryByRole('img')).toBeNull();
    expect(within(items[2] as HTMLElement).getByText(/3\.0 MB/)).toBeTruthy();
    // download forces a download
    expect(screen.getByRole('link', { name: 'Download spec.pdf' }).getAttribute('href')).toBe(
      `/api/cards/${CARD}/attachments/${ID(13)}?download=1`,
    );
  });

  it('uploads the chosen files one by one as raw bodies with their names', async () => {
    const user = userEvent.setup({ applyAccept: false });
    wrap(<AttachmentsPanel cardId={CARD} attachments={[]} canAttach />);
    expect(screen.getByText(/No files yet/)).toBeTruthy();
    await user.upload(screen.getByTestId('attachment-input'), [png('a.png'), png('b c.png')]);
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts[0]?.url).toBe(`/api/cards/${CARD}/attachments?name=a.png`);
    expect(posts[1]?.url).toBe(`/api/cards/${CARD}/attachments?name=b%20c.png`);
    expect(posts[0]?.headers['content-type']).toBe('application/octet-stream');
    expect((posts[0]?.body as File | undefined)?.name).toBe('a.png');
  });

  it('accepts dropped files', async () => {
    wrap(<AttachmentsPanel cardId={CARD} attachments={[attachment(1)]} canAttach />);
    fireEvent.drop(screen.getByTestId('attachment-drop'), { dataTransfer: { files: [png('dropped.png')] } });
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('name=dropped.png'))).toBe(true),
    );
  });

  it('refuses a file over 20 MB without sending it, and shows what the server refused', async () => {
    const user = userEvent.setup({ applyAccept: false });
    respond = () =>
      json(
        { error: { code: 'attachment_rejected', message: 'setup.exe: .exe files cannot be attached' } },
        422,
      );
    wrap(<AttachmentsPanel cardId={CARD} attachments={[]} canAttach />);
    const big = new File(['x'], 'huge.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    await user.upload(screen.getByTestId('attachment-input'), big);
    expect(await screen.findByText('huge.png: larger than 20 MB')).toBeTruthy();
    expect(calls).toHaveLength(0);

    await user.upload(screen.getByTestId('attachment-input'), png('setup.exe'));
    expect(await screen.findByText('setup.exe: setup.exe: .exe files cannot be attached')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Some files were not attached');
  });

  it('removes a file after a confirmation', async () => {
    const user = userEvent.setup({ applyAccept: false });
    wrap(<AttachmentsPanel cardId={CARD} attachments={[attachment(1), attachment(2)]} canAttach />);
    await user.click(screen.getByRole('button', { name: 'Remove file2.png' }));
    expect(calls).toHaveLength(0); // nothing yet
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Remove file2.png\?/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Remove file' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: `/api/cards/${CARD}/attachments/${ID(12)}` });
  });

  it('shows read-only members the files but no controls, and nothing at all when there are none', () => {
    const { container, rerender } = wrap(
      <AttachmentsPanel cardId={CARD} attachments={[attachment(1)]} canAttach={false} />,
    );
    expect(screen.getByText('file1.png')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add files/ })).toBeNull();
    expect(screen.queryByTestId('attachment-input')).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Download file1.png' })).toBeTruthy();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AttachmentsPanel cardId={CARD} attachments={[]} canAttach={false} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(container.querySelector('[data-testid="attachments"]')).toBeNull();
  });
});

describe('files on the New card form', () => {
  it('queues files, shows them, drops one, and refuses a file over 20 MB', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const Harness = () => {
      const [files, setFiles] = React.useState<File[]>([]);
      return <NewCardFiles files={files} onChange={setFiles} />;
    };
    wrap(<Harness />);
    await user.upload(screen.getByTestId('new-card-file-input'), [png('one.png', 2048), png('two.png')]);
    expect(screen.getByText('one.png')).toBeTruthy();
    expect(screen.getByText('two.png')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Do not attach one.png' }));
    expect(screen.queryByText('one.png')).toBeNull();
    const big = new File(['x'], 'huge.zip');
    Object.defineProperty(big, 'size', { value: 25 * 1024 * 1024 });
    await user.upload(screen.getByTestId('new-card-file-input'), big);
    expect(screen.getByRole('alert').textContent).toMatch(/huge.zip: larger than 20 MB/);
    expect(screen.queryByText('huge.zip')).toBeNull();
  });
});

describe('Jira on the Workstations page', () => {
  const ws = (jira: WorkstationDto['jira'], connected = true) =>
    ({ connected, jira }) as unknown as WorkstationDto;
  it('says connected (with the account), not connected (with the command) or refused (with the reason)', () => {
    const { unmount } = wrap(
      <JiraStatusLine
        w={ws({
          status: { state: 'connected', baseUrl: 'https://acme.atlassian.net', account: 'Pieter' },
          checkedAt: null,
        })}
      />,
    );
    expect(screen.getByText('Connected as Pieter')).toBeTruthy();
    expect(screen.getByText('acme.atlassian.net')).toBeTruthy();
    expect(screen.queryByText(/jira-connect/)).toBeNull();
    unmount();

    const none = wrap(<JiraStatusLine w={ws({ status: { state: 'not_connected' }, checkedAt: null })} />);
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(screen.getByText('aom-runner jira-connect')).toBeTruthy();
    none.unmount();

    wrap(
      <JiraStatusLine
        w={ws({
          status: { state: 'refused', detail: 'Jira answered 401: the token is wrong or expired' },
          checkedAt: null,
        })}
      />,
    );
    expect(screen.getByText('Refused')).toBeTruthy();
    expect(screen.getByText(/Jira answered 401/)).toBeTruthy();
    // never anything token-like on the page
    expect(document.body.textContent).not.toMatch(/apiToken/);
  });

  it('is "Unknown" until an up-to-date runner reports', () => {
    wrap(<JiraStatusLine w={ws(undefined)} />);
    expect(screen.getByText('Unknown')).toBeTruthy();
  });
});
