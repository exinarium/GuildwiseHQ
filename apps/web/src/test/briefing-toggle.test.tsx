import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BriefingToggle } from '../components/BriefingToggle.tsx';
import { ToastProvider } from '../components/ui.tsx';

afterEach(() => vi.unstubAllGlobals());

describe('Monday briefing switch', () => {
  it("is on by default and saves the person's choice", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    let enabled = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, url: String(url), body });
        if (method === 'PUT') enabled = (body as { enabled: boolean }).enabled;
        return new Response(JSON.stringify({ enabled }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <BriefingToggle />
        </ToastProvider>
      </QueryClientProvider>,
    );
    const box = await screen.findByTestId('weekly-briefing');
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).toBeChecked();
    await userEvent.click(box);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: '/api/me/weekly-briefing',
      body: { enabled: false },
    });
    await waitFor(() => expect(screen.getByTestId('weekly-briefing')).not.toBeChecked());
  });
});
