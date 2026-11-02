import {
  FIELD_TYPE_META,
  FORM_FIELD_TYPES,
  type FormDefinition,
  type FormDto,
  newFormDefinition,
  newFormField,
} from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { FormBuilderPage } from '../pages/FormBuilderPage.tsx';

const F1 = '0192f3a0-0000-7000-8000-0000000000a1';
const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let role = 'owner';
let calls: Array<{ method: string; url: string; body: any }>;
let server: Map<number, FormDefinition>;
let putStatus = 200;

const dto = (): FormDto => {
  const latest = Math.max(...server.keys());
  return {
    id: F1,
    status: 'active',
    latestVersion: latest,
    definition: server.get(latest) as FormDefinition,
    versions: [...server.keys()].sort((a, b) => b - a).map((v) => ({ version: v, savedAt: '2026-11-02T10:00:00.000Z', savedByName: 'Pieter' })),
  };
};

beforeEach(() => {
  role = 'owner';
  putStatus = 200;
  calls = [];
  server = new Map();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      if (method !== 'GET') calls.push({ method, url, body });
      if (url.startsWith('/api/auth/me'))
        return json({
          user: { id: 'u1', displayName: 'Pieter', email: 'p@x.test' },
          isAdmin: role === 'owner',
          visibleProjectIds: [],
          activeOrg: { id: 'o1', name: 'Acme', role, status: 'active', plan: 'team', planName: 'Team', features: {} },
        });
      if (url === '/api/org/storage/connections') return json({ error: { code: 'not_found', message: 'nope' } }, 404);
      if (url === '/api/forms' && method === 'POST') {
        server.set(1, body.definition);
        return json(dto(), 201);
      }
      const ver = /^\/api\/forms\/[^/]+\/versions\/(\d+)$/.exec(url);
      if (ver) {
        const d = server.get(Number(ver[1]));
        return d
          ? json({ formId: F1, version: Number(ver[1]), definition: d, savedAt: '2026-11-02T10:00:00.000Z', savedByName: 'Pieter' })
          : json({ error: { code: 'not_found', message: 'no' } }, 404);
      }
      if (url === `/api/forms/${F1}` && method === 'GET') return json(dto());
      if (url === `/api/forms/${F1}` && method === 'PUT') {
        if (putStatus === 409)
          return json({ error: { code: 'form_version_conflict', message: 'This form was changed by someone else. Reload to see version 2.' } }, 409);
        const next = Math.max(...server.keys()) + 1;
        server.set(next, body.definition);
        return json({ form: dto(), created: true });
      }
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function mount(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/forms/:id" element={<FormBuilderPage />} />
            <Route path="/forms" element={<p>list</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const dataTransfer = () => {
  const data: Record<string, string> = {};
  return {
    data,
    effectAllowed: '',
    dropEffect: '',
    setData: (k: string, v: string) => {
      data[k] = v;
    },
    getData: (k: string) => data[k] ?? '',
  };
};
const dragPaletteTo = (type: string, target: HTMLElement) => {
  const dt = dataTransfer();
  fireEvent.dragStart(screen.getByTestId(`palette-${type}`), { dataTransfer: dt });
  fireEvent.dragOver(target, { dataTransfer: dt });
  fireEvent.drop(target, { dataTransfer: dt });
};
const labels = () =>
  screen
    .queryAllByTestId(/^select-field-\d+$/)
    .map((b) => b.textContent?.replace(/\s+/g, ' ').replace(/ required$/, '').trim() ?? '');

const seed = (...fields: ReturnType<typeof newFormField>[]) => {
  server.set(1, { ...newFormDefinition('Rental application'), fields });
};

describe('forms builder: drag and drop, reorder and save', () => {
  it('adds each of the ten field types by drag and drop, reorders them, saves, and reopens in the same order', async () => {
    const user = userEvent.setup();
    mount('/forms/new');
    await screen.findByTestId('field-palette');
    dragPaletteTo(FORM_FIELD_TYPES[0] as string, screen.getByTestId('canvas-empty'));
    for (const t of FORM_FIELD_TYPES.slice(1)) dragPaletteTo(t, screen.getByTestId('canvas-end'));
    const names = FORM_FIELD_TYPES.map((t) => FIELD_TYPE_META[t].label);
    await waitFor(() => expect(labels()).toHaveLength(10));
    expect(labels().map((l, i) => l.startsWith(names[i] as string))).toEqual(Array(10).fill(true));

    // reorder: the grip answers the arrow keys, the buttons work too
    const grip = screen.getByRole('button', { name: /^Move Short text\. Use/ });
    grip.focus();
    await user.keyboard('{ArrowDown}');
    expect(labels()[1]).toMatch(/^Short text/);
    expect(labels()[0]).toMatch(/^Long text/);
    await user.click(screen.getByRole('button', { name: 'Move Short text up' }));
    expect(labels()[0]).toMatch(/^Short text/);
    expect(screen.getByTestId('canvas-announce')).toHaveTextContent(/Short text moved to position 1 of 10/);
    // drag a card onto another card
    const dt = dataTransfer();
    fireEvent.dragStart(screen.getByTestId('canvas-field-0'), { dataTransfer: dt });
    fireEvent.dragOver(screen.getByTestId('canvas-field-2'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('canvas-field-2'), { dataTransfer: dt });
    expect(labels()[2]).toMatch(/^Short text/);
    // and back to the top with Home
    screen.getByRole('button', { name: /^Move Short text\. Use/ }).focus();
    await user.keyboard('{Home}');
    expect(labels()[0]).toMatch(/^Short text/);
    const order = labels();

    await user.click(screen.getByTestId('save-form'));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toBeDefined());
    const sent = calls.find((c) => c.method === 'POST')?.body.definition as FormDefinition;
    expect(sent.fields.map((f) => f.type)).toEqual(
      order.map((l) => FORM_FIELD_TYPES.find((t) => l.startsWith(FIELD_TYPE_META[t].label)) as string),
    );
    expect(sent.fields).toHaveLength(10);

    // the page moved to the saved form and shows the same fields in the same order
    await waitFor(() => expect(screen.getByTestId('form-version')).toHaveTextContent('Version 1'));
    expect(labels()).toEqual(order);
  });

  it('adds a field with a click (the tap and Enter path) after the selected field', async () => {
    const user = userEvent.setup();
    mount('/forms/new');
    await screen.findByTestId('field-palette');
    await user.click(screen.getByTestId('palette-email'));
    await user.click(screen.getByTestId('palette-phone'));
    await user.click(screen.getByTestId('select-field-0'));
    await user.click(screen.getByTestId('palette-number'));
    expect(
      labels().map((l) => FORM_FIELD_TYPES.find((t) => l.startsWith(FIELD_TYPE_META[t].label))),
    ).toEqual(['email', 'number', 'phone']);
  });

  it('duplicates and deletes a field', async () => {
    const user = userEvent.setup();
    mount('/forms/new');
    await screen.findByTestId('field-palette');
    await user.click(screen.getByTestId('palette-email'));
    await user.click(screen.getByRole('button', { name: 'Duplicate Email' }));
    expect(labels()[1]).toMatch(/^Email \(copy\)/);
    await user.click(screen.getByRole('button', { name: 'Delete Email (copy)' }));
    expect(labels()).toHaveLength(1);
  });
});

describe('forms builder: properties and preview', () => {
  it('honours label, required, placeholder, help text, options and upload settings in the preview and in the save', async () => {
    const user = userEvent.setup();
    seed(
      { ...newFormField('short_text', 'f_name0001'), label: 'Name' },
      { ...newFormField('radio', 'f_pets0001'), label: 'Pets' },
      { ...newFormField('file', 'f_id000001'), label: 'ID copy' },
    );
    mount(`/forms/${F1}`);
    await screen.findByTestId('canvas-field-0');

    await user.click(screen.getByTestId('select-field-0'));
    const label = screen.getByLabelText('Label');
    await user.clear(label);
    await user.type(label, 'Full name');
    await user.click(screen.getByLabelText('Required'));
    await user.type(screen.getByLabelText('Placeholder'), 'Jane Doe');
    await user.type(screen.getByLabelText('Help text'), 'As on your ID');

    await user.click(screen.getByTestId('select-field-1'));
    const options = screen.getByLabelText('Options');
    await user.clear(options);
    await user.type(options, 'Cat{Enter}Dog');

    await user.click(screen.getByTestId('select-field-2'));
    const size = screen.getByLabelText('Size limit (MB)');
    await user.clear(size);
    await user.type(size, '2');
    await user.click(screen.getByLabelText('Images (jpg, jpeg, png, heic)'));
    const folder = screen.getByLabelText('Folder');
    await user.clear(folder);
    await user.type(folder, 'IDs/{{form}');
    const name = screen.getByLabelText('File name');
    await user.clear(name);
    await user.type(name, '{{original}');

    await user.click(screen.getByTestId('tab-preview'));
    const nameInput = screen.getByLabelText(/Full name/);
    expect(nameInput).toHaveAttribute('placeholder', 'Jane Doe');
    expect(nameInput).toHaveAttribute('aria-required', 'true');
    expect(screen.getByText('As on your ID')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Dog' })).toBeInTheDocument();
    expect(screen.getByLabelText('ID copy')).toHaveAttribute('accept', expect.stringContaining('.pdf'));
    expect(screen.getByTestId('file-help-f_id000001')).toHaveTextContent('Up to 2 MB');
    // the shared validation shows in the preview
    await user.click(screen.getByTestId('form-submit'));
    expect(screen.getByTestId('error-f_name0001')).toHaveTextContent('This field is required.');

    await user.click(screen.getByTestId('tab-build'));
    await user.click(screen.getByTestId('save-form'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeDefined());
    const put = calls.find((c) => c.method === 'PUT')?.body;
    expect(put.baseVersion).toBe(1);
    const [f0, f1, f2] = put.definition.fields;
    expect(f0).toMatchObject({ label: 'Full name', required: true, placeholder: 'Jane Doe', helpText: 'As on your ID' });
    expect(f1.options).toEqual(['Cat', 'Dog']);
    expect(f2.maxSizeBytes).toBe(2 * 1024 * 1024);
    expect(f2.destination).toMatchObject({ folder: 'IDs/{form}', name: '{original}' });
    expect(f2.allowedTypes).not.toContain('.heic');
  });

  it('shows the logo at the top of the preview', async () => {
    const id = '0192f3a0-0000-7000-8000-0000000000b1';
    const d = { ...newFormDefinition('Rental application'), fields: [] } as FormDefinition;
    d.settings.logo = { imageId: id, alt: 'Acme' };
    server.set(1, d);
    const user = userEvent.setup();
    mount(`/forms/${F1}`);
    await screen.findByTestId('form-canvas');
    await user.click(screen.getByTestId('tab-preview'));
    const logo = await screen.findByTestId('form-logo');
    expect(logo).toHaveAttribute('src', `/api/forms/logos/${id}`);
    expect(screen.getByTestId('form-renderer').querySelector('header')?.firstElementChild).toBe(logo);
  });

  it('disables Save for an invalid definition', async () => {
    const user = userEvent.setup();
    seed({ ...newFormField('number', 'f_num00001'), label: 'Rooms' });
    mount(`/forms/${F1}`);
    await user.click(await screen.findByTestId('select-field-0'));
    await user.type(screen.getByLabelText('Minimum value'), '9');
    await user.type(screen.getByLabelText('Maximum value'), '3');
    expect(screen.getByTestId('save-form')).toBeDisabled();
    expect(screen.getByText('The minimum is larger than the maximum.')).toBeInTheDocument();
  });
});

describe('forms builder: versions and roles', () => {
  it('opens an earlier version read-only with a banner', async () => {
    server.set(1, { ...newFormDefinition('Old title'), fields: [{ ...newFormField('email', 'f_mail0001'), label: 'Old email' }] });
    server.set(2, { ...newFormDefinition('New title'), fields: [] });
    mount(`/forms/${F1}?version=1`);
    expect(await screen.findByTestId('version-banner')).toHaveTextContent('You are looking at version 1. The latest is version 2.');
    expect(await screen.findByText('Old email')).toBeInTheDocument();
    expect(screen.queryByTestId('save-form')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Move Old email up/ })).toBeNull();
  });

  it('tells the editor to reload when someone else saved (409)', async () => {
    const user = userEvent.setup();
    seed({ ...newFormField('email', 'f_mail0001'), label: 'Email' });
    mount(`/forms/${F1}`);
    await user.click(await screen.findByRole('button', { name: 'Duplicate Email' }));
    putStatus = 409;
    await user.click(screen.getByTestId('save-form'));
    expect(await screen.findByText(/changed by someone else/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('lets a member look at the form but not change it', async () => {
    role = 'member';
    seed({ ...newFormField('email', 'f_mail0001'), label: 'Email' });
    mount(`/forms/${F1}`);
    await screen.findByTestId('canvas-field-0');
    await waitFor(() => expect(screen.getByText(/Only Owners and Admins can change forms/)).toBeInTheDocument());
    expect(screen.queryByTestId('save-form')).toBeNull();
    expect(within(screen.getByTestId('field-palette')).getByTestId('palette-email')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
  });

  it('warns before leaving with unsaved changes', async () => {
    const user = userEvent.setup();
    mount('/forms/new');
    await screen.findByTestId('field-palette');
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    await user.click(screen.getByTestId('palette-email'));
    const ev2 = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(true);
  });
});
