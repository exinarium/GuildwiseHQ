import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushPrompt } from '../components/push/PushPrompt.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { resetPromptSession, SNOOZE_MS } from '../lib/pushPrompt.ts';

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const ME = {
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
  orgs: [],
  activeOrg: null,
  guestIn: [],
  guestProjectIds: [],
  visibleProjectIds: [],
  pendingInvitations: 0,
  mustChangePassword: false,
  twoFactor: { enabled: false, required: false, setupRequired: false },
  features: { mockUi: false },
};

let config: { enabled: boolean; publicKey?: string };
let posts: Array<{ url: string; body: any }>;
let signedIn: boolean;

function stub(opts: {
  permission?: NotificationPermission;
  subscribed?: boolean;
  ua?: string;
  standalone?: boolean;
  push?: boolean;
}) {
  const order: string[] = [];
  const requestPermission = vi.fn(async () => {
    order.push('permission');
    return 'granted' as NotificationPermission;
  });
  if (opts.ua) vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(opts.ua);
  if (opts.standalone !== undefined) {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) =>
      q.includes('display-mode: standalone')
        ? { ...mm(q), matches: opts.standalone as boolean }
        : mm(q)) as typeof window.matchMedia;
  }
  if (opts.push !== false) {
    const sub = {
      endpoint: 'https://push.example.com/new',
      toJSON: () => ({ endpoint: 'https://push.example.com/new', keys: { p256dh: 'P', auth: 'A' } }),
    };
    const reg = {
      pushManager: {
        getSubscription: vi.fn(async () => (opts.subscribed ? sub : null)),
        subscribe: vi.fn(async () => {
          order.push('subscribe');
          return sub;
        }),
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
    return { requestPermission, reg, order };
  }
  return { requestPermission, order };
}

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <PushPrompt />
      </ToastProvider>
    </QueryClientProvider>,
  );
  // Let the queries and the endpoint lookup settle, then pass the show delay.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3500);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  resetPromptSession();
  config = { enabled: true, publicKey: 'BAAA' };
  posts = [];
  signedIn = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/auth/me') return signedIn ? json(ME) : json({ error: 'no' }, 401);
      if (url === '/api/push/config') return json(config);
      if (url === '/api/push/subscriptions' && init.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return json({ id: 'x' }, 201);
      }
      return json({});
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('when the prompt shows', () => {
  it('asks on a desktop browser that has not decided yet', async () => {
    stub({});
    await mount();
    expect(screen.getByTestId('push-prompt')).toHaveTextContent('Turn on notifications');
    expect(screen.queryByTestId('push-ios-card')).not.toBeInTheDocument();
  });

  it.each([['granted'], ['denied']] as const)('stays away when permission is %s', async (permission) => {
    stub({ permission });
    await mount();
    expect(screen.queryByTestId('push-prompt')).not.toBeInTheDocument();
  });

  it('stays away when the server has no push keys', async () => {
    config = { enabled: false };
    stub({});
    await mount();
    expect(screen.queryByTestId('push-prompt')).not.toBeInTheDocument();
  });

  it('stays away when this device is already subscribed', async () => {
    stub({ subscribed: true });
    await mount();
    expect(screen.queryByTestId('push-prompt')).not.toBeInTheDocument();
  });

  it('stays away when the browser has no push support', async () => {
    stub({ push: false });
    await mount();
    expect(screen.queryByTestId('push-prompt')).not.toBeInTheDocument();
  });

  it('stays away when signed out', async () => {
    signedIn = false;
    stub({});
    await mount();
    expect(screen.queryByTestId('push-prompt')).not.toBeInTheDocument();
  });

  it('stays away over an open dialog and appears once it closes', async () => {
    stub({});
    const d = document.createElement('div');
    d.setAttribute('role', 'dialog');
    document.body.appendChild(d);
    await mount();
    expect(screen.queryByTestId('push-prompt')).not.toBeInTheDocument();
    d.remove();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByTestId('push-prompt')).toBeInTheDocument();
  });

  it('stays away for 7 days after Not now, then returns', async () => {
    stub({});
    localStorage.setItem('guildwise-push-prompt', JSON.stringify({ until: Date.now() + SNOOZE_MS - 1000 }));
    await mount();
    expect(screen.queryByTestId('push-prompt')).not.toBeInTheDocument();
  });

  it('comes back once the snooze has expired', async () => {
    stub({});
    localStorage.setItem('guildwise-push-prompt', JSON.stringify({ until: Date.now() - 1000 }));
    await mount();
    expect(screen.getByTestId('push-prompt')).toBeInTheDocument();
  });

  it('never returns after Do not ask again', async () => {
    stub({});
    localStorage.setItem('guildwise-push-prompt', JSON.stringify({ never: true }));
    await mount();
    expect(screen.queryByTestId('push-prompt')).not.toBeInTheDocument();
  });
});

describe('iPhone and iPad', () => {
  it('shows the Add to Home Screen hint in Safari, once', async () => {
    stub({ ua: IPHONE, standalone: false, push: false });
    await mount();
    const card = screen.getByTestId('push-ios-card');
    expect(card).toHaveTextContent('Add Guildwise to your Home Screen to get notifications');
    expect(card).toHaveTextContent(/Share/);
    expect(screen.queryByTestId('push-prompt-on')).not.toBeInTheDocument();
    await userEvent
      .setup({ advanceTimers: vi.advanceTimersByTime })
      .click(screen.getByTestId('push-ios-dismiss'));
    expect(screen.queryByTestId('push-ios-card')).not.toBeInTheDocument();
    expect(localStorage.getItem('guildwise-push-ios-hint')).not.toBeNull();
  });

  it('does not repeat the hint once dismissed', async () => {
    localStorage.setItem('guildwise-push-ios-hint', JSON.stringify({ never: true }));
    stub({ ua: IPHONE, standalone: false, push: false });
    await mount();
    expect(screen.queryByTestId('push-ios-card')).not.toBeInTheDocument();
  });

  it('asks normally in the installed app', async () => {
    stub({ ua: IPHONE, standalone: true });
    await mount();
    expect(screen.getByTestId('push-prompt')).toBeInTheDocument();
  });
});

describe('the buttons', () => {
  const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

  it('Turn on asks for permission first, subscribes and posts the keys', async () => {
    const { requestPermission, reg, order } = stub({}) as ReturnType<typeof stub> & {
      reg: { pushManager: { subscribe: ReturnType<typeof vi.fn> } };
    };
    await mount();
    await user().click(screen.getByTestId('push-prompt-on'));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['permission', 'subscribe']);
    expect(posts).toEqual([
      {
        url: '/api/push/subscriptions',
        body: { endpoint: 'https://push.example.com/new', keys: { p256dh: 'P', auth: 'A' } },
      },
    ]);
    await waitFor(() => expect(screen.queryByTestId('push-prompt')).not.toBeInTheDocument());
  });

  it('Turn on does not ask for permission before the click', async () => {
    const { requestPermission } = stub({});
    await mount();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('a refusal hides the prompt and remembers it', async () => {
    const { requestPermission } = stub({});
    requestPermission.mockImplementation(async () => {
      (Notification as any).permission = 'denied';
      return 'denied';
    });
    await mount();
    await user().click(screen.getByTestId('push-prompt-on'));
    await waitFor(() => expect(screen.queryByTestId('push-prompt')).not.toBeInTheDocument());
    expect(posts).toEqual([]);
    expect(localStorage.getItem('guildwise-push-prompt')).toContain('until');
  });

  it('Not now remembers for 7 days', async () => {
    stub({});
    await mount();
    const t0 = Date.now();
    await user().click(screen.getByTestId('push-prompt-later'));
    expect(screen.queryByTestId('push-prompt')).not.toBeInTheDocument();
    const { until } = JSON.parse(localStorage.getItem('guildwise-push-prompt') ?? '{}');
    expect(until - t0).toBeGreaterThanOrEqual(SNOOZE_MS - 1000);
    expect(until - t0).toBeLessThanOrEqual(SNOOZE_MS + 5000);
  });

  it("Don't ask again is permanent", async () => {
    stub({});
    await mount();
    await user().click(screen.getByTestId('push-prompt-never'));
    expect(JSON.parse(localStorage.getItem('guildwise-push-prompt') ?? '{}')).toEqual({ never: true });
  });
});
