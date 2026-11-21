import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformSecurity } from '../pages/platform/PlatformSecurity.tsx';
import { describeUaFamily } from '../pages/platform/security/SignInPanels.tsx';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const FAILED = {
  items: [
    {
      id: '2',
      at: '2026-11-21T08:00:00.000Z',
      email: 'ada@example.com',
      userId: 'u1',
      displayName: 'Ada',
      ip: '203.0.113.7',
      uaFamily: 'firefox/windows',
      reason: 'locked',
    },
    {
      id: '1',
      at: '2026-11-21T07:59:00.000Z',
      email: 'ghost@example.com',
      userId: null,
      displayName: null,
      ip: '203.0.113.7',
      uaFamily: null,
      reason: 'password',
    },
  ],
  locks: [{ scope: 'account', key: 'ada@example.com', until: '2026-11-21T08:15:00.000Z', failures: 5 }],
};
const SIGNINS = {
  items: [
    {
      seq: '9',
      at: '2026-11-21T09:00:00.000Z',
      userId: 'u1',
      email: 'ada@example.com',
      displayName: 'Ada',
      kind: 'user',
      method: 'password_totp',
      ip: '198.51.100.4',
      uaFamily: 'chrome/linux',
      newDevice: true,
    },
  ],
};

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PlatformSecurity />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Platform > Security: Failed sign-ins and Sign-ins tabs (R2, R4)', () => {
  it('lists failed sign-ins with the locks in force, then the sign-ins with new devices marked; filters by address', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        if (String(url).includes('/failed-sign-ins')) return json(FAILED);
        if (String(url).includes('/sign-ins')) return json(SIGNINS);
        return json({});
      }),
    );
    const user = userEvent.setup();
    wrap();
    const failed = await screen.findByTestId('failed-sign-ins');
    expect(await within(failed).findByText(/Refused: locked · ada@example.com/)).toBeInTheDocument();
    expect(within(failed).getByText(/Wrong password · ghost@example.com \(no account\)/)).toBeInTheDocument();
    expect(within(failed).getByText(/Firefox on Windows/)).toBeInTheDocument();
    const locks = within(failed).getByTestId('security-locks');
    expect(within(locks).getByText('ada@example.com')).toBeInTheDocument();
    expect(within(locks).getByText(/5 failures/)).toBeInTheDocument();

    await user.type(within(failed).getByLabelText('Filter by address or IP'), 'ada');
    expect(urls.some((u) => u.endsWith('/api/platform/security/failed-sign-ins?q=ada'))).toBe(true);

    await user.click(screen.getByTestId('security-tab-signins'));
    const list = await screen.findByTestId('sign-ins');
    expect(await within(list).findByText('New device')).toBeInTheDocument();
    expect(within(list).getByText(/Password and code · 198.51.100.4 · Chrome on Linux/)).toBeInTheDocument();
  });

  it('describes a browser family in words', () => {
    expect(describeUaFamily('safari/ios')).toBe('Safari on iOS');
    expect(describeUaFamily(null)).toBe('unknown browser');
    expect(describeUaFamily('other/other')).toBe('unknown browser on unknown system');
  });
});
