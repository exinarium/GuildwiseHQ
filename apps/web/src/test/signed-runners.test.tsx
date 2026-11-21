import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReinstallRequired, SignedRunnersInstallNote } from '../components/workstations/SignedRunners.tsx';
import { PlatformSecurity } from '../pages/platform/PlatformSecurity.tsx';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const state = (value: boolean, locked = false) => ({
  value,
  locked,
  source: locked ? 'locked' : value ? 'platform' : 'default',
});

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Platform > Security > Security settings (R27, R28)', () => {
  it('shows both settings off with the counts, and asks before signed runners unpair workstations', async () => {
    const calls: Array<[string, unknown]> = [];
    let view = {
      requireSignedRunners: state(false),
      enforceTwoFactor: state(false),
      unsignedWorkstations: 2,
      usersWithout2fa: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (url !== '/api/platform/security-settings')
          return json({ error: { code: 'not_found', message: url } }, 404);
        if (init.method === 'PATCH') {
          const body = JSON.parse(String(init.body));
          calls.push(['PATCH', body]);
          view = { ...view, requireSignedRunners: state(true), unsignedWorkstations: 0 };
        }
        return json(view);
      }),
    );
    wrap(<PlatformSecurity initialTab="settings" />);
    expect((await screen.findByTestId('setting-requireSignedRunners-count')).textContent).toBe(
      '2 workstations run an unsigned or outdated runner.',
    );
    expect(screen.getByTestId('setting-enforceTwoFactor-count').textContent).toBe(
      '1 account has no two-factor login yet.',
    );
    const toggle = screen.getByTestId('setting-requireSignedRunners-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);

    await userEvent.click(toggle);
    expect(await screen.findByText('Unpair unsigned workstations?')).toBeTruthy();
    expect(calls).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Turn on and unpair' }));
    await waitFor(() =>
      expect(calls).toEqual([['PATCH', { requireSignedRunners: true, confirmUnlink: true }]]),
    );
    await waitFor(() =>
      expect((screen.getByTestId('setting-requireSignedRunners-toggle') as HTMLInputElement).checked).toBe(
        true,
      ),
    );
  });

  it('shows the locked state: switches disabled with "Set by Guildwise Cloud"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          requireSignedRunners: state(true, true),
          enforceTwoFactor: state(true, true),
          unsignedWorkstations: 0,
          usersWithout2fa: 0,
        }),
      ),
    );
    wrap(<PlatformSecurity initialTab="settings" />);
    for (const key of ['requireSignedRunners', 'enforceTwoFactor']) {
      const t = (await screen.findByTestId(`setting-${key}-toggle`)) as HTMLInputElement;
      expect(t.checked).toBe(true);
      expect(t.disabled).toBe(true);
      expect(screen.getByTestId(`setting-${key}-locked`).textContent).toContain(
        'Set by Guildwise Cloud; cannot be changed here.',
      );
    }
  });
});

describe('Reinstall required (R21)', () => {
  it('lists the unpaired workstations and opens the installer; the install note shows while the setting is on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          requireSignedRunners: true,
          minRunner: '1.10.0',
          since: 'Guildwise 1.10.0',
          reinstallRequired: [
            {
              id: '0192f3a0-0000-7000-8000-000000000001',
              name: 'Laptop',
              hostname: 'laptop',
              unlinkedAt: '2026-11-21T08:00:00.000Z',
            },
          ],
        }),
      ),
    );
    const onReinstall = vi.fn();
    wrap(
      <>
        <ReinstallRequired onReinstall={onReinstall} />
        <SignedRunnersInstallNote />
      </>,
    );
    expect((await screen.findByTestId('reinstall-required')).textContent).toContain('Reinstall required');
    expect(
      screen.getAllByTestId('reinstall-required-item').map((li) => li.textContent?.split(',')[0]),
    ).toEqual(['Laptop (laptop)']);
    await userEvent.click(screen.getByTestId('reinstall-runner'));
    expect(onReinstall).toHaveBeenCalledOnce();
    expect(screen.getByTestId('signed-runners-install-note').textContent).toContain(
      'Runners from before Guildwise 1.10.0 are refused here.',
    );
  });

  it('shows nothing with the setting off and nothing to reinstall', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          requireSignedRunners: false,
          minRunner: '1.10.0',
          since: 'Guildwise 1.10.0',
          reinstallRequired: [],
        }),
      ),
    );
    const { container } = wrap(
      <>
        <ReinstallRequired onReinstall={() => {}} />
        <SignedRunnersInstallNote />
      </>,
    );
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
