import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ceoStatus, memory, renderCeoPage, stubApi, U } from './ceo-fixtures.tsx';

afterEach(() => vi.unstubAllGlobals());

const list = () => [
  memory(1),
  memory(2, { kind: 'preference', source: 'owner_desk_answer', text: 'prefers spaces' }),
  memory(3, { status: 'candidate', source: 'owner_training', text: 'never touch billing', confidence: 0.6 }),
  memory(4, { status: 'retired', text: 'old rule' }),
];
const base = (): Array<[string, () => unknown]> => [
  ['GET /api/ceo/status', () => ceoStatus()],
  ['GET /api/ceo/memories', () => ({ memories: list(), canView: true })],
];

describe('the CEO memory tab', () => {
  it('lists proposed rules first, then the active ones by kind with source, confidence and last confirmed', async () => {
    stubApi('owner', base());
    renderCeoPage('?tab=memory');
    const candidates = await screen.findByTestId('ceo-memory-candidates');
    const all = screen.getByTestId('ceo-memory');
    // the proposed block comes before every kind block
    expect(all.firstElementChild).toBe(candidates);
    expect(within(candidates).getByText('never touch billing')).toBeInTheDocument();
    expect(candidates).toHaveTextContent('learned from your choices');
    expect(candidates).toHaveTextContent('confidence 60%');
    const rows = screen.getAllByTestId('ceo-memory-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('rule 1');
    expect(rows[0]).toHaveTextContent('you said');
    expect(rows[0]).toHaveTextContent('last confirmed');
    expect(rows[1]).toHaveTextContent('your desk answer');
    expect(screen.getByRole('heading', { name: 'Rules' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Preferences' })).toBeInTheDocument();
  });

  it('Keep confirms a proposed rule and Drop retires it', async () => {
    const calls = stubApi('owner', base());
    renderCeoPage('?tab=memory');
    const candidate = await screen.findByTestId('ceo-memory-candidate');
    await userEvent.click(within(candidate).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/ceo/memories/${U(73)}/confirm`)).toBe(true));
    await userEvent.click(within(candidate).getByRole('button', { name: 'Drop' }));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/ceo/memories/${U(73)}/retire`)).toBe(true));
  });

  it('Edit on a proposed rule saves the new text and keeps it', async () => {
    const calls = stubApi('owner', base());
    renderCeoPage('?tab=memory');
    const candidate = await screen.findByTestId('ceo-memory-candidate');
    await userEvent.click(within(candidate).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    const box = within(dialog).getByLabelText('Rule');
    await userEvent.clear(box);
    await userEvent.type(box, 'ask before touching billing');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and keep' }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH');
      expect(patch?.url).toBe(`/api/ceo/memories/${U(73)}`);
      expect(patch?.body).toEqual({ text: 'ask before touching billing', confirm: true });
    });
  });

  it('Retire retires an active rule', async () => {
    const calls = stubApi('owner', base());
    renderCeoPage('?tab=memory');
    const row = (await screen.findAllByTestId('ceo-memory-row'))[0] as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Retire' }));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/ceo/memories/${U(71)}/retire`)).toBe(true));
  });

  it('Forget really deletes, but only after a confirmation', async () => {
    const calls = stubApi('owner', [...base(), ['DELETE /api/ceo/memories/', () => null]]);
    renderCeoPage('?tab=memory');
    const row = (await screen.findAllByTestId('ceo-memory-row'))[0] as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Forget' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Forget this for good?');
    expect(dialog).toHaveTextContent('rule 1');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Forget' }));
    await waitFor(() => {
      const del = calls.find((c) => c.method === 'DELETE');
      expect(del?.url).toBe(`/api/ceo/memories/${U(71)}`);
    });
  });

  it('adds a rule by hand', async () => {
    const calls = stubApi('owner', base());
    renderCeoPage('?tab=memory');
    const form = await screen.findByRole('form', { name: 'Add a rule' });
    await userEvent.type(within(form).getByRole('textbox'), 'Never merge on Fridays');
    await userEvent.click(within(form).getByRole('button', { name: 'Remember this' }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url === '/api/ceo/memories');
      expect(post?.body).toEqual({ text: 'Never merge on Fridays', scope: 'org' });
    });
  });

  it('shows an Admin only that memories exist', async () => {
    stubApi('admin', [
      ['GET /api/ceo/status', () => ceoStatus({ isOwner: false })],
      [
        'GET /api/ceo/memories',
        () => ({ memories: list().map((m) => ({ ...m, text: '', quote: '' })), canView: false }),
      ],
    ]);
    renderCeoPage('?tab=memory');
    expect(await screen.findByTestId('ceo-memory-hidden')).toHaveTextContent(
      '4 memories exist; only the Owner can read them.',
    );
    expect(screen.queryByRole('button', { name: 'Keep' })).toBeNull();
  });
});
