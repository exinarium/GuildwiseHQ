import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevopsSwitchBlock } from '../pages/Desk.tsx';

// UAT 1.10.0 finding 3: a DevOps request waiting for a workstation switch shows the way to the switch and, for Install,
// the copy-paste command for the computer itself.
const CMD = '/home/guildwise-runner/.local/bin/guildwise-runner devops install on';
const WS = '0192f3a0-0000-7000-8000-000000000007';
const REQ = '0192f3a0-0000-7000-8000-000000000009';

function show(data: Record<string, unknown>) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <DevopsSwitchBlock data={data} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Desk: a DevOps request waiting for a switch', () => {
  it('links to the switch of that workstation and shows the local command once', () => {
    show({
      devopsSwitch: 'allowInstall',
      switchLabel: 'Install packages and tools',
      workstationName: 'Studio',
      workstationId: WS,
      command: CMD,
    });
    const link = screen.getByTestId('desk-devops-switch-link');
    expect(link.textContent).toBe('Turn on “Install packages and tools” for Studio');
    expect(link.getAttribute('href')).toBe(`/workstations?open=${WS}`);
    expect(screen.getByTestId('desk-devops-switch-command-text').textContent).toBe(CMD);
  });

  it('a command outside the grammar is not shown; Docker has only the link', () => {
    show({
      devopsSwitch: 'allowDocker',
      switchLabel: 'Docker',
      workstationName: 'Studio',
      command: `${CMD}; rm -rf ~`,
    });
    expect(screen.queryByTestId('desk-devops-switch-command')).toBeNull();
    expect(screen.getByTestId('desk-devops-switch-link').textContent).toBe('Turn on “Docker” for Studio');
  });
});

describe('runner-authority-fixes T10: Allow once or Always allow', () => {
  it('shows the exact command and sends the chosen scope', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    show({
      devopsSwitch: 'allowInstall',
      switchLabel: 'Install packages and tools',
      workstationName: 'Studio',
      requestId: REQ,
      exactCommand: 'pipx install yt-dlp',
      allowOnce: true,
      allowAlways: true,
    });
    expect(screen.getByTestId('desk-devops-allow-command').textContent).toBe('pipx install yt-dlp');
    await userEvent.click(screen.getByTestId('desk-devops-allow-always'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.url).toContain(`/devops/requests/${REQ}/resolve`);
    expect(calls[0]?.body).toEqual({ resolution: 'approved', scope: 'always' });
    await userEvent.click(screen.getByTestId('desk-devops-allow-once'));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.body).toEqual({ resolution: 'approved', scope: 'once' });
  });

  it('a path that may not be allowed for good offers Allow once only', () => {
    show({
      devopsSwitch: 'allowedPaths',
      switchLabel: 'Writable paths outside the agent sandbox',
      workstationName: 'Studio',
      requestId: REQ,
      exactCommand: 'echo x > ~/.ssh/config',
      allowOnce: true,
      allowAlways: false,
    });
    expect(screen.getByTestId('desk-devops-allow-once')).toBeTruthy();
    expect(screen.queryByTestId('desk-devops-allow-always')).toBeNull();
  });
});

describe('gate-fixes-1 F3: Docker of a boxed request opens only by the switch', () => {
  it('no Allow once; the one button reads "Turn on Docker" and sends scope always', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    show({
      devopsSwitch: 'allowDocker',
      switchLabel: 'Docker',
      workstationName: 'Studio',
      requestId: REQ,
      exactCommand: 'docker run --rm alpine true',
      allowOnce: false,
      allowAlways: true,
    });
    expect(screen.queryByTestId('desk-devops-allow-once')).toBeNull();
    const button = screen.getByTestId('desk-devops-allow-always');
    expect(button.textContent).toBe('Turn on Docker');
    await userEvent.click(button);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ resolution: 'approved', scope: 'always' });
  });
});
