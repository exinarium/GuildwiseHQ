import { RELAY_KINDS } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayTab } from '../components/orgsettings/RelayTab.tsx';
import { ToastProvider } from '../components/ui.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const URL1 = 'https://aom.test/relay/in/rly_TESTTOKENTESTTOKENTESTTOKEN12345';

type Row = Record<string, any>;
let integrations: Row[];
let statuses: Row[];
let sent: { url: string; method: string; body: unknown }[];
let n: number;
const dto = (id: string, kind: string, label: string, status = 'active'): Row => ({
  id,
  orgId: ID(1),
  kind,
  label,
  status,
  createdAt: '2026-10-30T10:00:00.000Z',
  rotatedAt: null,
  revokedAt: status === 'revoked' ? '2026-10-31T10:00:00.000Z' : null,
});
const live = (id: string, over: Row = {}): Row => ({
  integrationId: id,
  connected: true,
  servingWorkstations: 1,
  everServed: true,
  offlineSince: null,
  refusedSinceOffline: { count: 0, lastAt: null },
  lastEvent: null,
  ...over,
});

beforeEach(() => {
  sent = [];
  n = 100;
  integrations = [];
  statuses = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method !== 'GET') sent.push({ url, method, body });
      if (url === '/api/relay/integrations' && method === 'GET') return json({ integrations });
      if (url === '/api/relay/integrations/status') return json({ statuses });
      if (url === '/api/relay/integrations' && method === 'POST') {
        const row = dto(ID(++n), body.kind, body.label);
        integrations.push(row);
        statuses.push(live(row.id));
        return json({ integration: row, url: URL1 }, 201);
      }
      const rot = url.match(/\/api\/relay\/integrations\/(.+)\/rotate$/);
      if (rot) {
        const row = integrations.find((i) => i.id === rot[1]) as Row;
        row.rotatedAt = '2026-10-31T11:00:00.000Z';
        return json({ integration: row, url: `${URL1}ROTATED` });
      }
      const rev = url.match(/\/api\/relay\/integrations\/(.+)\/revoke$/);
      if (rev) {
        const row = integrations.find((i) => i.id === rev[1]) as Row;
        row.status = 'revoked';
        row.revokedAt = '2026-10-31T11:00:00.000Z';
        statuses = statuses.filter((s) => s.integrationId !== row.id);
        return json({ integration: row });
      }
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderTab(canManage: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <RelayTab canManage={canManage} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('the inbound webhooks list', () => {
  it('shows each status, the runner column and the last event as metadata', async () => {
    integrations = [
      dto(ID(10), 'whatsapp_cloud', 'Shop'),
      dto(ID(11), 'generic', 'Forms'),
      dto(ID(12), 'form_webhook', 'Old', 'revoked'),
    ];
    statuses = [
      live(ID(10), {
        lastEvent: { at: new Date().toISOString(), outcome: 'forwarded', status: 200, sizeBytes: 1300 },
      }),
      live(ID(11), { connected: false, servingWorkstations: 0, offlineSince: '2026-10-31T09:00:00.000Z' }),
    ];
    renderTab(true);
    const shop = await screen.findByTestId(`relay-row-${ID(10)}`);
    expect(shop).toHaveTextContent('Active · runner connected');
    expect(screen.getByTestId(`relay-runner-${ID(10)}`)).toHaveTextContent('yes');
    expect(screen.getByTestId(`relay-last-${ID(10)}`)).toHaveTextContent('forwarded · 200 · 1.3 KB');
    const forms = screen.getByTestId(`relay-row-${ID(11)}`);
    expect(forms).toHaveTextContent('Active · runner offline');
    expect(screen.getByTestId(`relay-runner-${ID(11)}`)).toHaveTextContent('no');
    expect(screen.getByTestId(`relay-last-${ID(11)}`)).toHaveTextContent('No requests yet');
    const old = screen.getByTestId(`relay-row-${ID(12)}`);
    expect(old).toHaveTextContent('Revoked');
    expect(within(old).queryByText('Rotate address')).toBeNull();
    expect(screen.queryByTestId('relay-offline-banner')).toBeNull();
  });

  it('is read-only for a member: no create, rotate or revoke', async () => {
    integrations = [dto(ID(10), 'generic', 'Forms')];
    statuses = [live(ID(10))];
    renderTab(false);
    await screen.findByTestId(`relay-row-${ID(10)}`);
    expect(screen.queryByTestId('relay-new')).toBeNull();
    expect(screen.queryByTestId(`relay-rotate-${ID(10)}`)).toBeNull();
    expect(screen.queryByTestId(`relay-revoke-${ID(10)}`)).toBeNull();
  });

  it('shows an empty state with the create button for a manager', async () => {
    renderTab(true);
    expect(await screen.findByText('No inbound webhooks yet')).toBeInTheDocument();
    expect(screen.getByTestId('relay-new')).toBeInTheDocument();
  });
});

describe('creating, rotating and revoking', () => {
  it.each(RELAY_KINDS)(
    'creates a %s webhook: body is exactly kind and label, the address shows once with copy',
    async (kind) => {
      const user = userEvent.setup();
      const copy = vi.spyOn(navigator.clipboard, 'writeText');
      renderTab(true);
      await user.click(await screen.findByTestId('relay-new'));
      await user.selectOptions(screen.getByLabelText('Kind'), kind);
      await user.type(screen.getByLabelText('Label'), 'My hook');
      await user.click(screen.getByTestId('relay-create-submit'));
      expect(await screen.findByTestId('relay-url')).toHaveTextContent(URL1);
      expect(sent.at(-1)).toEqual({
        url: '/api/relay/integrations',
        method: 'POST',
        body: { kind, label: 'My hook' },
      });
      await user.click(screen.getByTestId('relay-url-copy'));
      expect(copy).toHaveBeenCalledWith(URL1);
      // every kind gets the serve command; WhatsApp also the runner command for the secrets
      const id = (integrations.at(-1) as Row).id;
      const dialog = within(screen.getByRole('dialog'));
      expect(dialog.getByTestId('relay-serve-command')).toHaveTextContent(
        `guildwise-runner relay add ${id} --kind ${kind}`,
      );
      if (kind === 'whatsapp_cloud')
        expect(dialog.getByTestId('relay-whatsapp-command')).toHaveTextContent(
          `guildwise-runner whatsapp-connect ${id}`,
        );
      else expect(dialog.queryByTestId('relay-whatsapp-command')).toBeNull();
      // closing removes the address from the page for good, and the list has the new row
      await user.click(screen.getByTestId('relay-url-done'));
      await waitFor(() => expect(screen.queryByTestId('relay-url')).toBeNull());
      expect(document.body.textContent).not.toContain('TESTTOKEN');
      expect(await screen.findByTestId(`relay-row-${id}`)).toBeInTheDocument();
    },
  );

  it('rotates after confirmation and shows the new address once', async () => {
    integrations = [dto(ID(10), 'generic', 'Forms')];
    statuses = [live(ID(10))];
    const user = userEvent.setup();
    renderTab(true);
    await user.click(await screen.findByTestId(`relay-rotate-${ID(10)}`));
    expect(screen.getByText(/The old address stops working at once/)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Rotate address' }).at(-1) as HTMLElement);
    expect(await screen.findByTestId('relay-url')).toHaveTextContent('ROTATED');
    expect(sent.at(-1)).toMatchObject({ url: `/api/relay/integrations/${ID(10)}/rotate`, method: 'POST' });
    await user.click(screen.getByTestId('relay-url-done'));
    await waitFor(() => expect(screen.queryByTestId('relay-url')).toBeNull());
    expect(document.body.textContent).not.toContain('ROTATED');
  });

  it('revokes after confirmation and the row shows Revoked', async () => {
    integrations = [dto(ID(10), 'generic', 'Forms')];
    statuses = [live(ID(10))];
    const user = userEvent.setup();
    renderTab(true);
    await user.click(await screen.findByTestId(`relay-revoke-${ID(10)}`));
    expect(screen.getByText(/This cannot be undone/)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Revoke' }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByTestId(`relay-row-${ID(10)}`)).toHaveTextContent('Revoked'));
    expect(sent.at(-1)).toMatchObject({ url: `/api/relay/integrations/${ID(10)}/revoke`, method: 'POST' });
  });
});

describe('no provider secret anywhere', () => {
  it('has only the kind and the label as inputs, and no request carries a secret field', async () => {
    integrations = [dto(ID(10), 'whatsapp_cloud', 'Shop')];
    statuses = [live(ID(10))];
    const user = userEvent.setup();
    renderTab(true);
    await user.click(await screen.findByTestId('relay-new'));
    const fields = Array.from(document.querySelectorAll('input, textarea, select'));
    expect(fields.map((f) => f.tagName.toLowerCase()).sort()).toEqual(['input', 'select']);
    expect(document.querySelector('input[type=password]')).toBeNull();
    for (const f of fields) {
      const label = document.querySelector(`label[for="${f.id}"]`)?.textContent ?? '';
      expect(`${label} ${f.getAttribute('name') ?? ''}`).not.toMatch(/secret|token|verify|access/i);
    }
    await user.type(screen.getByLabelText('Label'), 'x');
    await user.click(screen.getByTestId('relay-create-submit'));
    await screen.findByTestId('relay-url');
    for (const s of sent) expect(JSON.stringify(s.body)).not.toMatch(/secret|token/i);
  });

  it('points the WhatsApp setup steps at the runner command', async () => {
    integrations = [dto(ID(10), 'whatsapp_cloud', 'Shop')];
    statuses = [live(ID(10))];
    renderTab(false);
    await screen.findByTestId(`relay-row-${ID(10)}`);
    expect(screen.getByTestId('relay-whatsapp-command')).toHaveTextContent(
      `guildwise-runner whatsapp-connect ${ID(10)}`,
    );
    expect(screen.getByTestId('relay-setup-steps')).toHaveTextContent('never here');
  });
});
