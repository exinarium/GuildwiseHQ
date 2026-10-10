import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantPanel } from '../components/platform/AssistantPanel.tsx';

const json = (b: unknown) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
let state: Record<string, unknown>;
const puts: unknown[] = [];

beforeEach(() => {
  puts.length = 0;
  state = {
    enabled: true,
    mode: 'public',
    keyConfigured: true,
    model: 'claude-haiku-4-5',
    dailyCapUsd: 10,
    spentTodayUsd: 1.234,
    messagesToday: 42,
    live: true,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit = {}) => {
      if (init.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        state = { ...state, enabled: body.enabled, live: body.enabled };
      }
      return json(state);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AssistantPanel />
    </QueryClientProvider>,
  );

describe('the landing-page assistant panel (super admin)', () => {
  it('shows today and switches the assistant off and on', async () => {
    mount();
    expect(await screen.findByText('Answering visitors')).toBeInTheDocument();
    expect(screen.getByText(/42/)).toBeInTheDocument();
    expect(screen.getByText('$1.23')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('assistant-toggle'));
    await waitFor(() => expect(screen.getByText('Not answering')).toBeInTheDocument());
    expect(puts).toEqual([{ enabled: false }]);
    await userEvent.click(screen.getByTestId('assistant-toggle'));
    await waitFor(() => expect(screen.getByText('Answering visitors')).toBeInTheDocument());
  });

  it('says why it is off when the server has no key', async () => {
    state = { ...state, mode: 'off', keyConfigured: false, live: false };
    mount();
    expect(await screen.findByText(/No Anthropic API key is set/)).toBeInTheDocument();
  });
});
