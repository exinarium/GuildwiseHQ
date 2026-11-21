import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, patch } from '../api/client.ts';
import { StepUpHost } from '../components/auth/StepUpDialog.tsx';
import { PlatformSecurity } from '../pages/platform/PlatformSecurity.tsx';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const stepUpRequired = (method: 'totp' | 'password') =>
  json({ error: { code: 'step_up_required', message: "confirm it's you", details: { method } } }, 403);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StepUpDialog and the API client retry (R5)', () => {
  it('asks for a code, posts it, and retries the guarded request once', async () => {
    const calls: Array<[string, string, unknown]> = [];
    let guarded = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push([init.method ?? 'GET', url, init.body ? JSON.parse(String(init.body)) : undefined]);
        if (url === '/api/auth/step-up') return json({ ok: true, freshUntil: '2026-11-21T00:10:00.000Z' });
        guarded += 1;
        return guarded === 1 ? stepUpRequired('totp') : json({ saved: true });
      }),
    );
    render(<StepUpHost />);
    const result = patch<{ saved: boolean }>('/platform/security-settings', { enforceTwoFactor: true });
    const input = await screen.findByLabelText('Code');
    expect(screen.getByText("Confirm it's you")).toBeTruthy();
    await userEvent.type(input, '123456');
    await userEvent.click(screen.getByTestId('step-up-submit'));
    await expect(result).resolves.toEqual({ saved: true });
    expect(calls.map(([m, u, b]) => [m, u, b])).toEqual([
      ['PATCH', '/api/platform/security-settings', { enforceTwoFactor: true }],
      ['POST', '/api/auth/step-up', { code: '123456' }],
      ['PATCH', '/api/platform/security-settings', { enforceTwoFactor: true }],
    ]);
    await waitFor(() => expect(screen.queryByLabelText('Code')).toBeNull());
  });

  it('asks accounts without two-factor login for the password, and shows a wrong answer', async () => {
    let stepUps = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (url === '/api/auth/step-up') {
          stepUps += 1;
          const body = JSON.parse(String(init.body));
          expect(body).toHaveProperty('password');
          return stepUps === 1
            ? json({ error: { code: 'wrong_password', message: 'no', details: { attemptsLeft: 4 } } }, 400)
            : json({ ok: true, freshUntil: '2026-11-21T00:10:00.000Z' });
        }
        return stepUps < 2 ? stepUpRequired('password') : json({ ok: true });
      }),
    );
    render(<StepUpHost />);
    const result = patch('/org/members/x/send-password-reset', {});
    const input = await screen.findByLabelText('Password');
    await userEvent.type(input, 'wrong');
    await userEvent.click(screen.getByTestId('step-up-submit'));
    expect(await screen.findByText(/That password is not right\. 4 tries left\./)).toBeTruthy();
    await userEvent.clear(input);
    await userEvent.type(input, 'right');
    await userEvent.click(screen.getByTestId('step-up-submit'));
    await expect(result).resolves.toEqual({ ok: true });
  });

  it('cancel gives the caller the original 403, and no retry happens', async () => {
    const fetchMock = vi.fn(async () => stepUpRequired('totp'));
    vi.stubGlobal('fetch', fetchMock);
    render(<StepUpHost />);
    // the rejection is caught right away (it settles while the test still clicks)
    const result = patch('/platform/security-settings', { enforceTwoFactor: true }).catch((e: unknown) => e);
    await screen.findByLabelText('Code');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await result).toMatchObject({ status: 403, code: 'step_up_required' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('without a mounted dialog the 403 reaches the caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => stepUpRequired('totp')),
    );
    await expect(patch('/platform/security-settings', {})).rejects.toBeInstanceOf(ApiError);
  });
});

describe('PlatformSecurity', () => {
  it('has the four tabs', async () => {
    // The sign-in tabs load their lists (W1); the Security settings tab loads the settings (signed-runners.test.tsx covers it).
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('security-settings')
          ? json({ error: { code: 'not_found', message: 'not found' } }, 404)
          : json({ items: [], locks: [] }),
      ),
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <PlatformSecurity />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Failed sign-ins', 'Sign-ins', 'Block list', 'Security settings']);
    await userEvent.click(screen.getByTestId('security-tab-settings'));
    expect(screen.getByRole('tab', { name: 'Security settings' }).getAttribute('aria-selected')).toBe('true');
  });
});
