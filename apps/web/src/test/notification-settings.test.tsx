import { defaultPushPreferences, type MeResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateToast } from '../components/pwa/UpdateToast.tsx';
import { NotificationSettings } from '../components/settings/NotificationSettings.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { applyUpdate, useUpdateAvailable } from '../lib/pwa.ts';

const json = (b: unknown, status = 200) =>
  new Response(b === undefined ? null : JSON.stringify(b), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const me = (orgs = 1) =>
  ({
    user: {
      id: 'u1',
      email: 'a@b.test',
      displayName: 'A',
      kind: 'user',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: null,
      timezone: 'UTC',
    },
    account: { kind: 'user' },
    isAdmin: false,
    orgs: Array.from({ length: orgs }, (_, i) => ({
      id: `o${i}`,
      name: `Org ${i}`,
      role: 'member',
      status: 'active',
    })),
    activeOrg: {
      id: 'o0',
      name: 'Org 0',
      role: 'member',
      status: 'active',
      features: {},
      banners: [],
      gate: null,
    },
    guestIn: [],
    guestProjectIds: [],
    visibleProjectIds: [],
    pendingInvitations: 0,
    mustChangePassword: false,
    twoFactor: { enabled: false, required: false, setupRequired: false },
    features: { mockUi: false },
  }) as unknown as MeResponse;

interface Call {
  method: string;
  url: string;
  body?: any;
}
let calls: Call[];
let config: { enabled: boolean; publicKey?: string };
let devices: Array<Record<string, unknown>>;
let orgs = 1;

const device = (over: Record<string, unknown> = {}) => ({
  id: '0192f3a0-0000-7000-8000-0000000000a1',
  label: 'iPhone Safari',
  endpoint: 'https://push.example.com/abc',
  createdAt: '2026-10-01T10:00:00.000Z',
  lastSuccessAt: null,
  lastFailureAt: null,
  failureCount: 0,
  ...over,
});

beforeEach(() => {
  calls = [];
  config = { enabled: true, publicKey: 'BAAA' };
  devices = [];
  orgs = 1;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url === '/api/auth/me') return json(me(orgs));
      if (url === '/api/push/config') return json(config);
      if (url === '/api/push/subscriptions' && method === 'GET') return json({ devices });
      if (url === '/api/push/subscriptions' && method === 'POST') {
        devices = [
          device({ id: '0192f3a0-0000-7000-8000-0000000000b2', endpoint: 'https://push.example.com/new' }),
        ];
        return json({ id: 'x' }, 201);
      }
      if (url.startsWith('/api/push/subscriptions/') && method === 'DELETE') {
        devices = [];
        return new Response(null, { status: 204 });
      }
      if (url === '/api/push/preferences' && method === 'GET') return json(defaultPushPreferences());
      if (url === '/api/push/preferences' && method === 'PUT') {
        const b = JSON.parse(String(init.body));
        const base = defaultPushPreferences();
        return json({
          categories: { ...base.categories, ...b.categories },
          quietHours: b.quietHours ?? base.quietHours,
        });
      }
      if (url === '/api/push/test') return json({ sent: devices.length, failed: 0 });
      return json({});
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubBrowser(opts: {
  push?: boolean;
  permission?: NotificationPermission;
  ua?: string;
  standalone?: boolean;
  subscribed?: boolean;
}) {
  const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
  if (opts.ua) vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(opts.ua);
  if (opts.standalone !== undefined) {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) =>
      q.includes('display-mode: standalone')
        ? { ...mm(q), matches: opts.standalone as boolean }
        : mm(q)) as typeof window.matchMedia;
  }
  if (opts.push) {
    const sub = {
      endpoint: 'https://push.example.com/new',
      toJSON: () => ({ endpoint: 'https://push.example.com/new', keys: { p256dh: 'P', auth: 'A' } }),
      unsubscribe: vi.fn(async () => true),
    };
    const reg = {
      pushManager: {
        getSubscription: vi.fn(async () =>
          opts.subscribed ? { ...sub, endpoint: 'https://push.example.com/abc' } : null,
        ),
        subscribe: vi.fn(async () => sub),
      },
    };
    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal(
      'Notification',
      Object.assign(function N() {}, { permission: opts.permission ?? 'default', requestPermission }),
    );
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: vi.fn(async () => reg), addEventListener: () => undefined },
    });
    return { requestPermission, reg, sub };
  }
  return { requestPermission };
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <NotificationSettings />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

describe('what the section says before a device can be enabled', () => {
  it('explains that push is not set up when the server has no keys', async () => {
    config = { enabled: false };
    mount();
    expect(await screen.findByTestId('push-disabled')).toBeInTheDocument();
    expect(screen.queryByTestId('push-enable')).not.toBeInTheDocument();
  });

  it('tells an iPhone in Safari to Add to Home Screen first', async () => {
    stubBrowser({ ua: IPHONE, standalone: false });
    mount();
    const hint = await screen.findByTestId('push-ios-hint');
    expect(hint).toHaveTextContent(/Add to Home Screen/);
    expect(hint).toHaveTextContent(/Share/);
    expect(screen.queryByTestId('push-enable')).not.toBeInTheDocument();
  });

  it('offers the button once the iPhone app is installed', async () => {
    stubBrowser({ ua: IPHONE, standalone: true, push: true });
    mount();
    expect(await screen.findByTestId('push-enable')).toBeInTheDocument();
    expect(screen.queryByTestId('push-ios-hint')).not.toBeInTheDocument();
  });

  it('says so in a browser without push support', async () => {
    mount();
    expect(await screen.findByTestId('push-unsupported')).toBeInTheDocument();
  });

  it('explains a blocked permission', async () => {
    stubBrowser({ push: true, permission: 'denied' });
    mount();
    expect(await screen.findByTestId('push-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('push-enable')).not.toBeInTheDocument();
  });
});

describe('enabling this device', () => {
  it('asks for permission only when the button is tapped, then registers the subscription', async () => {
    const user = userEvent.setup();
    const { requestPermission, reg } = stubBrowser({ push: true });
    mount();
    const button = await screen.findByTestId('push-enable');
    expect(requestPermission).not.toHaveBeenCalled();
    await user.click(button);
    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    expect(reg?.pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.url === '/api/push/subscriptions')?.body).toEqual({
        endpoint: 'https://push.example.com/new',
        keys: { p256dh: 'P', auth: 'A' },
      }),
    );
  });

  it('shows the error when the permission is refused', async () => {
    const user = userEvent.setup();
    const { requestPermission } = stubBrowser({ push: true });
    requestPermission.mockResolvedValue('denied');
    mount();
    await user.click(await screen.findByTestId('push-enable'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not allowed/i);
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/push/subscriptions')).toBe(false);
  });
});

describe('devices, test and preferences', () => {
  it('lists devices, marks this one and removes one', async () => {
    const user = userEvent.setup();
    devices = [device()];
    stubBrowser({ push: true, subscribed: true });
    mount();
    const list = await screen.findByTestId('push-devices');
    expect(list).toHaveTextContent('iPhone Safari');
    expect(list).toHaveTextContent('(this device)');
    expect(await screen.findByTestId('push-this-device-on')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove iPhone Safari' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/0192f3a0-0000-7000-8000-0000000000a1')),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByTestId('push-devices')).not.toBeInTheDocument());
  });

  it('sends a test notification, disabled without a device', async () => {
    const user = userEvent.setup();
    stubBrowser({ push: true });
    mount();
    expect(await screen.findByTestId('push-test')).toBeDisabled();
  });

  it('sends the test to the devices', async () => {
    const user = userEvent.setup();
    devices = [device()];
    stubBrowser({ push: true });
    mount();
    const button = await screen.findByTestId('push-test');
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/push/test')).toBe(true),
    );
  });

  it('shows the categories with chat replies off and saves a toggle', async () => {
    const user = userEvent.setup();
    stubBrowser({ push: true });
    mount();
    expect(await screen.findByTestId('push-cat-desk_blocking')).toBeChecked();
    expect(screen.getByTestId('push-cat-chat_replies')).not.toBeChecked();
    await user.click(screen.getByTestId('push-cat-chat_replies'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT' && c.url === '/api/push/preferences')?.body).toEqual({
        categories: { chat_replies: true },
        allOrgs: true,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('push-cat-chat_replies')).toBeChecked());
  });

  it('saves quiet hours and shows the times once switched on', async () => {
    const user = userEvent.setup();
    stubBrowser({ push: true });
    mount();
    expect(screen.queryByTestId('push-quiet-start')).not.toBeInTheDocument();
    await user.click(await screen.findByTestId('push-quiet-enabled'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        quietHours: { enabled: true, start: '22:00', end: '07:00' },
        allOrgs: true,
      }),
    );
    expect(await screen.findByTestId('push-quiet-start')).toHaveValue('22:00');
    expect(screen.getByTestId('push-quiet-end')).toHaveValue('07:00');
  });

  it('lets a member of several organizations keep the choices to one organization', async () => {
    const user = userEvent.setup();
    orgs = 2;
    stubBrowser({ push: true });
    mount();
    const all = await screen.findByTestId('push-all-orgs');
    expect(all).toBeChecked();
    await user.click(all);
    await user.click(screen.getByTestId('push-cat-chat_replies'));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        categories: { chat_replies: true },
        allOrgs: false,
      }),
    );
  });
});

describe('the update toast', () => {
  it('is hidden until a new service worker waits', () => {
    function Probe() {
      return <p data-testid="avail">{String(useUpdateAvailable())}</p>;
    }
    render(
      <>
        <Probe />
        <UpdateToast />
      </>,
    );
    expect(screen.getByTestId('avail')).toHaveTextContent('false');
    expect(screen.queryByTestId('update-toast')).not.toBeInTheDocument();
    expect(() => applyUpdate()).not.toThrow();
  });
});
